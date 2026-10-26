import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createReceiver } from '../src/index.js';
import type { SocketAdapter, SocketAdapterContext } from '../src/index.js';
import { closeServer, connect, listen, receiptPath, send, success, tempDirectory } from './helpers.js';

// 用真实 ws 适配器验证路径路由, 鉴权补查和挂接生命周期.
const timeout = { timeout: 8000 };

test(
    'custom adapter uses an existing Socket service, disposes only its listeners, and checks credentials',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer(
            (_req, res) => res.end('alive'),
        );
        const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
        const port = await listen(server);
        let attached = 0;
        let disposed = 0;
        const adapter: SocketAdapter = {
            attach(context) {
                attached++;
                assert.equal(context.path, '/receive');
                assert.equal(context.maxPayloadBytes, 1024);
                const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
                    if (!context.matches(request)) return;
                    const rejection = context.verify(request);
                    if (rejection) {
                        socket.end(
                            `HTTP/1.1 ${rejection.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                        );
                        return;
                    }
                    wss.handleUpgrade(
                        request,
                        socket,
                        head,
                        (ws) => context.accept(ws, request),
                    );
                };
                server.on('upgrade', upgrade);
                return {
                    dispose() {
                        disposed++;
                        server.off('upgrade', upgrade);
                    },
                };
            },
        };
        const receiver = createReceiver({
            directory,
            adapter,
            path: '/receive',
            maxPayloadBytes: 1024,
            token: 'secret',
        });
        t.after(async () => {
            await receiver.stop();
            wss.close();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        assert.equal(receiver.address, null, 'adapter addresses belong to the caller');
        await assert.rejects(connect(`ws://127.0.0.1:${port}/receive`), /Unexpected server response: 401/);
        const ws = await connect(`ws://127.0.0.1:${port}/receive?token=secret`);
        const saved = success(await send(ws, { group: 'a', content: 'adapter' }));
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'adapter\n');
        const closed = once(ws, 'close');
        await receiver.stop();
        assert.equal((await closed)[0], 1001);
        assert.equal(attached, 1);
        assert.equal(disposed, 1);
        assert.equal(server.listenerCount('upgrade'), 0);
        assert.equal(server.listening, true);
        await receiver.start();
        await receiver.stop();
        assert.equal(attached, 2);
        assert.equal(disposed, 2);
    },
);

test(
    'core rechecks security even if a custom adapter skips pre-handshake verification',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer();
        const wss = new WebSocketServer({ server });
        const port = await listen(server);
        let context!: SocketAdapterContext;
        const receiver = createReceiver({
            directory,
            token: 'secret',
            adapter: {
                attach(value) {
                    context = value;
                    const accept = (ws: WebSocket, request: Parameters<typeof value.accept>[1]) =>
                        value.accept(ws, request);
                    wss.on('connection', accept);
                    return {
                        dispose() {
                            wss.off('connection', accept);
                        },
                    };
                },
            },
        });
        t.after(async () => {
            await receiver.stop();
            for (const client of wss.clients) client.terminate();
            wss.close();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/device-data`);
        ws.on('error', () => {});
        const closed = once(ws, 'close');
        assert.equal((await closed)[0], 1008);
        assert.equal(context.matches({ url: '/other' } as Parameters<typeof context.matches>[0]), false);
    },
);

test(
    'an asynchronously attaching adapter rejects connections until startup is ready',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer();
        const port = await listen(server);
        const wss = new WebSocketServer({ noServer: true, clientTracking: false });
        let release!: () => void;
        let attached!: () => void;
        const gate = new Promise<void>(
            (resolve) => {
                release = resolve;
            },
        );
        const attachment = new Promise<void>(
            (resolve) => {
                attached = resolve;
            },
        );
        const receiver = createReceiver({
            directory,
            adapter: {
                async attach(context) {
                    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
                        if (!context.matches(request)) return;
                        const denial = context.verify(request);
                        if (denial) {
                            socket.end(
                                `HTTP/1.1 ${denial.status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                            );
                            return;
                        }
                        wss.handleUpgrade(
                            request,
                            socket,
                            head,
                            (ws) => context.accept(ws, request),
                        );
                    };
                    server.on('upgrade', upgrade);
                    attached();
                    await gate;
                    return {
                        dispose() {
                            server.off('upgrade', upgrade);
                            wss.close();
                        },
                    };
                },
            },
        });
        t.after(async () => {
            release();
            await receiver.stop();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        const starting = receiver.start();
        await attachment;
        const url = `ws://127.0.0.1:${port}/device-data`;
        await assert.rejects(connect(url), /Unexpected server response: 503/);
        release();
        await starting;
        const ws = await connect(url);
        assert.equal(success(await send(ws, { content: 'ready' })).bytes, 6);
    },
);

test(
    'duplicate receivers cannot claim the same HTTP upgrade path',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer();
        const first = createReceiver({ directory, server });
        const second = createReceiver({ directory, server });
        t.after(async () => {
            await first.stop();
            await second.stop();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await listen(server);
        await first.start();
        await assert.rejects(second.start(), { code: 'START_FAILED' });
        assert.equal(server.listenerCount('upgrade'), 1);
        await first.stop();
        await second.start();
        assert.equal(server.listenerCount('upgrade'), 1);
    },
);
