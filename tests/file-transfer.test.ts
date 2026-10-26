import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveOptions } from '../src/config.js';
import { createFileHttpHandler } from '../src/file-http.js';
import { FILE_HEADER, FILE_REQUEST, fileHeader } from '../src/file-protocol.js';
import { FileStore } from '../src/file-store.js';
import type { FileMetadata } from '../src/types.js';
import { closeServer, fixture, listen, receiptPath, success, tempDirectory } from './helpers.js';

/**
 * 创建测试拥有的原文件请求, 不使用用户本地文件或真实令牌.
 * @param {FileMetadata} metadata 测试数据的名称, 分组和准确大小.
 * @param {HeadersInit} extra 覆盖请求头以验证认证和边界.
 */
function headers(metadata: FileMetadata, extra: HeadersInit = {}): Headers {
    const result = new Headers({ 'Content-Type': 'application/octet-stream', [FILE_HEADER]: fileHeader(metadata) });
    new Headers(extra).forEach((value, name) => result.set(name, value));
    return result;
}

test('HTTP file metadata preserves binary bytes while unmarked bodies retain strict text validation', async (t) => {
    const { url, directory } = await fixture(t, { token: 'file-test' });
    const endpoint = url.replace('ws:', 'http:');
    const bytes = Buffer.from([0, 255, 254, 80, 75, 10, 13]);
    const requestHeaders = headers({ name: '表格.xlsx', group: 'files', size: bytes.length }, { Authorization: 'Bearer file-test' });
    const response = await fetch(endpoint, { method: 'POST', headers: requestHeaders, body: bytes });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.kind, 'file');
    assert.equal(receipt.originalName, '表格.xlsx');
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(receiptPath(directory, receipt)), bytes);
    assert.doesNotMatch(JSON.stringify(receipt), /directory|temporary/);
    const unmarked = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer file-test' }, body: bytes });
    assert.equal(unmarked.status, 400, 'invalid UTF-8 without a binary content type must not become a file');
    const text = success(await (await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer file-test' }, body: 'still text' })).json());
    assert.equal(await readFile(receiptPath(directory, text), 'utf8'), 'still text\n');
});

test('HTTP streams a real 100 MiB file larger than the text and memory budgets', { timeout: 60000 }, async (t) => {
    const { url, directory } = await fixture(t);
    const chunk = Buffer.alloc(65536, 0xA5);
    const digest = createHash('sha256');
    const count = 1600;
    const body = Readable.from((function* () {
        for (let index = 0; index < count; index++) {
            digest.update(chunk);
            yield chunk;
        }
    })());
    const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: headers({ name: 'large.bin', size: chunk.length * count }),
        body: body as unknown as BodyInit,
        duplex: 'half',
    };
    const response = await fetch(url.replace('ws:', 'http:'), init);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.kind, 'file');
    assert.equal(receipt.bytes, 104857600);
    assert.equal((await stat(receiptPath(directory, receipt))).size, 104857600);
    const saved = createHash('sha256');
    for await (const part of createReadStream(receiptPath(directory, receipt))) saved.update(part);
    const expected = digest.digest('hex');
    assert.equal(receipt.sha256, expected);
    assert.equal(saved.digest('hex'), expected);
    assert.deepEqual(await readdir(directory), [receipt.date]);
    assert.deepEqual((await readdir(join(directory, receipt.date))).sort(), ['.message-transfer-files', receipt.file]);
});

test('HTTP file authorization, content encoding, metadata and limits fail without publishing partial files', async (t) => {
    const { url, directory, receiver } = await fixture(t, { token: 'file-test', maxFileBytes: 8 });
    const endpoint = url.replace('ws:', 'http:');
    const authenticated = { Authorization: 'Bearer file-test' };
    for (const [extra, size, body, status] of [
        [{}, 1, 'x', 401],
        [{ ...authenticated, Origin: 'http://foreign.example' }, 1, 'x', 403],
        [authenticated, 9, 'x', 413],
        [{ ...authenticated, 'Content-Encoding': 'gzip' }, 1, 'x', 415],
        [{ ...authenticated, 'Content-Type': 'text/plain' }, 1, 'x', 415],
        [authenticated, 2, 'x', 400],
        [authenticated, 1, 'xx', 400],
    ] as const) {
        const response = await fetch(endpoint, { method: 'POST', headers: headers({ name: 'one.bin', size }, extra), body });
        assert.equal(response.status, status);
        assert.equal((await response.json()).ok, false);
    }
    const bad = await fetch(endpoint, { method: 'POST', body: 'x', headers: { ...authenticated, 'Content-Type': 'application/octet-stream', [FILE_HEADER]: '%ZZ' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);
    await receiver.stop();
    assert.deepEqual(await readdir(directory), []);
});

test('file HTTP disposal lets an already committed file return its final success', async (t) => {
    const directory = await tempDirectory();
    const options = resolveOptions({ directory });
    const files = new FileStore(options);
    const finish = files.finish.bind(files);
    let committed!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
        committed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    files.finish = async (...args) => {
        const receipt = await finish(...args);
        committed();
        await gate;
        return receipt;
    };
    const handler = createFileHttpHandler({ options, files, authorize: () => undefined, report: () => {} });
    const host = createServer((request, response) => handler.handle(request, response));
    const port = await listen(host);
    t.after(async () => {
        release();
        handler.dispose();
        await files.dispose();
        await closeServer(host);
        await rm(directory, { recursive: true, force: true });
    });
    const response = fetch(`http://127.0.0.1:${port}/device-data`, { method: 'POST', headers: headers({ name: 'saved.png', size: 1 }), body: 'x' });
    await reached;
    handler.dispose();
    release();
    const result = await response;
    assert.equal(result.status, 200);
    const receipt = await result.json();
    assert.equal(receipt.kind, 'file');
    assert.equal(await readFile(receiptPath(directory, receipt), 'utf8'), 'x');
});

test('HTTP file timeout and client abort clean temporary resources without publishing incomplete files', { timeout: 10000 }, async (t) => {
    for (const abort of [true, false]) {
        const { url, directory, receiver } = await fixture(t, { fileTransferTimeoutMs: abort ? 5000 : 100 });
        const request = httpRequest(url.replace('ws:', 'http:'), { method: 'POST', headers: {
            'content-type': 'application/octet-stream',
            [FILE_HEADER]: fileHeader({ name: 'partial.png', size: 10 }),
        } });
        request.on('error', () => {});
        t.after(() => request.destroy());
        const response = abort ? undefined : once(request, 'response');
        request.write('x');
        if (abort) {
            for (let attempt = 0; attempt < 200 && !(await readdir(directory)).length; attempt++) await delay(5);
            assert.equal((await readdir(directory)).length, 1);
            request.destroy();
        }
        else {
            const [reply] = await response!;
            assert.equal(reply.statusCode, 408);
            reply.resume();
        }
        const [date] = await readdir(directory);
        assert.match(date!, /^\d{8}$/);
        const daily = join(directory, date!);
        for (let attempt = 0; attempt < 200 && (await readdir(daily)).length; attempt++) await delay(5);
        assert.deepEqual(await readdir(daily), []);
        await receiver.stop();
    }
});

test('shared file frames require independent tokens, owner binding, ordered chunks and final commit', async (t) => {
    const { receiver, directory } = await fixture(t, { token: 'file-test' });
    const owner = { headers: { host: 'local.test', origin: 'http://local.test' }, url: '/business?token=not-application' } as IncomingMessage;
    const other = { headers: owner.headers, url: owner.url } as IncomingMessage;
    let seq = 0;
    const frame = (action: string, fields: Record<string, unknown> = {}) => ({ type: FILE_REQUEST, id: 'file_test', seq: seq++, action, token: 'file-test', ...fields });
    let reply = await receiver.handleSharedMessage(frame('start', { metadata: { name: 'photo.png', size: 3 }, token: undefined }), owner);
    assert.equal(reply?.receipt.ok, false);
    if (reply && !reply.receipt.ok) assert.equal(reply.receipt.error.code, 'UNAUTHORIZED');
    reply = await receiver.handleSharedMessage(frame('start', { metadata: { name: 'photo.png', size: 3 } }), owner);
    assert.ok(reply?.receipt.ok && 'uploadId' in reply.receipt);
    const uploadId = reply.receipt.uploadId;
    const stolen = await receiver.handleSharedMessage(frame('chunk', { uploadId, offset: 0, data: 'YWJj' }), other);
    assert.equal(stolen?.receipt.ok, false);
    const written = await receiver.handleSharedMessage(frame('chunk', { uploadId, offset: 0, data: 'YWJj' }), owner);
    assert.ok(written?.receipt.ok && 'offset' in written.receipt);
    assert.equal(written.receipt.offset, 3);
    const committed = await receiver.handleSharedMessage(frame('finish', { uploadId }), owner);
    assert.ok(committed?.receipt.ok && 'kind' in committed.receipt && committed.receipt.kind === 'file');
    assert.equal(await readFile(receiptPath(directory, committed.receipt), 'utf8'), 'abc');
    assert.equal(await receiver.handleSharedMessage({ type: 'other:business', data: 'nothing' }, owner), undefined);
});

test('shared file malformed chunks, release and stop never leave incomplete files as success outputs', async (t) => {
    const { receiver, directory } = await fixture(t);
    const owner = { headers: {}, url: '/business' } as IncomingMessage;
    for (const data of ['YWJj!', '!!!!', 'YQ', '', 'a'.repeat(90000)]) {
        const ready = await receiver.handleSharedMessage({ type: FILE_REQUEST, id: 'a', seq: 0, action: 'start', metadata: { name: 'file.bin', size: 10 } }, owner);
        assert.ok(ready?.receipt.ok && 'uploadId' in ready.receipt);
        const bad = await receiver.handleSharedMessage({ type: FILE_REQUEST, id: 'a', seq: 1, action: 'chunk', uploadId: ready.receipt.uploadId, offset: 0, data }, owner);
        assert.equal(bad?.receipt.ok, false);
        await receiver.releaseSharedFiles(owner);
        const [date] = await readdir(directory);
        assert.match(date!, /^\d{8}$/);
        assert.deepEqual(await readdir(join(directory, date!)), []);
    }
    await receiver.handleSharedMessage({ type: FILE_REQUEST, id: 'a', seq: 0, action: 'start', metadata: { name: 'file.bin', size: 10 } }, owner);
    await receiver.stop();
    const [date] = await readdir(directory);
    assert.match(date!, /^\d{8}$/);
    assert.deepEqual(await readdir(join(directory, date!)), []);
});
