import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { localDate } from '../src/filenames.js';
import { createReceiver } from '../src/index.js';
import { GroupedStore } from '../src/store.js';
import { closeServer, connect, fixture, listen, receiptPath, send, success, tempDirectory } from './helpers.js';

// 保留审查发现的问题, 验证宿主隔离, 权限边界和启停资源释放.
const timeout = { timeout: 8000 };

test(
    'attaching a receiver does not intercept unrelated host error events',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const host = createServer();
        const observed: unknown[] = [];
        const ownErrors: unknown[] = [];
        const hostError = (error: unknown) => {
            observed.push(error);
        };
        host.on('error', hostError);
        const receiver = createReceiver({
            directory,
            server: host,
            onError: (error) => ownErrors.push(error),
        });
        t.after(async () => {
            await receiver.stop();
            await closeServer(host);
            await rm(directory, { recursive: true, force: true });
        });
        await receiver.start();
        const unrelated = new Error('unrelated host error');
        host.emit('error', unrelated);
        assert.deepEqual(observed, [unrelated]);
        assert.deepEqual(ownErrors, []);
        assert.equal(host.listenerCount('error'), 1);
    },
);

test(
    'a synchronous listen failure removes temporary startup listeners',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const originalListen = Server.prototype.listen;
        const baselineListening = createServer().listenerCount('listening');
        let created: Server | undefined;
        // 只观察真实 listen 调用, 不替换其行为, 也不向生产 API 注入测试接口.
        t.mock.method(
            Server.prototype,
            'listen',
            /**
             * @this {Server} 被调用的真实 HTTP 服务器, 不是替代实现.
             * @param {unknown[]} args 传给 listen 的原始参数, 不修改地转交实际方法.
             */
            function (this: Server, ...args: unknown[]) {
                // eslint-disable-next-line ts/no-this-alias -- 保留真实实例以检查失败后监听器数量, 不替代其行为.
                created = this;
                return Reflect.apply(originalListen, this, args);
            },
        );
        const receiver = createReceiver({ directory, host: '\0', port: 0 });
        t.after(async () => {
            await receiver.stop();
            await rm(directory, { recursive: true, force: true });
        });
        await assert.rejects(receiver.start(), { code: 'START_FAILED' });
        assert.equal(receiver.state, 'stopped');
        assert.ok(created);
        assert.equal(created.listenerCount('listening'), baselineListening);
        assert.equal(created.listenerCount('error'), 0);
        assert.equal(created.listenerCount('upgrade'), 0);
    },
);

test(
    'Bearer authentication scheme is case-insensitive',
    timeout,
    async (t) => {
        const { connect: open } = await fixture(t, { token: 'secret' });
        const ws = await open('', { headers: { Authorization: 'bEaReR secret' } });
        assert.equal(success(await send(ws, { content: 'authorized' })).bytes, 11);
    },
);

test(
    'simultaneous upgrade attempts cannot exceed the WebSocket connection cap',
    timeout,
    async (t) => {
        const { url, receiver } = await fixture(t, { maxConnections: 2 });
        const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => connect(url)));
        const opened = attempts.filter(
            (attempt) => attempt.status === 'fulfilled',
        );
        assert.equal(opened.length, 2);
        for (const attempt of attempts) {
            if (attempt.status === 'fulfilled') attempt.value.terminate();
            else assert.match(String(attempt.reason), /Unexpected server response: 503/);
        }
        await receiver.stop();
    },
);

test(
    'external host close cleans the attachment when there are no active peers',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const host = createServer();
        const receiver = createReceiver({ directory, server: host });
        t.after(async () => {
            await receiver.stop();
            await closeServer(host);
            await rm(directory, { recursive: true, force: true });
        });
        await listen(host);
        await receiver.start();
        await closeServer(host);
        // 宿主关闭事件会进入同一个幂等清理队列, 再次 stop 等待队列完成.
        await receiver.stop();
        assert.equal(receiver.state, 'stopped');
        assert.equal(host.listenerCount('upgrade'), 0);
    },
);

test(
    'a read-only group file yields WRITE_FAILED and preserves its existing bytes',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        const store = new GroupedStore({ directory, maxContentBytes: 128 });
        await store.prepare();
        const saved = await store.append({ group: '', name: 'default.txt', content: 'before' });
        const file = receiptPath(directory, saved);
        t.after(async () => {
            await chmod(file, 0o600);
            await rm(directory, { recursive: true, force: true });
        });
        await chmod(file, 0o400);
        if (process.getuid?.() === 0) {
            t.skip('Root bypasses file permission checks');
            return;
        }
        await assert.rejects(store.append({ group: '', name: 'default.txt', content: 'must not write' }), { code: 'WRITE_FAILED' });
        assert.equal(await readFile(file, 'utf8'), 'before\n');
    },
);

test(
    'a hard-linked group target is refused without modifying the shared file',
    timeout,
    async (t) => {
        const directory = await tempDirectory();
        t.after(() => rm(directory, { recursive: true, force: true }));
        const target = join(directory, 'other.txt');
        await writeFile(target, 'untouched');
        const daily = join(directory, localDate(new Date()));
        await mkdir(daily);
        await link(target, join(daily, 'default.txt'));
        const store = new GroupedStore({ directory, maxContentBytes: 128 });
        await store.prepare();
        await assert.rejects(store.append({ group: '', name: 'default.txt', content: 'bad' }), { code: 'WRITE_FAILED' });
        assert.equal(await readFile(target, 'utf8'), 'untouched');
    },
);

test(
    'shutdown forces a peer that does not answer the WebSocket close handshake',
    timeout,
    async (t) => {
        const { connect: open, receiver } = await fixture(t, { shutdownTimeoutMs: 40 });
        const ws = await open();
        const closed = once(ws, 'close');
        ws.pause();
        await receiver.stop();
        ws.resume();
        await closed;
        assert.equal(receiver.state, 'stopped');
    },
);
