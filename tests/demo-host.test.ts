import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

/** 只替代浏览器 WebSocket 边界, 不模拟 SDK 的通道选择. */
class Socket extends EventTarget {
    /** 浏览器连接状态, 初始处于连接中. */
    readyState = 0;
    /** 记录宿主关闭自己资源的次数. */
    closes = 0;
    /** 禁止示例宿主发送或重放业务消息. */
    send(): never { throw new Error('Demo host must not send messages.'); }
    /** 模拟关闭但不自动发事件, 允许测试迟到的旧连接事件. */
    close(): void {
        this.closes++;
        this.readyState = 3;
    }
}

/** 浏览器示例工厂返回的资源控制器. */
interface Control {
    connect(): void;
    disconnect(): void;
    dispose(): void;
}

/** 示例连接状态回调. @param {string} message 安全的纯文本连接提示. */
type Report = (message: string) => void;
/** 浏览器宿主工厂签名. @param {Report} report 收集连接提示的回调. */
type HostFactory = (report: Report) => Control;

/**
 * 执行实际宿主模块, 仅替换 WebSocket 构造器和 SDK 安装边界.
 * @param {string} href 页面实际地址, 应决定 ws 或 wss 以及同源端口.
 * @param {boolean} failInstall 是否模拟首次 SDK 注册失败.
 * @param {boolean} failConstruct 是否模拟首次 WebSocket 构造失败.
 */
async function host(href = 'http://localhost:8786/sender.html', failInstall = false, failConstruct = false) {
    const sockets: Socket[] = [];
    const urls: string[] = [];
    const installed: Socket[] = [];
    const released: Socket[] = [];
    const status: string[] = [];
    const source = await readFile(new URL('../examples/sender-host.js', import.meta.url), 'utf8');
    const create = runInNewContext(`${source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')}\ncreateDemoSocket;`, {
        URL,
        location: new URL(href),
        WebSocket: class extends Socket {
            /**
             * 记录模块推导的地址而不建立真实网络连接.
             * @param {string} url 示例宿主创建的同源业务连接地址.
             */
            constructor(url: string) {
                super();
                if (failConstruct) {
                    failConstruct = false;
                    throw new Error('private construction error');
                }
                urls.push(url);
                sockets.push(this);
            }
        },
        installClient: (options: { socket: Socket }) => {
            if (failInstall) {
                failInstall = false;
                throw new Error('private install error');
            }
            installed.push(options.socket);
            return () => released.push(options.socket);
        },
    }) as HostFactory;
    const control = create((message) => status.push(message));
    return { control, sockets, urls, installed, released, status };
}

for (const [href, expected] of [
    ['http://localhost:8786/sender.html', 'ws://localhost:8786/business-socket'],
    ['https://localhost:8789/sender.html?unrelated=page', 'wss://localhost:8789/business-socket'],
    ['https://[::1]:8789/sender.html', 'wss://[::1]:8789/business-socket'],
]) {
    test(`demo host creates exactly one inferred same-origin connection for ${href}`, async () => {
        const app = await host(href);
        try {
            assert.deepEqual(app.urls, [expected]);
            assert.deepEqual(app.installed, app.sockets);
            app.control.connect();
            const socket = app.sockets[0]!;
            socket.readyState = 1;
            socket.dispatchEvent(new Event('open'));
            app.control.connect();
            assert.equal(app.sockets.length, 1);
            assert.match(app.status.at(-1)!, /已连接/);
            assert.equal(app.released.length, 0);
        }
        finally { app.control.dispose(); }
        assert.equal(app.sockets[0]!.closes, 1);
        assert.equal(app.released.length, 1);
    });
}

test('demo host detaches listeners on manual disconnect and ignores stale events after reconnect', async () => {
    const app = await host();
    const first = app.sockets[0]!;
    app.control.disconnect();
    assert.equal(first.closes, 1);
    for (const event of ['open', 'error', 'close']) assert.equal(getEventListeners(first, event).length, 0);
    app.control.connect();
    const second = app.sockets[1]!;
    assert.ok(second);
    const status = [...app.status];
    for (const event of ['open', 'error', 'close']) first.dispatchEvent(new Event(event));
    assert.deepEqual(app.status, status);
    assert.deepEqual(app.released, [first]);
    app.control.dispose();
    app.control.dispose();
    app.control.connect();
    assert.equal(app.sockets.length, 2);
    assert.equal(second.closes, 1);
    assert.deepEqual(app.released, [first, second]);
    for (const event of ['open', 'error', 'close']) assert.equal(getEventListeners(second, event).length, 0);
});

for (const event of ['close', 'error']) {
    test(`demo host permits explicit retry after ${event} but never reconnects automatically`, async () => {
        const app = await host();
        const first = app.sockets[0]!;
        first.dispatchEvent(new Event(event));
        assert.equal(app.sockets.length, 1);
        assert.deepEqual(app.released, [first]);
        for (const name of ['open', 'error', 'close']) assert.equal(getEventListeners(first, name).length, 0);
        app.control.connect();
        assert.equal(app.sockets.length, 2);
        app.control.dispose();
    });
}

test('demo host rolls back failed registration and permits one manual retry without leaking diagnostics', async () => {
    const app = await host(undefined, true);
    assert.equal(app.sockets[0]!.closes, 1);
    assert.equal(app.installed.length, 0);
    assert.doesNotMatch(app.status.join(' '), /private install/);
    app.control.connect();
    assert.equal(app.sockets.length, 2);
    assert.deepEqual(app.installed, [app.sockets[1]]);
    app.control.dispose();
});

test('demo host handles constructor failure without retrying or exposing the exception', async () => {
    const app = await host(undefined, false, true);
    assert.equal(app.sockets.length, 0);
    assert.doesNotMatch(app.status.join(' '), /private construction/);
    app.control.connect();
    assert.equal(app.sockets.length, 1);
    app.control.dispose();
});

test('demo host does not create a socket for file URLs', async () => {
    const app = await host('file:///tmp/sender.html');
    app.control.connect();
    assert.equal(app.sockets.length, 0);
    assert.equal(app.installed.length, 0);
    app.control.dispose();
});
