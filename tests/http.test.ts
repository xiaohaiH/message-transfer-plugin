import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHttpHandler } from '../src/http.js';
import type { HttpHandlerContext } from '../src/http.js';
import { closeServer, fixture, listen, receiptPath, success } from './helpers.js';

/**
 * 创建只记录提交文本的 HTTP 测试宿主, 端口由系统分配.
 * @param {TestContext} t 注册宿主和本库路由清理的测试上下文.
 * @param {Partial<HttpHandlerContext>} overrides 本测试覆盖的鉴权, 容量或提交回调.
 */
async function host(t: TestContext, overrides: Partial<HttpHandlerContext> = {}) {
    const texts: string[] = [];
    const handler = createHttpHandler({
        path: '/device-data',
        maxPayloadBytes: 64,
        maxPendingBytes: 128,
        maxConnections: 2,
        shutdownTimeoutMs: 1000,
        authorize: () => undefined,
        submit: async (text) => {
            texts.push(text);
            return { ok: true, code: 0, date: '20261024', groupDirectory: '', group: '', file: 'test.txt', bytes: Buffer.byteLength(text) };
        },
        ...overrides,
    });
    const server = createServer((request, response) => {
        if (!handler.handle(request, response)) {
            response.writeHead(404);
            response.end('other');
        }
    });
    const port = await listen(server);
    t.after(async () => {
        handler.dispose();
        server.closeAllConnections();
        await closeServer(server);
    });
    return { handler, server, url: `http://127.0.0.1:${port}`, texts };
}

/**
 * 读取测试原生 HTTP 响应, 不向控制台打印消息或认证信息.
 * @param {IncomingMessage} response 测试服务器实际返回的完整响应流.
 */
async function body(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

test('HTTP helper passes JSON/raw/empty/BOM unchanged and leaves unmatched routes alone', async (t) => {
    const { url, texts } = await host(t);
    assert.equal((await fetch(`${url}/other`)).status, 404);
    assert.equal((await fetch(`${url}/device-data/`)).status, 404);
    const inputs = ['{"group":"kept","content":"hello"}', ' raw\n', '', '\uFEFFraw'];
    for (const text of inputs) assert.equal((await fetch(`${url}/device-data?x=1`, { method: 'POST', body: text })).status, 200);
    assert.deepEqual(texts, inputs);
});

test('HTTP coalesces tiny chunks instead of retaining an unbounded list of backing buffers', async (t) => {
    const { url, server, texts } = await host(t);
    const concat = Buffer.concat.bind(Buffer);
    let buffers = 0;
    t.mock.method(Buffer, 'concat', (parts: readonly Uint8Array[], length?: number) => {
        if (length === 64) buffers = parts.length;
        return concat(parts, length);
    });
    const request = httpRequest(`${url}/device-data`, { method: 'POST', headers: { 'Content-Length': '64' } });
    request.on('error', () => {});
    const received = once(server, 'request');
    const response = once(request, 'response');
    request.flushHeaders();
    const [incoming] = await received;
    for (let i = 0; i < 64; i++) {
        const chunk = once(incoming, 'data');
        request.write('x');
        await chunk;
    }
    request.end();
    await body((await response)[0]);
    assert.equal(buffers, 1);
    assert.deepEqual(texts, ['x'.repeat(64)]);
});

test('HTTP errors are safe JSON and authorization happens before reading the body', async (t) => {
    let authorized = 0;
    const { url, texts } = await host(t, { authorize: () => {
        authorized++;
        return { status: 403, message: 'do not leak this' };
    } });
    const method = await fetch(`${url}/device-data`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'POST');
    assert.match(method.headers.get('content-type')!, /application\/json/);
    const result = await fetch(`${url}/device-data`, { method: 'POST', body: 'private' });
    assert.equal(result.status, 403);
    assert.equal(authorized, 1);
    assert.deepEqual(texts, []);
    assert.doesNotMatch(await result.text(), /do not leak/);
});

test('HTTP fails safely when the host already enabled text decoding', { timeout: 2500 }, async (t) => {
    const { url, server, texts } = await host(t);
    server.prependListener('request', (request) => request.setEncoding('utf8'));
    const response = await fetch(`${url}/device-data`, { method: 'POST', body: 'not raw', signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 400);
    assert.deepEqual(texts, []);
});

test('HTTP header and chunked limits, invalid UTF-8 and content encodings are rejected', async (t) => {
    const { url, texts } = await host(t, { maxPayloadBytes: 4 });
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: '12345' })).status, 413);
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: new Uint8Array([0xFF]) })).status, 400);
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: 'x', headers: { 'Content-Encoding': 'gzip' } })).status, 415);
    const request = httpRequest(`${url}/device-data`, { method: 'POST' });
    request.on('error', () => {});
    const response = once(request, 'response');
    request.write('123');
    request.end('45');
    const [result] = await response;
    assert.equal(result.statusCode, 413);
    await body(result);
    assert.deepEqual(texts, []);
});

test('HTTP counts submitted requests until reply and dispose does not cancel accepted work', async (t) => {
    let release!: () => void;
    let received!: () => void;
    const started = new Promise<void>((resolve) => {
        received = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { url, handler } = await host(t, {
        maxConnections: 1,
        submit: async () => {
            received();
            await gate;
            return { ok: true, code: 0, date: '20261024', groupDirectory: '', group: '', file: 'test.txt', bytes: 1 };
        },
    });
    const first = fetch(`${url}/device-data`, { method: 'POST', body: 'a' });
    await started;
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: 'b' })).status, 503);
    handler.dispose();
    release();
    assert.equal((await first).status, 200);
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: 'c' })).status, 503);
    assert.equal((await fetch(`${url}/other`)).status, 404);
});

test('HTTP read buffers share a budget, abort releases it and dispose answers unfinished reads', { timeout: 5000 }, async (t) => {
    const { url, server, handler, texts } = await host(t, { maxPendingBytes: 4 });
    const first = httpRequest(`${url}/device-data`, { method: 'POST' });
    first.on('error', () => {});
    const incoming = new Promise<IncomingMessage>((resolve) => {
        server.once('request', (request) => request.once('data', () => resolve(request)));
    });
    first.write('123');
    const incomingFirst = await incoming;
    const refused = await fetch(`${url}/device-data`, { method: 'POST', body: '45' });
    assert.equal(refused.status, 503);
    const closed = new Promise<void>((resolve) => incomingFirst.once('close', resolve));
    first.destroy();
    await closed;
    assert.equal((await fetch(`${url}/device-data`, { method: 'POST', body: '1234' })).status, 200);
    const unfinished = httpRequest(`${url}/device-data`, { method: 'POST' });
    unfinished.on('error', () => {});
    const response = once(unfinished, 'response');
    const incomingNext = once(server, 'request');
    unfinished.write('x');
    await incomingNext;
    handler.dispose();
    const [stopped] = await response;
    assert.equal(stopped.statusCode, 503);
    await body(stopped);
    assert.deepEqual(texts, ['1234']);
});

test('HTTP body timeout waits 30 seconds and sends status 408 with correctly forwarded timer arguments', async (t) => {
    const { url, server, texts } = await host(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = httpRequest(`${url}/device-data`, { method: 'POST' });
    request.on('error', () => {});
    let status: number | undefined;
    request.on('response', (response) => {
        status = response.statusCode;
    });
    const reply = once(request, 'response');
    const incoming = once(server, 'request');
    request.flushHeaders();
    await incoming;
    t.mock.timers.tick(29999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status, undefined);
    t.mock.timers.tick(1);
    const [response] = await reply;
    assert.equal(response.statusCode, 408);
    assert.equal(JSON.parse(await body(response)).error.code, 'INVALID_MESSAGE');
    assert.deepEqual(texts, []);
});

test('standalone POST uses the receiver store and HTTP and WS share the queue', async (t) => {
    const { receiver, directory, url } = await fixture(t, { token: 'app' });
    assert.equal(typeof Reflect.get(receiver, 'handleRequest'), 'function');
    const endpoint = url.replace('ws:', 'http:');
    const denied = await fetch(endpoint, { method: 'POST', body: 'no' });
    assert.equal(denied.status, 401);
    const headers = { Authorization: 'Bearer app' };
    const result = await fetch(endpoint, { method: 'POST', headers, body: '{"group":"http","content":"saved"}' });
    assert.equal(result.status, 200);
    const saved = success(await result.json());
    assert.equal(saved.group, 'http');
    assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'saved\n');
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'null' })).status, 400);
});
