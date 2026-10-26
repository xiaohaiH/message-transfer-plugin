import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { installClient } from '../src/client-host.js';
import { sendByFetch, sendBySocket, send as transfer } from '../src/client.js';
import { resolveOptions } from '../src/config.js';
import { parseMessage } from '../src/protocol.js';
import { GroupedStore } from '../src/store.js';
import { closeServer, connect, fixture, listen, nextReceipt, receiptPath, send, success, tempDirectory } from './helpers.js';

test('autoNewline defaults to true and accepts only explicit booleans in receiver options', () => {
    assert.equal(resolveOptions().autoNewline, true);
    assert.equal(resolveOptions({ autoNewline: false }).autoNewline, false);
    for (const value of [null, 0, 'false', {}, []]) {
        assert.throws(() => resolveOptions({ autoNewline: value as never }), { code: 'INVALID_CONFIG' });
    }
});

test('protocol converts non-string content with JSON.stringify and preserves strings exactly', () => {
    for (const content of [{ event: 'ready', nested: { n: 1 } }, [1, '中', null], 42, false, null]) {
        const message = parseMessage(JSON.stringify({ content, autoNewline: false }));
        assert.equal(message.content, JSON.stringify(content));
        assert.equal(message.autoNewline, false);
    }
    assert.equal(parseMessage(JSON.stringify({ content: '  raw\r\n', autoNewline: true })).content, '  raw\r\n');
    assert.equal(parseMessage('  raw\n').autoNewline, undefined);
    assert.equal(parseMessage('{"content":"raw"}').autoNewline, undefined);
});

test('protocol rejects missing content and non-boolean message newline overrides', () => {
    assert.throws(() => parseMessage('{}'), { code: 'INVALID_MESSAGE' });
    for (const value of [null, 0, 'false', {}, []]) {
        assert.throws(() => parseMessage(JSON.stringify({ content: 'x', autoNewline: value })), { code: 'INVALID_MESSAGE' });
    }
});

for (const autoNewline of [true, false]) {
    test(`HTTP text inherits receiver autoNewline=${autoNewline} and honors explicit message overrides`, async (t) => {
        const { url, directory } = await fixture(t, { autoNewline });
        const cases = [
            { message: { content: 'one' }, expected: autoNewline ? 'one\n' : 'one' },
            { message: { content: 'two', autoNewline: false }, expected: 'two' },
            { message: { content: 'three', autoNewline: true }, expected: 'three\n' },
            { message: { content: 'four\n', autoNewline: true }, expected: 'four\n' },
            { message: { content: 'five\r\n', autoNewline: true }, expected: 'five\r\n' },
            { message: { content: '', autoNewline: true }, expected: '\n' },
            { message: { content: '', autoNewline: false }, expected: '' },
            { message: { content: { event: 'ready' } }, expected: `{"event":"ready"}${autoNewline ? '\n' : ''}` },
            { message: { content: null, autoNewline: false }, expected: 'null' },
        ];
        for (const [index, { message, expected }] of cases.entries()) {
            const response = await fetch(url.replace('ws:', 'http:'), { method: 'POST', body: JSON.stringify({ ...message, name: `${index}.txt` }) });
            const saved = success(await response.json());
            assert.equal(response.status, 200);
            assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), expected);
            assert.equal(saved.bytes, Buffer.byteLength(expected));
        }
        const response = await fetch(url.replace('ws:', 'http:'), { method: 'POST', body: 'raw body' });
        const saved = success(await response.json());
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), autoNewline ? 'raw body\n' : 'raw body');
    });
}

test('direct WebSocket uses default newline, serializes object content, and honors false', async (t) => {
    const { connect, directory } = await fixture(t);
    const socket = await connect();
    const first = success(await send(socket, { content: { n: 1 } }));
    const second = success(await send(socket, { content: false, autoNewline: false }));
    assert.equal(first.file, second.file);
    assert.equal(await readFile(receiptPath(directory, first), 'utf8'), '{"n":1}\nfalse');
    const received = nextReceipt(socket);
    socket.send('raw');
    const third = success(await received);
    assert.equal(await readFile(receiptPath(directory, third), 'utf8'), '{"n":1}\nfalseraw\n');
});

test('all SDK methods serialize content once and transmit explicit newline overrides', async (t) => {
    const seen: string[] = [];
    const { receiver, directory, url } = await fixture(t, { processContent(content) {
        seen.push(content);
        return content;
    } });
    const host = createServer();
    const sockets = new WebSocketServer({ server: host });
    sockets.on('connection', (socket, request) => receiver.attachSharedSocket(socket, request));
    const port = await listen(host);
    const socket = await connect(`ws://127.0.0.1:${port}/business`);
    let posts = 0;
    const dispose = installClient({ socket, endpoint: url.replace('ws:', 'http:'), request: (url, init) => {
        posts++;
        return fetch(url, init);
    } });
    t.after(async () => {
        dispose();
        socket.terminate();
        for (const peer of sockets.clients) peer.terminate();
        sockets.close();
        await closeServer(host);
    });
    let conversions = 0;
    for (const [index, sender] of [transfer, sendByFetch, sendBySocket].entries()) {
        const content = { toJSON() {
            conversions++;
            return { index };
        } };
        const saved = success(await sender({ content, autoNewline: false, name: `${index}.txt` }));
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), `{"index":${index}}`);
    }
    assert.equal(conversions, 3);
    assert.equal(posts, 1);
    assert.deepEqual(seen, ['{"index":0}', '{"index":1}', '{"index":2}']);
});

test('an explicit content field selects text for every value even alongside a file field', async (t) => {
    const { directory, url } = await fixture(t);
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    for (const [index, content] of [{ event: 'text' }, 0, false, null, 'plain'].entries()) {
        const saved = success(await sendByFetch({ content, file: new Blob(['not selected']), autoNewline: false, name: `${index}.txt` }));
        assert.equal('kind' in saved, false);
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), typeof content === 'string' ? content : JSON.stringify(content));
    }
});

test('non-serializable explicit content is not silently rerouted to an attached file', async (t) => {
    let requests = 0;
    t.after(installClient({ request: async () => {
        requests++;
        throw new Error('Invalid content must not dispatch.');
    } }));
    await assert.rejects(sendByFetch({ content: undefined, file: new Blob(['not selected']) }), TypeError);
    assert.equal(requests, 0);
});

test('explicit content uses standard JSON semantics for Blob values rather than uploading their bytes', async (t) => {
    const seen: string[] = [];
    const { directory, url } = await fixture(t, { processContent(content) {
        seen.push(content);
        return content;
    } });
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    for (const [index, content] of [new Blob(['binary']), new File(['binary'], 'sample.txt')].entries()) {
        const saved = success(await sendByFetch({ content, name: `${index}.json`, autoNewline: false }));
        assert.equal('kind' in saved, false);
        assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), JSON.stringify(content));
    }
    assert.deepEqual(seen, ['{}', '{}']);
});

test('SDK rejects non-serializable content and invalid overrides before dispatch', async (t) => {
    let requests = 0;
    t.after(installClient({ request: async () => {
        requests++;
        throw new Error('Invalid content must not dispatch.');
    } }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const content of [
        undefined,
        () => 1,
        Symbol('value'),
        1n,
        cyclic,
        { toJSON() { return undefined; } },
        { toJSON() { throw new Error('conversion failed'); } },
    ]) {
        await assert.rejects(sendByFetch({ content }), TypeError);
    }
    for (const value of [null, 0, 'false', {}, []]) {
        await assert.rejects(sendByFetch({ content: 'x', autoNewline: value as never }), TypeError);
    }
    assert.equal(requests, 0);
});

test('newline is applied after processing and counted against the final byte limit', async (t) => {
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new GroupedStore({ directory, maxContentBytes: 4, processContent: () => '中' });
    const saved = await store.append({ group: '', name: 'a.txt', content: 'source' });
    assert.equal(saved.bytes, 4);
    assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), '中\n');
    const limited = new GroupedStore({ directory, maxContentBytes: 3, processContent: () => '中' });
    await assert.rejects(limited.append({ group: '', name: 'b.txt', content: 'source' }), { code: 'MESSAGE_TOO_LARGE' });
    const unmodified = await limited.append({ group: '', name: 'b.txt', content: 'source', autoNewline: false });
    assert.equal(unmodified.bytes, 3);
    const already = new GroupedStore({ directory, maxContentBytes: 6, processContent: () => 'done\r\n' });
    const ended = await already.append({ group: '', name: 'c.txt', content: 'source' });
    assert.equal(await readFile(receiptPath(directory, ended), 'utf8'), 'done\r\n');
});

test('default newline and arbitrary content conversion never affect File or Blob bytes', async (t) => {
    const { directory, url } = await fixture(t, { processContent() {
        throw new Error('Files must bypass text processing.');
    } });
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    for (const file of [new Blob(['{"n":1}']), new File(['not a line'], 'raw.txt'), new Blob([])]) {
        const saved = success(await sendByFetch(file));
        assert.equal(saved.bytes, file.size);
        assert.deepEqual(await readFile(receiptPath(directory, saved)), Buffer.from(await file.arrayBuffer()));
    }
});
