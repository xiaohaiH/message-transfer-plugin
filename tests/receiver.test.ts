import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { localDate } from '../src/filenames.js';
import { createReceiver } from '../src/index.js';
import type { ReceiverError } from '../src/index.js';
import { closeServer, connect, fixture, listen, nextReceipt, receiptPath, send, success, tempDirectory } from './helpers.js';

// 使用真实 WebSocket 覆盖独立监听, 分组落盘, 连接边界和关闭时排空.
const timeout = { timeout: 8000 };

test(
    'standalone receives per-message groups and returns UTF-8 append receipts',
    timeout,
    async (t) => {
        const { connect, directory, receiver } = await fixture(t);
        assert.equal(receiver.state, 'running');
        const ws = await connect();
        const a = success(await send(ws, { group: 'a', content: '你好' }));
        const b = success(await send(ws, { group: 'b', content: 'B' }));
        const a2 = success(await send(ws, { group: 'a', content: '\nA' }));
        assert.equal(a.bytes, 7);
        assert.equal(a.file, a2.file);
        assert.notEqual(a.groupDirectory, b.groupDirectory);
        assert.equal(await readFile(receiptPath(directory, a), 'utf8'), '你好\n\nA\n');
        assert.equal(await readFile(receiptPath(directory, b), 'utf8'), 'B\n');
        const fallback = success(await send(ws, { content: 'default' }));
        await send(ws, { group: '', content: '+' });
        assert.equal(await readFile(receiptPath(directory, fallback), 'utf8'), 'default\n+\n');
    },
);

test(
    'reconnect and receiver restart keep using the same group file',
    timeout,
    async (t) => {
        const { receiver, connect: open, directory } = await fixture(t);
        const one = await open();
        const saved = success(await send(one, { group: 'a', content: '1' }));
        const closed = once(one, 'close');
        one.close();
        await closed;
        const two = await open();
        await send(two, { group: 'a', content: '2' });
        await receiver.stop();
        assert.equal(receiver.state, 'stopped');
        const stoppedAddress = receiver.address;
        assert.equal(stoppedAddress, null);
        await receiver.start();
        assert.ok(receiver.address && typeof receiver.address !== 'string');
        const three = await connect(`ws://127.0.0.1:${receiver.address.port}/device-data`);
        t.after(() => three.terminate());
        const again = success(await send(three, { group: 'a', content: '3' }));
        assert.equal(again.file, saved.file);
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), '1\n2\n3\n');
    },
);

test(
    'invalid text schemas get safe errors; connection remains usable',
    timeout,
    async (t) => {
        const { connect, directory } = await fixture(t);
        const ws = await connect();
        for (const [raw, message] of [
            ['null', 'Expected a message object with content.'],
            ['[]', 'Expected a message object with content.'],
            ['{}', 'content must be a string or a JSON-serializable value.'],
            ['{"content":"\\ud800"}', 'content must be a string or a JSON-serializable value.'],
            ['{"content":2,"autoNewline":null}', 'autoNewline must be a boolean.'],
            ['{"content":null,"autoNewline":"false"}', 'autoNewline must be a boolean.'],
        ] as const) {
            const result = nextReceipt(ws);
            ws.send(raw);
            assert.deepEqual(await result, {
                ok: false,
                code: 1,
                error: {
                    code: 'INVALID_MESSAGE',
                    message,
                },
            });
        }
        assert.deepEqual(await readdir(directory), []);
        assert.equal(success(await send(ws, { content: 'valid' })).bytes, 6);
    },
);

test(
    'same-group order is preserved across clients and asynchronous processing',
    timeout,
    async (t) => {
        let release!: () => void;
        let entered!: () => void;
        const enteredPromise = new Promise<void>(
            (resolve) => {
                entered = resolve;
            },
        );
        const gate = new Promise<void>(
            (resolve) => {
                release = resolve;
            },
        );
        const { connect, directory } = await fixture(t, {
            processContent: async (content) => {
                if (content === '1') {
                    entered();
                    await gate;
                }
                return content;
            },
        });
        t.after(() => release());
        const first = await connect();
        const second = await connect();
        const a = send(first, { group: 'a', content: '1' });
        await enteredPromise;
        const b = send(second, { group: 'a', content: '2' });
        release();
        const [saved] = await Promise.all([a, b]);
        assert.equal(await readFile(receiptPath(directory, success(saved)), 'utf8'), '1\n2\n');
    },
);

test(
    'hook errors remain local and do not poison the next write',
    timeout,
    async (t) => {
        const errors: ReceiverError[] = [];
        const { connect } = await fixture(t, {
            processContent: (content) => {
                if (content === 'bad') throw new Error('secret path/token');
                return content;
            },
            onError: (error) => {
                errors.push(error);
                throw new Error('observer failed');
            },
        });
        const ws = await connect();
        const failed = await send(ws, { content: 'bad' });
        assert.equal(failed.ok, false);
        assert.ok(!JSON.stringify(failed).includes('secret'));
        assert.equal(errors[0]?.code, 'PROCESSING_FAILED');
        assert.equal(success(await send(ws, { content: 'good' })).bytes, 5);
    },
);

test(
    'stop waits for already accepted writes, even when the peer disconnects',
    timeout,
    async (t) => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(
            (resolve) => {
                release = resolve;
            },
        );
        const enteredPromise = new Promise<void>(
            (resolve) => {
                entered = resolve;
            },
        );
        const { connect, receiver, directory } = await fixture(t, {
            processContent: async (content) => {
                entered();
                await gate;
                return content;
            },
        });
        const ws = await connect();
        ws.send(JSON.stringify({ content: 'persist' }));
        await enteredPromise;
        ws.terminate();
        let stopped = false;
        const stopping = receiver.stop().then(() => {
            stopped = true;
        });
        await new Promise<void>(
            (resolve) => setImmediate(resolve),
        );
        assert.equal(stopped, false);
        release();
        await stopping;
        assert.equal(await readFile(join(directory, localDate(new Date()), 'default.txt'), 'utf8'), 'persist\n');
    },
);

test('simultaneous repeated start/stop is idempotent and supports starting while stopping', timeout, async () => {
    const directory = await tempDirectory();
    const receiver = createReceiver({ directory, port: 0 });
    try {
        await Promise.all([receiver.start(), receiver.start(), receiver.start()]);
        assert.equal(receiver.state, 'running');
        await Promise.all([receiver.stop(), receiver.stop()]);
        assert.equal(receiver.state, 'stopped');
        const starting = receiver.start();
        const stopping = receiver.stop();
        await Promise.all([starting, stopping]);
        assert.equal(receiver.state, 'stopped');
        await receiver.start();
        const stop = receiver.stop();
        const restart = receiver.start();
        await Promise.all([stop, restart]);
        assert.equal(receiver.state, 'running');
    }
    finally {
        await receiver.stop();
        await rm(directory, { recursive: true, force: true });
    }
});

test(
    'external HTTP mode preserves HTTP and other WebSocket routes after receiver stop',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer(
            (_req, res) => res.end('host alive'),
        );
        const other = new WebSocketServer({ noServer: true });
        other.on(
            'connection',
            (socket) =>
                socket.on(
                    'message',
                    (data) => socket.send(data.toString()),
                ),
        );
        server.on(
            'upgrade',
            (req, socket, head) => {
                if (req.url === '/other') {
                    other.handleUpgrade(
                        req,
                        socket,
                        head,
                        (ws) => other.emit('connection', ws, req),
                    );
                }
            },
        );
        const baseline = server.listenerCount('upgrade');
        const port = await listen(server);
        const receiver = createReceiver({ directory, server, path: '/receive' });
        const clients: { terminate(): void }[] = [];
        t.after(async () => {
            for (const client of clients) client.terminate();
            await receiver.stop();
            other.close();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        const ws = await connect(`ws://127.0.0.1:${port}/receive?ignored=1`);
        const peer = await connect(`ws://127.0.0.1:${port}/other`);
        clients.push(ws, peer);
        await send(ws, { content: 'attached' });
        await receiver.stop();
        assert.equal(server.listening, true);
        assert.equal(server.listenerCount('upgrade'), baseline);
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'host alive');
        const echo = once(peer, 'message');
        peer.send('other still alive');
        assert.equal(String((await echo)[0]), 'other still alive');
        await receiver.start();
        await receiver.stop();
        assert.equal(server.listenerCount('upgrade'), baseline);
    },
);

test(
    'route matching is exact and standalone rejects unrelated upgrades',
    timeout,
    async (t) => {
        const { url } = await fixture(t);
        for (const path of ['/device-data-extra', '/device-data/', '/other', '/%64evice-data']) {
            await assert.rejects(connect(new URL(path, url).toString()), /Unexpected server response: 404/);
        }
    },
);

test(
    'payload limits close an oversized message with 1009',
    timeout,
    async (t) => {
        const { connect, directory } = await fixture(t, { maxPayloadBytes: 64 });
        const ws = await connect();
        const closed = once(ws, 'close');
        ws.send(JSON.stringify({ content: 'a'.repeat(65) }));
        assert.equal((await closed)[0], 1009);
        assert.deepEqual(await readdir(directory), []);
    },
);

test(
    'pending message cap closes overloaded clients with 1013 without accepting extra writes',
    timeout,
    async (t) => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(
            (resolve) => {
                release = resolve;
            },
        );
        const enteredPromise = new Promise<void>(
            (resolve) => {
                entered = resolve;
            },
        );
        const { connect, directory, receiver } = await fixture(t, {
            maxPendingMessages: 1,
            processContent: async (content) => {
                entered();
                await gate;
                return content;
            },
        });
        const ws = await connect();
        ws.send('{"content":"first"}');
        await enteredPromise;
        const closed = once(ws, 'close');
        ws.send('{"content":"second"}');
        assert.equal((await closed)[0], 1013);
        release();
        await receiver.stop();
        assert.equal(await readFile(join(directory, localDate(new Date()), 'default.txt'), 'utf8'), 'first\n');
    },
);

test(
    'pending byte cap also applies across different groups',
    timeout,
    async (t) => {
        const { connect, directory } = await fixture(t, { maxPendingBytes: 16 });
        const ws = await connect();
        const closed = once(ws, 'close');
        ws.send('{"group":"a","content":"too long for queue"}');
        assert.equal((await closed)[0], 1013);
        assert.deepEqual(await readdir(directory), []);
    },
);

test(
    'connection cap rejects additional connections during handshake',
    timeout,
    async (t) => {
        const { connect: open, url } = await fixture(t, { maxConnections: 1 });
        await open();
        await assert.rejects(connect(url), /Unexpected server response: 503/);
    },
);

test(
    'Origin defaults reject cross-host browsers but accept same-host and native clients',
    timeout,
    async (t) => {
        const { connect: open, url } = await fixture(t);
        await open();
        await open('', { origin: url.replace('ws:', 'http:').replace('/device-data', '') });
        await assert.rejects(connect(url, { origin: 'https://evil.example' }), /Unexpected server response: 403/);
        await assert.rejects(connect(url, { origin: 'null' }), /Unexpected server response: 403/);
    },
);

test(
    'explicit Origin allowlist and missing-Origin policy are enforced',
    timeout,
    async (t) => {
        const { connect: open, url } = await fixture(t, {
            allowedOrigins: ['https://phone.example'],
            allowMissingOrigin: false,
        });
        await open('', { origin: 'https://phone.example' });
        await assert.rejects(connect(url), /Unexpected server response: 403/);
        await assert.rejects(connect(url, { origin: 'https://phone.example.evil' }), /Unexpected server response: 403/);
    },
);

test(
    'optional token supports Bearer headers and browser query params',
    timeout,
    async (t) => {
        const { connect: open, url } = await fixture(t, { token: 'a-secret-with-中文' });
        await open(`?token=${encodeURIComponent('a-secret-with-中文')}`);
        await assert.rejects(connect(url), /Unexpected server response: 401/);
        await assert.rejects(connect(`${url}?token=wrong`), /Unexpected server response: 401/);
        const ascii = await fixture(t, { token: 'secret' });
        await ascii.connect('', { headers: { Authorization: 'Bearer secret' } });
        await assert.rejects(
            connect(`${ascii.url}?token=secret`, { headers: { Authorization: 'Bearer wrong' } }),
            /Unexpected server response: 401/,
        );
    },
);

for (const config of [
    { path: 'missing-slash' },
    { path: '/with?query=1' },
    { path: '/a/../b' },
    { path: '//ambiguous' },
    { port: -1 },
    { port: 65536 },
    { maxPayloadBytes: 0 },
    { maxPendingMessages: 1.5 },
    { directory: '' },
    { token: '' },
    { allowedOrigins: ['*'] },
    { allowedOrigins: ['https://example.com/path'] },
]) {
    test(`rejects invalid config: ${JSON.stringify(config)}`, () => {
        assert.throws(() => createReceiver({ directory: './received', ...config }), { code: 'INVALID_CONFIG' });
    });
}

test('external mode rejects ambiguous listener options and server/adapter combinations', () => {
    const server = createServer();
    const adapter = { attach: () => ({ dispose() {} }) };
    for (const extra of [{ port: 0 }, { host: 'localhost' }, { adapter }]) {
        assert.throws(() => createReceiver({ directory: '.', server, ...extra }), { code: 'INVALID_CONFIG' });
    }
});

test(
    'standalone port conflicts select a free port and leave the occupied server running',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const server = createServer();
        const port = await listen(server);
        const receiver = createReceiver({ directory, port });
        t.after(async () => {
            await receiver.stop();
            await closeServer(server);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        assert.equal(receiver.state, 'running');
        assert.ok(receiver.address && typeof receiver.address !== 'string');
        assert.notEqual(receiver.address.port, port);
        assert.equal(server.listening, true);
        const ws = await connect(`ws://127.0.0.1:${receiver.address.port}/device-data`);
        t.after(() => ws.terminate());
        assert.equal(success(await send(ws, { content: 'alternate port' })).bytes, 15);
    },
);
