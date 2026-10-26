import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { installClient } from '../src/client-host.js';
import { send, sendByFetch, sendBySocket } from '../src/client.js';
import { FILE_HEADER, FILE_REPLY } from '../src/file-protocol.js';
import { closeServer, connect, fixture, listen, receiptPath } from './helpers.js';

/** 完成测试控制的延迟文件读取. @param {ArrayBuffer} value 当前分片的原始字节. */
type CompleteRead = (value: ArrayBuffer) => void;

/** 模拟已有共享连接, 用于观察 SDK 的等待, 分片及清理, 不替代真实存储集成. */
class Socket extends EventTarget {
    /** 已有连接初始处于 OPEN, SDK 不应创建或关闭它. */
    readyState = 1;
    /** 记录发出的有界 JSON 帧. */
    frames: Record<string, unknown>[] = [];
    /** 可在派发边界模拟已有宿主的错误. */
    fail = false;
    /** 发送宿主文本帧. @param {string} data SDK 生成的命名空间请求. */
    send(data: string): void {
        if (this.fail) throw new Error('owned socket failed');
        this.frames.push(JSON.parse(data));
    }

    /** 回应指定步骤, 不广播到其他宿主. @param {number} index 请求下标. @param {unknown} receipt 未验证回执. */
    reply(index: number, receipt: unknown): void {
        const frame = this.frames[index]!;
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: FILE_REPLY, id: frame.id, seq: frame.seq, receipt }) }));
    }
}

/** 等异步 Blob 片段读取和 Promise 回调完成, 不假设磁盘或网络的精确时序. */
async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test('File, Blob and grouped files work through Fetch without reading the complete file into JavaScript', async (t) => {
    const { url, directory } = await fixture(t, { token: 'file-test' });
    let posts = 0;
    const dispose = installClient({ endpoint: url.replace('ws:', 'http:'), token: () => 'file-test', request: async (input, init) => {
        posts++;
        assert.ok(init?.body instanceof Blob);
        assert.equal(new Headers(init.headers).get('Content-Type'), 'application/octet-stream');
        assert.ok(new Headers(init.headers).get(FILE_HEADER));
        assert.equal(init.redirect, 'error');
        return fetch(input, init);
    } });
    t.after(dispose);
    const file = new File([new Uint8Array([255, 0, 128, 80, 75])], '表格.xlsx');
    file.arrayBuffer = async () => {
        throw new Error('must not buffer the entire file');
    };
    const first = await send(file);
    const second = await sendByFetch({ file, group: 'files', name: 'renamed.xlsx' });
    const empty = await sendByFetch(new Blob([]));
    for (const reply of [first, second, empty]) assert.ok(reply.ok && 'kind' in reply && reply.kind === 'file');
    assert.ok(first.ok && second.ok && empty.ok);
    assert.equal(first.file, '表格.xlsx');
    assert.equal(empty.file, 'default.bin');
    assert.deepEqual(await readFile(receiptPath(directory, first)), Buffer.from([255, 0, 128, 80, 75]));
    assert.notEqual(first.file, second.file);
    assert.equal(second.group, 'files');
    assert.equal(second.file, 'renamed.xlsx');
    assert.equal(second.groupDirectory, 'files');
    assert.equal(empty.bytes, 0);
    assert.equal(posts, 3);
});

test('ungrouped Fetch uploads reuse identical long names and number different contents', async (t) => {
    const { url, directory } = await fixture(t);
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    const name = `${'a'.repeat(251)}.png`;
    const file = new File(['original'], name);
    const first = await sendByFetch(file);
    const second = await sendByFetch({ file, group: '' });
    const renamed = await sendByFetch({ file, name: '自定义名称.png' });
    assert.ok(first.ok && second.ok && renamed.ok);
    assert.equal(first.file, name);
    assert.equal(second.file, first.file);
    const different = await sendByFetch(new File(['different'], name));
    assert.ok(different.ok);
    assert.equal(different.file, `${'a'.repeat(248)}(1).png`);
    assert.equal(await readFile(receiptPath(directory, different), 'utf8'), 'different');
    assert.equal(renamed.file, '自定义名称.png');
    for (const receipt of [first, second, renamed]) {
        assert.equal(await readFile(receiptPath(directory, receipt), 'utf8'), 'original');
    }
});

test('a real shared business connection transfers 100 MiB in bounded acknowledged chunks and stays owned by the host', { timeout: 60000 }, async (t) => {
    const { receiver, directory } = await fixture(t, { token: 'file-test' });
    const host = createServer();
    const sockets = new WebSocketServer({ server: host, maxPayload: 98304, perMessageDeflate: false });
    let largest = 0;
    let frames = 0;
    sockets.on('connection', (socket, request) => {
        receiver.attachSharedSocket(socket, request);
        socket.on('message', (raw) => {
            largest = Math.max(largest, raw.toString().length);
            frames++;
            if (raw.toString() === 'ping') socket.send('pong');
        });
    });
    const port = await listen(host);
    const socket = await connect(`ws://127.0.0.1:${port}/business`);
    let requests = 0;
    const dispose = installClient({ socket, token: 'file-test', request: async () => {
        requests++;
        throw new Error('must not use HTTP');
    } });
    t.after(async () => {
        dispose();
        socket.terminate();
        for (const peer of sockets.clients) peer.terminate();
        sockets.close();
        await closeServer(host);
    });
    const chunk = new Blob([new Uint8Array(65536).fill(0xA5)]);
    const file = new File(Array.from<Blob>({ length: 1600 }).fill(chunk), 'hundred.bin');
    file.arrayBuffer = async () => {
        throw new Error('must slice the file');
    };
    const result = await sendBySocket({ file, group: 'large' });
    assert.ok(result.ok && 'kind' in result && result.kind === 'file');
    assert.equal(result.bytes, 104857600);
    const digest = createHash('sha256');
    for await (const part of createReadStream(receiptPath(directory, result))) digest.update(part);
    assert.equal(result.sha256, digest.digest('hex'));
    assert.equal(frames, 1602);
    assert.ok(largest <= 98304);
    assert.equal(requests, 0);
    assert.equal(sockets.clients.size, 1);
    dispose();
    assert.equal(socket.readyState, 1);
    const next = once(socket, 'message');
    socket.send('ping');
    assert.equal(String((await next)[0]), 'pong');
    assert.deepEqual(await readdir(directory), [result.date]);
    assert.deepEqual((await readdir(join(directory, result.date, result.groupDirectory))).sort(), ['.message-transfer-files', result.file]);
});

test('file sends pin the selected shared channel, require each ACK and ignore stale steps', async (t) => {
    const socket = new Socket();
    const dispose = installClient({ socket, timeoutMs: 1000 });
    t.after(dispose);
    const pending = send(new File([new Uint8Array(65537)], 'photo.png'));
    assert.equal(socket.frames.length, 1);
    const other = new Socket();
    const disposeOther = installClient({ socket: other });
    t.after(disposeOther);
    socket.reply(0, { ok: true, code: 0, step: 'ready', uploadId: 'owned', offset: 0, chunkBytes: 65536 });
    await flush();
    assert.equal(socket.frames.length, 2);
    assert.equal(other.frames.length, 0);
    assert.equal(socket.frames[1]!.offset, 0);
    assert.equal(Buffer.from(String(socket.frames[1]!.data), 'base64').length, 65536);
    socket.reply(0, { ok: true, code: 0, step: 'ready', uploadId: 'owned', offset: 0, chunkBytes: 65536 });
    await flush();
    assert.equal(socket.frames.length, 2);
    socket.reply(1, { ok: true, code: 0, step: 'chunk', uploadId: 'owned', offset: 65536 });
    await flush();
    assert.equal(socket.frames[2]!.offset, 65536);
    socket.reply(2, { ok: true, code: 0, step: 'chunk', uploadId: 'owned', offset: 65537 });
    await flush();
    assert.equal(socket.frames[3]!.action, 'finish');
    socket.reply(3, { ok: true, code: 0, date: '20261024', groupDirectory: '', kind: 'file', originalName: 'photo.png', group: '', file: 'safe.png', bytes: 65537, sha256: 'a'.repeat(64) });
    assert.equal((await pending).ok, true);
    assert.equal(other.frames.length, 0);
});

for (const reason of ['close', 'error', 'dispose', 'timeout', 'send failure'] as const) {
    test(`shared file ${reason} rejects without HTTP fallback, closing the host or continuing data`, async (t) => {
        const socket = new Socket();
        let requests = 0;
        const dispose = installClient({ socket, timeoutMs: reason === 'timeout' ? 20 : 1000, request: async () => {
            requests++;
            throw new Error('unexpected HTTP');
        } });
        t.after(dispose);
        const pending = sendBySocket(new File([new Uint8Array(65537)], 'photo.png'));
        const rejected = assert.rejects(pending);
        socket.reply(0, { ok: true, code: 0, step: 'ready', uploadId: 'owned', offset: 0, chunkBytes: 65536 });
        await flush();
        if (reason === 'dispose') {
            dispose();
        }
        else if (reason === 'send failure') {
            socket.fail = true;
            socket.reply(1, { ok: true, code: 0, step: 'chunk', uploadId: 'owned', offset: 65536 });
        }
        else if (reason !== 'timeout') {
            socket.dispatchEvent(new Event(reason));
        }
        await rejected;
        await flush();
        assert.equal(requests, 0);
        assert.equal(socket.readyState, 1);
        assert.equal(socket.frames.filter((frame) => frame.action === 'chunk').length, 1);
        assert.equal(socket.frames.some((frame) => frame.action === 'finish'), false);
    });
}

test('disposal aborts a known upload even while a local Blob read has not settled', async (t) => {
    const socket = new Socket();
    const dispose = installClient({ socket });
    t.after(dispose);
    const file = new File(['a'], 'slow.bin');
    let complete!: CompleteRead;
    file.slice = () => {
        const part = new Blob(['a']);
        part.arrayBuffer = () => new Promise((resolve) => {
            complete = resolve;
        });
        return part;
    };
    const pending = send(file);
    const rejected = assert.rejects(pending, /disposed/);
    socket.reply(0, { ok: true, code: 0, step: 'ready', uploadId: 'owned', offset: 0, chunkBytes: 65536 });
    await flush();
    assert.equal(typeof complete, 'function');
    dispose();
    await rejected;
    assert.equal(socket.frames.filter((frame) => frame.action === 'abort').length, 1);
    complete(new Uint8Array([97]).buffer);
    await flush();
    assert.equal(socket.frames.filter((frame) => frame.action === 'chunk').length, 0);
    assert.equal(socket.frames.filter((frame) => frame.action === 'abort').length, 1);
});

test('file helpers share the 128 pending budget with text and reject missing sockets before dispatch', async (t) => {
    let requests = 0;
    const socket = new Socket();
    const dispose = installClient({ socket, request: async () => {
        requests++;
        throw new Error('unexpected');
    } });
    t.after(dispose);
    const pending = Array.from({ length: 128 }, () => sendBySocket(new Blob([])));
    const all = Promise.allSettled(pending);
    await assert.rejects(send('text'), /Too many pending/);
    await assert.rejects(sendByFetch(new Blob([])), /Too many pending/);
    dispose();
    assert.ok((await all).every((result) => result.status === 'rejected'));
    await assert.rejects(sendBySocket(new Blob([])), /No shared socket/);
    assert.equal(requests, 0);
});

test('file validation occurs before dispatch and HTTP file calls do not inspect shared socket readiness', async (t) => {
    const socket = new Socket();
    Object.defineProperty(socket, 'readyState', { get() {
        throw new Error('must not inspect');
    } });
    let posts = 0;
    const dispose = installClient({ socket, request: async (_input, init) => {
        posts++;
        assert.ok(init?.body instanceof Blob);
        return new Response(JSON.stringify({ ok: true, group: '', file: 'safe.png', bytes: 0 }));
    } });
    t.after(dispose);
    await assert.rejects(sendByFetch({ file: new Blob([]), name: '../unsafe.png' }), { code: 'INVALID_NAME' });
    assert.equal(posts, 0);
    await assert.rejects(sendByFetch(new File([], 'photo.png')), /Invalid.*receipt/);
    assert.equal(posts, 1);
});
