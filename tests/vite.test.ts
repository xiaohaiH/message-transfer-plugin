import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { build, createServer } from 'vite';
import WebSocket from 'ws';
import { messageTransferPlugin } from '../src/vite.js';
import { closeServer, connect, listen, receiptPath, send, success, tempDirectory } from './helpers.js';

// 使用真实 Vite 验证共享端口和 HMR, 不用模拟插件钩子代替生命周期测试.
const timeout = { timeout: 15000 };

test(
    'Vite uses its HTTP port, coexists with HMR, and closes receiver connections',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        const directory = join(root, 'received');
        const plugin = messageTransferPlugin({ directory });
        const server = await createServer({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [plugin],
            server: { host: '127.0.0.1', port: 0, watch: null },
            optimizeDeps: { noDiscovery: true, include: [] },
        });
        t.after(async () => {
            await server.close();
            await rm(root, { recursive: true, force: true });
        });
        await server.listen();
        const port = (server.httpServer!.address() as AddressInfo).port;
        const ws = await connect(`ws://127.0.0.1:${port}/device-data`);
        const saved = success(await send(ws, { group: 'vite', content: 'hello' }));
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'hello\n');
        const hmr = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`, 'vite-hmr');
        hmr.on('error', () => {});
        const initial = once(hmr, 'message');
        await once(hmr, 'open');
        assert.deepEqual(JSON.parse(String((await initial)[0])), { type: 'connected' });
        const hotMessage = once(hmr, 'message');
        server.ws.send({ type: 'custom', event: 'receiver-test', data: 'still working' });
        assert.equal(JSON.parse(String((await hotMessage)[0])).event, 'receiver-test');
        const receiverClosed = once(ws, 'close');
        const hmrClosed = once(hmr, 'close');
        await server.close();
        await receiverClosed;
        await hmrClosed;
        assert.equal(server.httpServer!.listenerCount('upgrade'), 0);
    },
);

test(
    'Vite restart reattaches the receiver without duplicating group content or listeners',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        const directory = join(root, 'received');
        const server = await createServer({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [messageTransferPlugin({ directory })],
            server: { host: '127.0.0.1', port: 0, watch: null },
            optimizeDeps: { noDiscovery: true },
        });
        t.after(async () => {
            await server.close();
            await rm(root, { recursive: true, force: true });
        });
        await server.listen();
        const before = await connect(
            `ws://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/device-data`,
        );
        const saved = success(await send(before, { group: 'restart', content: 'one' }));
        await server.restart();
        const after = await connect(`ws://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/device-data`);
        const next = success(await send(after, { group: 'restart', content: 'two' }));
        assert.equal(next.file, saved.file);
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'one\ntwo\n');
        assert.equal(server.httpServer!.listenerCount('upgrade'), 2, 'one Vite HMR route plus one receiver route');
    },
);

test(
    'Vite build does not start a receiver or create its directory',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        const directory = join(root, 'must-not-exist');
        t.after(() => rm(root, { recursive: true, force: true }));
        await writeFile(join(root, 'index.html'), '<!doctype html><title>build</title>');
        await build({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [messageTransferPlugin({ directory })],
            build: { write: false },
        });
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);

test(
    'middleware mode without an explicit host reports a clear configuration error',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        t.after(() => rm(root, { recursive: true, force: true }));
        await assert.rejects(
            createServer({
                configFile: false,
                root,
                logLevel: 'silent',
                plugins: [messageTransferPlugin({ directory: root })],
                server: { middlewareMode: true, ws: false, watch: null },
            }),
            /middleware.*server|HTTP.*server/i,
        );
    },
);

test(
    'middleware mode can attach to an explicit HTTP server without owning it',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        const host = createHttpServer();
        const port = await listen(host);
        const server = await createServer({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [messageTransferPlugin({ directory: root, server: host })],
            server: { middlewareMode: true, ws: false, watch: null },
        });
        t.after(async () => {
            await server.close();
            await closeServer(host);
            await rm(root, { recursive: true, force: true });
        });
        const ws = await connect(`ws://127.0.0.1:${port}/device-data`);
        const saved = success(await send(ws, { content: 'middleware' }));
        await server.close();
        assert.equal(host.listening, true);
        assert.equal(host.listenerCount('upgrade'), 0);
        assert.equal(await readFile(receiptPath(root, saved), 'utf8'), 'middleware\n');
    },
);

test(
    'Vite logs the actual directory and denies HTTP access to received files without weakening existing denies',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        const directory = join(root, 'private[1]');
        const logs: string[] = [];
        const server = await createServer({
            configFile: false,
            root,
            logLevel: 'info',
            clearScreen: false,
            plugins: [messageTransferPlugin({ directory })],
            customLogger: {
                info: (text) => {
                    logs.push(text);
                },
                warn() {},
                warnOnce() {},
                error() {},
                clearScreen() {},
                hasWarned: false,
                hasErrorLogged: () => false,
            },
            server: { host: '127.0.0.1', port: 0, watch: null, fs: { deny: ['**/extra-secret.txt'] } },
            optimizeDeps: { noDiscovery: true },
        });
        t.after(async () => {
            await server.close();
            await rm(root, { recursive: true, force: true });
        });
        await server.listen();
        const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
        const ws = await connect(`${origin.replace('http:', 'ws:')}/device-data`);
        const saved = success(await send(ws, { group: 'notes', content: 'private received content' }));
        await writeFile(join(root, '.env'), 'TOKEN=private');
        await writeFile(join(root, 'extra-secret.txt'), 'private');
        assert.ok(
            logs.some(
                (line) => line.includes(`Directory: ${directory}`),
            ),
        );
        for (const path of [
            `/private[1]/${saved.date}/${saved.groupDirectory}/${saved.file}`,
            '/.env',
            '/extra-secret.txt',
            `/@fs/${receiptPath(directory, saved).replaceAll('\\\\', '/')}`,
        ]) {
            assert.equal((await fetch(origin + path)).status, 403, path);
        }
    },
);

test(
    'a receiver path cannot collide with the Vite HMR endpoint',
    timeout,
    async (t) => {
        const root = await tempDirectory();
        t.after(() => rm(root, { recursive: true, force: true }));
        await assert.rejects(
            createServer({
                configFile: false,
                root,
                logLevel: 'silent',
                plugins: [messageTransferPlugin({ directory: root, path: '/' })],
                server: { watch: null },
            }),
            /HMR/,
        );
    },
);
