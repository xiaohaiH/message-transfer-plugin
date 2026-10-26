import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { connect as connectHttp2 } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { FILE_HEADER, fileHeader } from '../src/file-protocol.js';
import { createReceiver } from '../src/index.js';
import { messageTransferPlugin } from '../src/vite.js';
import { closeServer, connect, listen, receiptPath, send, success, tempDirectory } from './helpers.js';

// 仅测试使用公开的自签名证书, 生产代码不关闭 TLS 校验.
async function certificate() {
    return {
        key: await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)),
        cert: await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url)),
    };
}

test(
    'external HTTPS accepts WSS and leaves the TLS server owned by the caller',
    { timeout: 8000 },
    async (t) => {
        const directory = await tempDirectory();
        const server = createHttpsServer(await certificate());
        const port = await listen(server);
        const receiver = createReceiver({ directory, server });
        t.after(async () => {
            await receiver.stop();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        const ws = await connect(`wss://127.0.0.1:${port}/device-data`, { rejectUnauthorized: false });
        const saved = success(await send(ws, { group: 'tls', content: 'encrypted connection' }));
        const closed = once(ws, 'close');
        await receiver.stop();
        await closed;
        assert.equal(server.listening, true);
        assert.equal(server.listenerCount('upgrade'), 0);
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'encrypted connection\n');
    },
);

test('Vite HTTP/2 POST checks the real authority and only closes a rejected request stream', { timeout: 15000 }, async (t) => {
    const root = await tempDirectory();
    const tls = await certificate();
    const server = await createViteServer({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [messageTransferPlugin({ directory: join(root, 'received'), token: 'application' })],
        server: { host: '127.0.0.1', port: 0, watch: null, https: tls, ws: false },
        optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const origin = `https://127.0.0.1:${port}`;
    const client = connectHttp2(origin, { ca: tls.cert, servername: 'localhost' });
    t.after(async () => {
        client.destroy();
        await server.close();
        await rm(root, { recursive: true, force: true });
    });
    await once(client, 'connect');
    const post = async (token?: string, file = false) => {
        const stream = client.request({ ':method': 'POST', ':path': '/device-data', ':authority': new URL(origin).host, origin, ...(file ? { 'content-type': 'application/octet-stream', [FILE_HEADER]: fileHeader({ name: 'http2.xlsx', size: 4 }) } : {}), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) });
        const response = once(stream, 'response');
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = once(stream, 'end');
        stream.end(file ? Buffer.from([255, 0, 80, 75]) : 'HTTP2 data');
        const [headers] = await response;
        await ended;
        return { status: headers[':status'], receipt: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    };
    assert.equal((await post()).status, 401);
    const allowed = await post('application');
    assert.equal(allowed.status, 200);
    const saved = success(allowed.receipt);
    assert.equal(await readFile(receiptPath(join(root, 'received'), saved), 'utf8'), 'HTTP2 data\n');
    assert.equal((await post(undefined, true)).status, 401);
    const file = await post('application', true);
    assert.equal(file.status, 200);
    assert.equal(file.receipt.kind, 'file');
    assert.deepEqual(await readFile(receiptPath(join(root, 'received'), file.receipt)), Buffer.from([255, 0, 80, 75]));
    assert.equal(client.destroyed, false);
});

test(
    'Vite HTTPS (HTTP/2 with HTTP/1 upgrade) accepts WSS on the same TLS listener',
    { timeout: 15000 },
    async (t) => {
        const root = await tempDirectory();
        const server = await createViteServer({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [messageTransferPlugin({ directory: root })],
            server: { host: '127.0.0.1', port: 0, watch: null, https: await certificate() },
            optimizeDeps: { noDiscovery: true },
        });
        t.after(async () => {
            await server.close();
            await rm(root, { recursive: true, force: true });
        });
        await server.listen();
        const port = (server.httpServer!.address() as AddressInfo).port;
        const ws = await connect(`wss://127.0.0.1:${port}/device-data`, { rejectUnauthorized: false });
        const saved = success(await send(ws, { content: 'vite TLS' }));
        const closed = once(ws, 'close');
        await server.close();
        await closed;
        assert.equal(await readFile(receiptPath(root, saved), 'utf8'), 'vite TLS\n');
    },
);
