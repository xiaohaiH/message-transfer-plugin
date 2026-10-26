import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { fixture, receiptPath, send, success } from './helpers.js';

/**
 * 模拟由 HTTP/业务 Socket 宿主提供的真实请求元数据, 不接受消息自报来源.
 * @param {Record<string, string>} headers 宿主请求中的来源, 主机和认证头.
 */
function request(headers: Record<string, string> = {}): IncomingMessage {
    return { headers: { host: 'localhost', ...headers }, url: '/device-data' } as IncomingMessage;
}

test('submit is available and shares JSON/raw persistence and error receipts', async (t) => {
    const { receiver, directory } = await fixture(t);
    assert.equal(typeof Reflect.get(receiver, 'submit'), 'function');
    const first = success(await receiver.submit('{"group":"shared","content":"one"}', request()));
    const second = success(await receiver.submit('{"group":"shared","content":"two"}', request()));
    assert.equal(first.file, second.file);
    assert.equal(await readFile(receiptPath(directory, first), 'utf8'), 'one\ntwo\n');
    const raw = success(await receiver.submit(' raw\n', request()));
    assert.equal(await readFile(receiptPath(directory, raw), 'utf8'), ' raw\n');
    const invalid = await receiver.submit('null', request());
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_MESSAGE');
});

test('submit authenticates source and application token without trusting a Vite token', async (t) => {
    const { receiver } = await fixture(t, { token: 'application', allowMissingOrigin: false });
    assert.equal(typeof Reflect.get(receiver, 'submit'), 'function');
    const allowed = request({ origin: 'http://localhost', authorization: 'Bearer application' });
    assert.equal((await receiver.submit('ok', allowed)).ok, true);
    for (const origin of ['http://other.test', 'null']) {
        const result = await receiver.submit('rejected', request({ origin, authorization: 'Bearer application' }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
    }
    const missing = await receiver.submit('no token', request({ origin: 'http://localhost' }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'UNAUTHORIZED');
    const vite = request({ origin: 'http://localhost' });
    vite.url = '/?token=application';
    const denied = await receiver.submit('no app credential', vite, {});
    assert.equal(denied.ok, false, 'message-level credentials must not reuse the HMR handshake query token');
    assert.equal((await receiver.submit('app credential', vite, { token: 'application' })).ok, true);
});

test('submit and direct WebSocket share same-group ordering and queue limits', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { receiver, directory, connect } = await fixture(t, {
        maxPendingMessages: 1,
        processContent: async (content) => {
            if (content === 'first') await gate;
            return content;
        },
    });
    assert.equal(typeof Reflect.get(receiver, 'submit'), 'function');
    const first = receiver.submit('{"group":"ordered","content":"first"}', request());
    const overloaded = await receiver.submit('second', request());
    assert.equal(overloaded.ok, false);
    if (!overloaded.ok) assert.equal(overloaded.error.code, 'SERVER_BUSY');
    release();
    const saved = success(await first);
    const socket = await connect();
    const next = success(await send(socket, { group: 'ordered', content: 'third' }));
    assert.equal(saved.file, next.file);
    assert.equal(await readFile(receiptPath(directory, saved), 'utf8'), 'first\nthird\n');
});

test('stop drains submit writes and refuses new submissions', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { receiver, directory } = await fixture(t, { processContent: async (content) => {
        await gate;
        return content;
    } });
    assert.equal(typeof Reflect.get(receiver, 'submit'), 'function');
    const pending = receiver.submit('accepted', request());
    const stopped = receiver.stop();
    await Promise.resolve();
    const rejected = await receiver.submit('not accepted', request());
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'SHUTTING_DOWN');
    release();
    const receipt = success(await pending);
    await stopped;
    assert.equal(await readFile(receiptPath(directory, receipt), 'utf8'), 'accepted\n');
});

test('submit enforces original payload, byte budget and Unicode validity', async (t) => {
    const { receiver } = await fixture(t, { maxPayloadBytes: 8, maxPendingBytes: 4 });
    assert.equal(typeof Reflect.get(receiver, 'submit'), 'function');
    const tooLarge = await receiver.submit('123456789', request());
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) assert.equal(tooLarge.error.code, 'MESSAGE_TOO_LARGE');
    const busy = await receiver.submit('12345', request());
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, 'SERVER_BUSY');
    const invalid = await receiver.submit('\uD800', request());
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_MESSAGE');
});
