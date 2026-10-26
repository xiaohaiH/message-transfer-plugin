import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import WebSocket from 'ws';
import { installClient } from '../src/client-host.js';
import type { ClientListener } from '../src/client-host.js';
import * as client from '../src/client.js';
import { send } from '../src/client.js';
import { messageTransferPlugin } from '../src/vite.js';
import { receiptPath, success, tempDirectory } from './helpers.js';

/**
 * 创建真实 Vite 和由宿主持有的 HMR 连接, 不使用独立 /device-data WS.
 * @param {TestContext} t 注册本次测试资源清理的上下文.
 * @param {boolean | undefined} autoNewline 插件换行配置, 省略时使用默认值.
 */
async function fixture(t: TestContext, autoNewline?: boolean) {
    const root = await tempDirectory();
    const directory = join(root, 'private');
    const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        base: '/nested/',
        plugins: [messageTransferPlugin({ directory, token: 'application', ...(autoNewline === undefined ? {} : { autoNewline }) })],
        server: { host: '127.0.0.1', port: 0, watch: null },
        optimizeDeps: { noDiscovery: true },
    });
    t.after(async () => {
        await server.close();
        await rm(root, { recursive: true, force: true });
    });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const open = async (browserOrigin = origin) => {
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/nested/?token=${server.config.webSocketToken}`, 'vite-hmr', { origin: browserOrigin });
        socket.on('error', () => {});
        const connected = once(socket, 'message');
        await once(socket, 'open');
        await connected;
        t.after(() => socket.terminate());
        return socket;
    };
    return { directory, server, origin, open };
}

test('a Vite HMR namespace cannot be claimed by two receivers with different paths', async (t) => {
    const root = await tempDirectory();
    let partial: ViteDevServer | undefined;
    t.after(async () => {
        await partial?.close();
        await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0, watch: null },
        optimizeDeps: { noDiscovery: true },
        plugins: [
            { name: 'capture-partial', enforce: 'pre', configureServer(server) { partial = server; } },
            messageTransferPlugin({ directory: join(root, 'one'), path: '/one' }),
            messageTransferPlugin({ directory: join(root, 'two'), path: '/two' }),
        ],
    }), /HMR.*already|already.*HMR/);
});

test('Vite supplies automatic HMR client bootstrap without embedding application secrets', { timeout: 15000 }, async (t) => {
    const { server } = await fixture(t);
    const transformed = await server.transformRequest('@xiaohaih/message-transfer-plugin/client');
    assert.ok(server.config.optimizeDeps.exclude?.includes('@xiaohaih/message-transfer-plugin/client'));
    assert.ok(server.config.optimizeDeps.exclude?.includes('@xiaohaih/message-transfer-plugin/client-host'));
    assert.ok(transformed);
    assert.match(transformed.code, /installClient/);
    assert.match(transformed.code, /import\.meta\.hot/);
    assert.match(transformed.code, /\/nested\/device-data/);
    assert.match(transformed.code, /export\s*\{[^}]*sendByFetch[^}]*sendBySocket/);
    assert.match(transformed.code, /export\s*\{[^}]*ReceiptCode[^}]*ReceiverErrorCode/);
    assert.doesNotMatch(transformed.code, /application|new WebSocket|node:/);
});

for (const autoNewline of [undefined, false]) {
    test(`Vite send helpers reuse HMR or explicitly POST with targeted replies and autoNewline: ${autoNewline ?? 'default'}`, { timeout: 15000 }, async (t) => {
        const { open, directory, server, origin } = await fixture(t, autoNewline);
        const socket = await open();
        const other = await open();
        const broadcasts: string[] = [];
        other.on('message', (data) => broadcasts.push(String(data)));
        const listeners = new Map<string, Set<ClientListener>>();
        const channels: string[] = [];
        socket.on('message', (raw) => {
            const value = JSON.parse(String(raw));
            if (value.type === 'custom') {
                for (const listener of listeners.get(value.event) ?? []) listener(value.data);
            }
        });
        const dispose = installClient({ endpoint: `${origin}/nested/device-data`, token: 'application', timeoutMs: 500, hot: {
            on(event, listener) {
                const entries = listeners.get(event) ?? new Set();
                entries.add(listener);
                listeners.set(event, entries);
            },
            off(event, listener) { listeners.get(event)?.delete(listener); },
            send(event, data) {
                channels.push(event);
                socket.send(JSON.stringify({ type: 'custom', event, data }));
            },
        } });
        t.after(dispose);
        const newline = autoNewline === false ? '' : '\n';
        const saved = success(await send({ group: 'hmr', name: 'events.log', content: 'first' }));
        assert.equal(saved.bytes, Buffer.byteLength(`first${newline}`));
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), `first${newline}`);
        assert.equal(server.ws.clients.size, 2, 'send must not establish another HMR or dedicated WebSocket');
        assert.equal(typeof client.sendBySocket, 'function');
        const next = success(await client.sendBySocket({ group: 'hmr', name: 'events.log', content: { second: ['中文', 2] }, autoNewline: false }));
        const serialized = '{"second":["中文",2]}';
        assert.equal(next.file, saved.file);
        assert.equal(next.bytes, Buffer.byteLength(serialized));
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), `first${newline}${serialized}`);
        const forced = success(await client.sendBySocket({ group: 'hmr', name: 'events.log', content: { third: true }, autoNewline: true }));
        assert.equal(forced.file, saved.file);
        assert.equal(forced.bytes, Buffer.byteLength('{"third":true}\n'));
        assert.equal(typeof client.sendByFetch, 'function');
        const posted = success(await client.sendByFetch({ group: 'hmr', name: 'events.log', content: 'HTTP' }));
        assert.equal(posted.file, saved.file);
        assert.equal(saved.file, 'events.log');
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), `first${newline}${serialized}{"third":true}\nHTTP${newline}`);
        assert.deepEqual(channels, Array.from<string>({ length: 3 }).fill('message-transfer:request'));
        assert.equal(server.ws.clients.size, 2);
        const fence = once(other, 'message');
        server.ws.send('business:fence', { ok: true });
        await fence;
        assert.equal(broadcasts.some((data) => data.includes('message-transfer:receipt')), false);
    });
}

test('Vite transfers 100 MiB files through HMR and preserves targeted replies, base HTTP and directory protection', { timeout: 90000 }, async (t) => {
    const { open, directory, server, origin } = await fixture(t);
    const socket = await open();
    const observer = await open();
    let receivedFileReply = false;
    observer.on('message', (raw) => {
        if (String(raw).includes('message-transfer:file-receipt')) receivedFileReply = true;
    });
    const listeners = new Map<string, Set<ClientListener>>();
    socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'custom') {
            for (const listener of listeners.get(frame.event) ?? []) listener(frame.data);
        }
    });
    let token: string | undefined;
    const dispose = installClient({ endpoint: `${origin}/nested/device-data`, token: () => token, timeoutMs: 60000, hot: {
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
        },
        off(event, listener) { listeners.get(event)?.delete(listener); },
        send(event, data) { socket.send(JSON.stringify({ type: 'custom', event, data })); },
    } });
    t.after(dispose);
    assert.equal((await client.sendBySocket(new File([], 'denied.png'))).ok, false);
    token = 'application';
    const small = new File([new Uint8Array([255, 0, 80, 75])], '表格.xlsx');
    for (const method of [client.send, client.sendByFetch]) {
        const receipt = await method(small);
        assert.ok(receipt.ok && 'kind' in receipt && receipt.kind === 'file');
        assert.equal(receipt.file, '表格.xlsx');
        assert.deepEqual(await readFile(receiptPath(directory, receipt)), Buffer.from([255, 0, 80, 75]));
        assert.equal((await fetch(`${origin}/nested/@fs/${encodeURI(receiptPath(directory, receipt).replaceAll('\\', '/'))}`)).status, 403);
    }
    const chunk = new Blob([new Uint8Array(65536).fill(165)]);
    const large = new File(Array.from<Blob>({ length: 1600 }).fill(chunk), 'hmr-100.bin');
    const receipt = await client.sendBySocket(large);
    assert.ok(receipt.ok && 'kind' in receipt && receipt.kind === 'file');
    assert.equal(receipt.bytes, 104857600);
    assert.equal(receipt.file, 'hmr-100.bin');
    const renamed = success(await client.sendBySocket({ file: small, group: '资料', name: 'renamed.xlsx' }));
    assert.equal(renamed.file, 'renamed.xlsx');
    assert.equal(renamed.groupDirectory, '资料');
    assert.deepEqual(await readFile(receiptPath(directory, renamed)), Buffer.from([255, 0, 80, 75]));
    const conflict = await client.sendBySocket({ group: '资料', name: renamed.file, content: 'refused' });
    assert.ok(!conflict.ok);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.error.code, 'FILE_NAME_CONFLICT');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(receiptPath(directory, receipt))) hash.update(bytes);
    assert.equal(receipt.sha256, hash.digest('hex'));
    assert.equal(server.ws.clients.size, 2);
    const fence = once(observer, 'message');
    server.ws.send('business:fence', {});
    await fence;
    assert.equal(receivedFileReply, false);
    assert.equal((await readdir(join(directory, receipt.date))).some((name) => name.startsWith('.message-transfer-upload-')), false);
});

test('HMR connection close removes its incomplete file without closing other clients', { timeout: 10000 }, async (t) => {
    const { open, directory } = await fixture(t);
    const socket = await open();
    const other = await open();
    const next = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'custom', event: 'message-transfer:file-request', data: {
        type: 'message-transfer:file-request',
        id: 'partial',
        seq: 0,
        action: 'start',
        token: 'application',
        metadata: { name: 'partial.png', size: 3 },
    } }));
    const [raw] = await next;
    assert.equal(JSON.parse(String(raw)).data.receipt.step, 'ready');
    const [date] = await readdir(directory);
    assert.match(date!, /^\d{8}$/);
    const daily = join(directory, date!);
    assert.equal((await readdir(daily)).length, 1);
    socket.terminate();
    for (let attempt = 0; attempt < 200 && (await readdir(daily)).length; attempt++) await delay(5);
    assert.deepEqual(await readdir(daily), []);
    assert.equal(other.readyState, 1);
});

test('HMR uses the real handshake Origin rather than a spoofed message field', async (t) => {
    const { open, origin } = await fixture(t);
    const socket = await open('http://unrelated.example');
    const received = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
    socket.send(JSON.stringify({ type: 'custom', event: 'message-transfer:request', data: {
        type: 'message-transfer:request',
        id: 'spoofed',
        text: 'not accepted',
        token: 'application',
        origin,
    } }));
    const [raw] = await received;
    assert.equal(JSON.parse(String(raw)).data.receipt.error.code, 'FORBIDDEN');
});

test('disabled HMR generates HTTP-only client configuration and preserves a custom base endpoint', async (t) => {
    const root = await tempDirectory();
    const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        base: '/app/',
        plugins: [messageTransferPlugin({ directory: join(root, 'private'), path: '/upload' })],
        server: { hmr: false, ws: false, host: '127.0.0.1', port: 0, watch: null },
        optimizeDeps: { noDiscovery: true },
    });
    t.after(async () => {
        await server.close();
        await rm(root, { recursive: true, force: true });
    });
    const transformed = await server.transformRequest('@xiaohaih/message-transfer-plugin/client');
    assert.ok(transformed);
    assert.doesNotMatch(transformed.code, /hot:\s*import\.meta\.hot/);
    assert.match(transformed.code, /\/app\/upload/);
    assert.match(transformed.code, /export\s*\{[^}]*sendByFetch[^}]*sendBySocket/);
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/app/upload`, { method: 'POST', body: 'without HMR' });
    assert.equal(response.status, 200);
    const saved = success(await response.json());
    assert.equal(await readFile(receiptPath(join(root, 'private'), saved), 'utf8'), 'without HMR\n');
});

test('HMR application token is distinct from Vite token and HTTP middleware preserves base routing', { timeout: 15000 }, async (t) => {
    const { open, origin, directory } = await fixture(t);
    const socket = await open();
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'custom', event: 'message-transfer:request', data: { type: 'message-transfer:request', id: 'no_token', text: 'not stored' } }));
    const [raw] = await Promise.race([response, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing HMR receipt')), 500);
        timer.unref();
    })]);
    assert.equal(JSON.parse(String(raw)).data.receipt.error.code, 'UNAUTHORIZED');
    const endpoint = `${origin}/nested/device-data`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: 'denied' })).status, 401);
    const result = await fetch(endpoint, { method: 'POST', body: 'via HTTP', headers: { Authorization: 'Bearer application' } });
    assert.equal(result.status, 200);
    const saved = success(await result.json());
    assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'via HTTP\n');
});
