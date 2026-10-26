import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { FILE_HEADER, isFileSuccess } from '../src/file-protocol.js';
import { FileStore } from '../src/file-store.js';
import { closeServer, connect, fixture, listen, nextReceipt, receiptPath, send, success } from './helpers.js';

const timeout = { timeout: 10000 };
const binaryHeaders = { 'Content-Type': 'application/octet-stream' };

/**
 * 校验正式二进制入口的无分组回执和原始字节, 不读取测试之外的文件.
 * @param {string} directory 本测试创建的临时根目录.
 * @param {unknown} receipt 实际收到的 HTTP 或 WS 回执.
 * @param {Buffer} bytes 本测试发送的完整原始字节.
 * @param {string} name 应由服务端选择的默认或编号文件名.
 */
async function savedBinary(directory: string, receipt: unknown, bytes: Buffer, name: string): Promise<void> {
    assert.ok(isFileSuccess(receipt), JSON.stringify(receipt));
    assert.equal(receipt.group, '');
    assert.equal(receipt.groupDirectory, '');
    assert.equal(receipt.originalName, 'default.bin');
    assert.equal(receipt.file, name);
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(receiptPath(directory, receipt)), bytes);
}

test('direct HTTP binary preserves bytes including JSON and empty bodies without metadata or text processing', timeout, async (t) => {
    let processed = 0;
    const { url, directory } = await fixture(t, {
        processContent: (text) => {
            processed++;
            return text;
        },
    });
    const bodies = [Buffer.from([0, 255, 128, 13, 10]), Buffer.from('{"group":"not-a-group","content":"not-text"}'), Buffer.alloc(0)];
    for (const [index, bytes] of bodies.entries()) {
        const response = await fetch(url.replace('ws:', 'http:'), { method: 'POST', headers: binaryHeaders, body: bytes });
        assert.equal(response.status, 200);
        await savedBinary(directory, await response.json(), bytes, index ? `default(${index}).bin` : 'default.bin');
    }
    assert.equal(processed, 0);
    const text = success(await (await fetch(url.replace('ws:', 'http:'), { method: 'POST', body: '  direct text\n' })).json());
    assert.equal(text.file, 'default.txt');
    assert.equal(text.groupDirectory, '');
    assert.equal(await readFile(receiptPath(directory, text), 'utf8'), '  direct text\n');
    assert.equal(processed, 1);
});

test('direct HTTP streams unknown-length binary beyond text and read-buffer budgets', timeout, async (t) => {
    const { url, directory } = await fixture(t, { maxPayloadBytes: 8, maxPendingBytes: 8 });
    const chunk = Buffer.alloc(65536, 0xAA);
    const count = 8;
    const body = Readable.from((function* () {
        for (let index = 0; index < count; index++) yield chunk;
    })());
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: binaryHeaders, body: body as unknown as BodyInit, duplex: 'half' };
    const response = await fetch(url.replace('ws:', 'http:'), init);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.ok(isFileSuccess(receipt));
    assert.equal(receipt.bytes, chunk.length * count);
    assert.equal((await stat(receiptPath(directory, receipt))).size, receipt.bytes);
    await savedBinary(directory, receipt, Buffer.alloc(chunk.length * count, 0xAA), 'default.bin');
});

test('direct HTTP binary keeps authorization, encoding and explicit metadata failures strict', timeout, async (t) => {
    const { url, directory, receiver } = await fixture(t, { token: 'direct-test', maxFileBytes: 2 });
    const endpoint = url.replace('ws:', 'http:');
    const authenticated = { ...binaryHeaders, Authorization: 'Bearer direct-test' };
    for (const [headers, status, code] of [
        [binaryHeaders, 401, 'UNAUTHORIZED'],
        [{ ...authenticated, Origin: 'http://foreign.example' }, 403, 'FORBIDDEN'],
        [{ ...authenticated, 'Content-Encoding': 'gzip' }, 415, 'INVALID_MESSAGE'],
        [{ ...authenticated, [FILE_HEADER]: '%ZZ' }, 400, 'INVALID_MESSAGE'],
        [authenticated, 413, 'MESSAGE_TOO_LARGE'],
    ] as const) {
        const response = await fetch(endpoint, { method: 'POST', headers, body: Buffer.from([0xFF, 0, 1]) });
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.code, code);
    }
    for (const body of [Buffer.from([0xFF]), '{"name":"missing-content"}']) {
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer direct-test' }, body });
        assert.equal(response.status, 400, 'text decoding/schema errors must not become binary uploads');
    }
    await receiver.stop();
    assert.deepEqual(await readdir(directory), []);
});

test('unknown-length binary enforces the file limit and releases the upload slot after overflow', timeout, async (t) => {
    const { url, directory } = await fixture(t, { maxFileBytes: 8, maxFileTransfers: 1 });
    const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: binaryHeaders,
        duplex: 'half',
        body: Readable.from([Buffer.alloc(5), Buffer.alloc(4)]) as unknown as BodyInit,
    };
    const response = await fetch(url.replace('ws:', 'http:'), init);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'MESSAGE_TOO_LARGE');
    const next = await fetch(url.replace('ws:', 'http:'), { method: 'POST', headers: binaryHeaders, body: Buffer.from([7]) });
    assert.equal(next.status, 200);
    const receipt = await next.json();
    await savedBinary(directory, receipt, Buffer.from([7]), 'default.bin');
    assert.deepEqual((await readdir(join(directory, receipt.date))).sort(), ['.message-transfer-files', 'default.bin']);
});

test('direct HTTP binary abort, timeout and stop discard unfinished unknown-length files', timeout, async (t) => {
    for (const mode of ['abort', 'timeout', 'stop']) {
        const { url, directory, receiver } = await fixture(t, { fileTransferTimeoutMs: mode === 'timeout' ? 150 : 5000 });
        const request = httpRequest(url.replace('ws:', 'http:'), { method: 'POST', headers: binaryHeaders });
        request.on('error', () => {});
        t.after(() => request.destroy());
        const response = mode === 'abort' ? undefined : once(request, 'response');
        request.write(Buffer.from([0xFF]));
        for (let attempt = 0; attempt < 200 && !(await readdir(directory)).length; attempt++) await delay(5);
        const [date] = await readdir(directory);
        assert.match(date ?? '', /^\d{8}$/);
        if (mode === 'abort') request.destroy();
        if (mode === 'stop') await receiver.stop();
        if (response) {
            const [reply] = await response;
            assert.equal(reply.statusCode, mode === 'stop' ? 503 : 408);
            reply.resume();
        }
        const daily = join(directory, date!);
        for (let attempt = 0; attempt < 200 && (await readdir(daily)).length; attempt++) await delay(5);
        assert.deepEqual(await readdir(daily), []);
    }
});

test('direct WS accepts text and binary messages, numbering binary files without parsing their contents', timeout, async (t) => {
    let processed = 0;
    const { connect, directory } = await fixture(t, {
        token: 'direct-test',
        processContent: (text) => {
            processed++;
            return text;
        },
    });
    const socket = await connect('?token=direct-test');
    const textResult = nextReceipt(socket);
    socket.send('  direct text\n');
    const text = success(await textResult);
    assert.equal(text.file, 'default.txt');
    assert.equal(text.groupDirectory, '');
    for (const [index, bytes] of [Buffer.from([0xFF, 0, 13, 10]), Buffer.from('{"group":"not-a-group","content":"not-text"}'), Buffer.alloc(0)].entries()) {
        const result = nextReceipt(socket);
        socket.send(bytes);
        await savedBinary(directory, await result, bytes, index ? `default(${index}).bin` : 'default.bin');
    }
    assert.equal(processed, 1);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await send(socket, { content: 'tail' });
    assert.equal(await readFile(receiptPath(directory, text), 'utf8'), '  direct text\ntail\n');
});

test('fragmented direct WS binary is one message and one file', timeout, async (t) => {
    const { connect, directory } = await fixture(t);
    const socket = await connect();
    const result = nextReceipt(socket);
    socket.send(Buffer.from([0, 255]), { binary: true, fin: false });
    socket.send(Buffer.from([1, 128]), { binary: true, fin: true });
    await savedBinary(directory, await result, Buffer.from([0, 255, 1, 128]), 'default.bin');
});

test('direct WS binary respects both file and transport limits without damaging later messages', timeout, async (t) => {
    const { connect, directory } = await fixture(t, { maxPayloadBytes: 8, maxFileBytes: 2 });
    const socket = await connect();
    let result = nextReceipt(socket);
    socket.send(Buffer.alloc(3));
    const rejected = await result;
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'MESSAGE_TOO_LARGE');
    assert.equal(socket.readyState, WebSocket.OPEN);
    result = nextReceipt(socket);
    socket.send(Buffer.from([255, 0]));
    await savedBinary(directory, await result, Buffer.from([255, 0]), 'default.bin');
    const closed = once(socket, 'close');
    socket.send(Buffer.alloc(9));
    assert.equal((await closed)[0], 1009);
});

test('direct WS binary shares text queue admission and cannot bypass a full pending budget', timeout, async (t) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    t.after(() => release());
    const { connect, directory } = await fixture(t, {
        maxPendingMessages: 1,
        processContent: async (text) => {
            enter();
            await gate;
            return text;
        },
    });
    const textSocket = await connect();
    const binarySocket = await connect();
    const text = send(textSocket, { content: 'hold' });
    await entered;
    const closed = once(binarySocket, 'close');
    binarySocket.send(Buffer.from([255]));
    assert.equal((await closed)[0], 1013);
    release();
    const receipt = success(await text);
    assert.ok(!(await readdir(join(directory, receipt.date))).includes('default.bin'));
});

test('stop waits for an accepted complete WS binary message instead of cancelling its disk writes', timeout, async (t) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const append = FileStore.prototype.append;
    t.mock.method(FileStore.prototype, 'append', async function (this: FileStore, ...args: Parameters<FileStore['append']>) {
        enter();
        await gate;
        return append.apply(this, args);
    });
    t.after(() => release());
    const { connect, directory, receiver } = await fixture(t);
    const socket = await connect();
    const result = nextReceipt(socket);
    const bytes = Buffer.alloc(65537, 0xAF);
    socket.send(bytes);
    await Promise.race([entered, result.then((receipt) => {
        assert.fail(`Binary reception did not reach storage: ${JSON.stringify(receipt)}`);
    })]);
    let stopped = false;
    const stopping = receiver.stop().then(() => {
        stopped = true;
    });
    await delay(10);
    assert.equal(stopped, false);
    release();
    await stopping;
    const [date] = await readdir(directory);
    assert.deepEqual((await readdir(join(directory, date!))).sort(), ['.message-transfer-files', 'default.bin']);
    assert.deepEqual(await readFile(join(directory, date!, 'default.bin')), bytes);
});

test('shared business binary remains owned by the host and never becomes an ungrouped file', timeout, async (t) => {
    const { receiver, directory } = await fixture(t);
    const host = createServer();
    const wss = new WebSocketServer({ server: host });
    wss.on('connection', (socket, request) => {
        receiver.attachSharedSocket(socket, request);
        socket.on('message', (_data, binary) => {
            if (binary) socket.send('business-ack');
        });
    });
    t.after(async () => {
        for (const peer of wss.clients) peer.terminate();
        wss.close();
        await closeServer(host);
    });
    const port = await listen(host);
    const client = await connect(`ws://127.0.0.1:${port}/business`);
    t.after(() => client.terminate());
    const next = once(client, 'message');
    client.send(Buffer.from([255, 0]));
    assert.equal(String((await next)[0]), 'business-ack');
    await receiver.stop();
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.deepEqual(await readdir(directory), []);
});
