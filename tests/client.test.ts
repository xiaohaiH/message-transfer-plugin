import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installClient } from '../src/client-host.js';
import type { ClientListener } from '../src/client-host.js';
import * as client from '../src/client.js';
import { send } from '../src/client.js';

const saved = { ok: true, code: 0, date: '20260929', groupDirectory: '', group: '', file: 'default.txt', bytes: 2 };

/** 测试已有浏览器连接, SDK 不得创建连接或覆盖业务 onmessage. */
class Socket extends EventTarget {
    /** 初始模拟已建立连接. */
    readyState = 1;
    /** 记录已发送的完整文本帧. */
    sent: string[] = [];
    /**
     * 记录 SDK 发送的帧, 不模拟自动成功.
     * @param {string} text 待发送的命名空间 JSON 帧.
     */
    send(text: string): void { this.sent.push(text); }
    /**
     * 按请求下标发回对应回执, 可以故意乱序或发送错误形状.
     * @param {number} index sent 数组中的请求下标.
     * @param {unknown} receipt 被客户端严格验证的模拟回执.
     */
    reply(index: number, receipt: unknown = saved): void {
        const id = JSON.parse(this.sent[index]!).id;
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'message-transfer:receipt', id, receipt }) }));
    }
}

/** 测试 HMR 的命名空间事件和断开通知. */
class Hot {
    /** 不同事件各自独立的已有宿主监听器. */
    listeners = new Map<string, Set<ClientListener>>();
    /** 记录已派发的 HMR 自定义事件. */
    sent: unknown[] = [];
    /**
     * 注册宿主监听器.
     * @param {string} event 要监听的事件名.
     * @param {(value: unknown) => void} listener 接收事件负载的处理器.
     */
    on(event: string, listener: ClientListener): void {
        const entries = this.listeners.get(event) ?? new Set();
        entries.add(listener);
        this.listeners.set(event, entries);
    }

    /**
     * 只移除指定宿主监听器.
     * @param {string} event 原注册事件名.
     * @param {(value: unknown) => void} listener 原注册的处理器引用.
     */
    off(event: string, listener: ClientListener): void { this.listeners.get(event)?.delete(listener); }
    /**
     * 记录 SDK 发送的 HMR 请求.
     * @param {string} event SDK 使用的自定义事件名称.
     * @param {unknown} value 命名空间请求帧.
     */
    send(event: string, value: unknown): void {
        assert.equal(event, 'message-transfer:request');
        this.sent.push(value);
    }

    /**
     * 向已安装的回调发出测试事件.
     * @param {string} event 要触发的宿主事件.
     * @param {unknown} value 测试事件负载.
     */
    emit(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

test('client entry exposes three send helpers and plain send still defaults to one HTTP POST', async (t) => {
    assert.deepEqual(Object.keys(client).sort(), ['ReceiptCode', 'ReceiverErrorCode', 'send', 'sendByFetch', 'sendBySocket']);
    assert.deepEqual(client.ReceiptCode, { SUCCESS: 0, FAILURE: 1 });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: unknown, init: RequestInit) => {
        calls++;
        assert.equal(input, '/device-data');
        assert.equal(init.body, 'hi');
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.redirect, 'error');
        return new Response(JSON.stringify(saved));
    });
    assert.equal((await send('hi')).ok, true);
    assert.equal(calls, 1);
});

test('sendByFetch bypasses available socket/HMR and keeps host HTTP settings and original message encoding', async (t) => {
    assert.equal(typeof client.sendByFetch, 'function');
    const socket = new Socket();
    const hot = new Hot();
    const bodies: unknown[] = [];
    const dispose = installClient({ socket, hot, endpoint: '/proxy/upload', token: () => 'application', request: async (input, init) => {
        assert.equal(input, '/proxy/upload');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.credentials, 'same-origin');
        assert.equal(init?.redirect, 'error');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer application');
        bodies.push(init?.body);
        return new Response(JSON.stringify(saved));
    } });
    t.after(dispose);
    // 显式 Fetch 不应读取或依赖共享连接状态.
    Object.defineProperty(socket, 'readyState', {
        get() { throw new Error('Socket must not be inspected.'); },
    });
    await assert.rejects(client.sendByFetch({ content: '\uD800' }), /valid Unicode/);
    assert.equal(bodies.length, 0);
    assert.deepEqual(await client.sendByFetch(' raw\n'), saved);
    assert.deepEqual(await client.sendByFetch({ group: 'notes', content: 'text' }), saved);
    assert.deepEqual(bodies, [' raw\n', '{"group":"notes","content":"text"}']);
    assert.equal(socket.sent.length, 0);
    assert.equal(hot.sent.length, 0);
});

test('sendByFetch keeps relative endpoints scheme-neutral and preserves explicit HTTP/HTTPS URLs', async (t) => {
    assert.equal(typeof client.sendByFetch, 'function');
    const inputs: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string) => {
        inputs.push(input);
        return new Response(JSON.stringify(saved));
    });
    assert.deepEqual(await client.sendByFetch('default'), saved);
    for (const endpoint of ['/proxy/upload', '//receiver.example/upload', 'http://receiver.example/upload', 'https://receiver.example/upload']) {
        const dispose = installClient({ endpoint });
        try {
            assert.deepEqual(await client.sendByFetch('configured'), saved);
        }
        finally { dispose(); }
    }
    assert.deepEqual(inputs, ['/device-data', '/proxy/upload', '//receiver.example/upload', 'http://receiver.example/upload', 'https://receiver.example/upload']);
    // 相对端点保留给浏览器 Fetch 解析, HTTP 页面和 HTTPS 页面不会被 SDK 强制改写协议.
    for (const protocol of ['http:', 'https:']) {
        for (const input of inputs.slice(0, 3)) assert.equal(new URL(input, `${protocol}//page.example/app/`).protocol, protocol);
    }
});

test('sendByFetch never switches to an available socket or HMR after an HTTP failure', async (t) => {
    assert.equal(typeof client.sendByFetch, 'function');
    const socket = new Socket();
    const hot = new Hot();
    let requests = 0;
    t.after(installClient({ socket, hot, request: async () => {
        requests++;
        throw new Error('HTTP failed');
    } }));
    await assert.rejects(client.sendByFetch('uncertain'), /HTTP failed/);
    assert.equal(requests, 1);
    assert.equal(socket.sent.length, 0);
    assert.equal(hot.sent.length, 0);
});

test('sendBySocket rejects missing or unavailable shared channels without using Fetch', async (t) => {
    assert.equal(typeof client.sendBySocket, 'function');
    const request = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(saved)));
    await assert.rejects(client.sendBySocket('no host'), /No shared socket or HMR channel is available/);
    const socket = Object.assign(new Socket(), { readyState: 0 });
    const hot = new Hot();
    const dispose = installClient({ socket, hot });
    t.after(dispose);
    hot.emit('vite:ws:disconnect');
    await assert.rejects(client.sendBySocket('connecting'), /No shared socket or HMR channel is available/);
    socket.readyState = 3;
    await assert.rejects(client.sendBySocket('closed'), /No shared socket or HMR channel is available/);
    assert.equal(request.mock.callCount(), 0);
    assert.equal(socket.sent.length, 0);
    assert.equal(hot.sent.length, 0);
});

test('sendBySocket selects an OPEN business connection before HMR and shares correlated error receipts', async (t) => {
    assert.equal(typeof client.sendBySocket, 'function');
    const socket = new Socket();
    const hot = new Hot();
    let requests = 0;
    t.after(installClient({ socket, hot, request: async () => {
        requests++;
        return new Response(JSON.stringify(saved));
    } }));
    t.after(installClient({ socket: Object.assign(new Socket(), { readyState: 3 }), token: 'latest' }));
    const first = client.sendBySocket('first');
    const second = client.sendBySocket({ group: 'notes', content: 'second' });
    assert.equal(socket.sent.length, 2);
    assert.equal(JSON.parse(socket.sent[0]!).token, 'latest');
    assert.equal(JSON.parse(socket.sent[1]!).text, '{"group":"notes","content":"second"}');
    const rejected = { ok: false, code: 1, error: { code: 'SERVER_BUSY', message: 'Busy' } };
    socket.reply(1, rejected);
    socket.reply(0);
    assert.deepEqual(await first, saved);
    assert.deepEqual(await second, rejected);
    assert.equal(hot.sent.length, 0);
    assert.equal(requests, 0);
});

test('sendBySocket reuses HMR, rejects while disconnected and resumes only after reconnect', async (t) => {
    assert.equal(typeof client.sendBySocket, 'function');
    const hot = new Hot();
    let requests = 0;
    t.after(installClient({ socket: Object.assign(new Socket(), { readyState: 3 }), hot, request: async () => {
        requests++;
        return new Response(JSON.stringify(saved));
    } }));
    const first = client.sendBySocket('HMR');
    const frame = hot.sent[0] as { id: string };
    hot.emit('message-transfer:receipt', { type: 'message-transfer:receipt', id: frame.id, receipt: saved });
    assert.deepEqual(await first, saved);
    const uncertain = assert.rejects(client.sendBySocket('in flight'), /disconnected/);
    hot.emit('vite:ws:disconnect');
    await uncertain;
    await assert.rejects(client.sendBySocket('offline'), /No shared socket or HMR channel is available/);
    hot.emit('vite:ws:connect');
    const next = client.sendBySocket('reconnected');
    const nextFrame = hot.sent[2] as { id: string };
    hot.emit('message-transfer:receipt', { type: 'message-transfer:receipt', id: nextFrame.id, receipt: saved });
    assert.deepEqual(await next, saved);
    assert.equal(hot.sent.length, 3);
    assert.equal(requests, 0);
});

for (const failure of ['throw', 'close', 'error', 'timeout', 'dispose'] as const) {
    test(`sendBySocket does not switch channels after ${failure}`, async (t) => {
        assert.equal(typeof client.sendBySocket, 'function');
        const socket = new Socket();
        const hot = new Hot();
        let requests = 0;
        const dispose = installClient({ socket, hot, timeoutMs: 10, request: async () => {
            requests++;
            return new Response(JSON.stringify(saved));
        } });
        t.after(dispose);
        if (failure === 'throw') {
            socket.send = () => {
                throw new Error('send failed');
            };
        }
        const rejected = assert.rejects(client.sendBySocket('uncertain'), /send failed|disconnected|timed out|disposed/);
        if (failure === 'close' || failure === 'error') socket.dispatchEvent(new Event(failure));
        if (failure === 'dispose') dispose();
        await rejected;
        assert.equal(socket.sent.length, failure === 'throw' ? 0 : 1);
        assert.equal(socket.readyState, 1, 'SDK must not close the host connection');
        assert.equal(hot.sent.length, 0);
        assert.equal(requests, 0);
    });
}

test('failed host installation removes partial listeners and keeps the previous host intact', async () => {
    const existing = new Socket();
    const dispose = installClient({ socket: existing });
    const failing = new Socket();
    const add = failing.addEventListener.bind(failing);
    failing.addEventListener = (type, listener, options) => {
        if (type === 'close') throw new Error('registration failed');
        add(type, listener, options);
    };
    try {
        const pending = send('before failed install');
        assert.throws(() => installClient({ socket: failing }), /registration failed/);
        existing.reply(0);
        assert.equal((await pending).ok, true);
        const next = send('after failed install');
        existing.reply(1);
        assert.equal((await next).ok, true);
        assert.equal(failing.sent.length, 0);
    }
    finally { dispose(); }
});

test('HTTP uses existing request function, token provider and exact original text or JSON', async () => {
    const bodies: unknown[] = [];
    const dispose = installClient({ endpoint: '/proxy', token: () => 'app', request: async (input, init) => {
        assert.equal(input, '/proxy');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer app');
        bodies.push(init?.body);
        return new Response(JSON.stringify(saved));
    } });
    try {
        await send(' raw\n');
        await send({ group: 'notes', content: 'text' });
    }
    finally { dispose(); }
    assert.deepEqual(bodies, [' raw\n', '{"group":"notes","content":"text"}']);
});

test('automatic priority finds OPEN business socket, correlates out-of-order replies and ignores other traffic', async () => {
    const socket = new Socket();
    const hot = new Hot();
    let calls = 0;
    const older = installClient({ socket, hot, request: async () => {
        calls++;
        return new Response('{}');
    } });
    const newer = installClient({ socket: Object.assign(new Socket(), { readyState: 3 }), token: 'latest' });
    try {
        const first = send('first');
        const second = send('second');
        assert.equal(socket.sent.length, 2);
        assert.equal(hot.sent.length, 0);
        assert.equal(JSON.parse(socket.sent[0]!).token, 'latest');
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(saved) }));
        socket.reply(1, { ...saved, bytes: 6 });
        socket.reply(0, { ...saved, bytes: 5 });
        assert.equal((await first as { bytes: number }).bytes, 5);
        assert.equal((await second as { bytes: number }).bytes, 6);
        assert.equal(calls, 0);
    }
    finally {
        older();
        newer();
    }
});

test('HMR is reused and known disconnect selects HTTP only for the next unsent message', async () => {
    const hot = new Hot();
    let calls = 0;
    const dispose = installClient({ hot, request: async () => {
        calls++;
        return new Response(JSON.stringify(saved));
    } });
    try {
        const result = send('hmr');
        const frame = hot.sent[0] as { id: string };
        hot.emit('message-transfer:receipt', { type: 'message-transfer:receipt', id: frame.id, receipt: saved });
        assert.equal((await result).ok, true);
        const uncertain = send('maybe');
        const rejected = assert.rejects(uncertain, /disconnect|closed/i);
        hot.emit('vite:ws:disconnect');
        await rejected;
        assert.equal(calls, 0, 'no fallback after dispatch');
        assert.equal((await send('new')).ok, true);
        assert.equal(calls, 1);
    }
    finally { dispose(); }
});

test('channel timeout and disposal never resend or close shared resources', async () => {
    const socket = new Socket();
    let business = 0;
    socket.addEventListener('message', () => business++);
    let calls = 0;
    const dispose = installClient({ socket, timeoutMs: 10, request: async () => {
        calls++;
        return new Response('{}');
    } });
    await assert.rejects(send('timeout'), /timed out/i);
    const pending = send('dispose');
    const rejected = assert.rejects(pending, /disposed/i);
    dispose();
    dispose();
    await rejected;
    assert.equal(socket.readyState, 1);
    socket.reply(0);
    assert.equal(business, 1);
    assert.equal(calls, 0);
});

test('HTTP custom requests that ignore abort still time out and disposal aborts pending calls', async () => {
    let signal: AbortSignal | undefined;
    const dispose = installClient({ timeoutMs: 10, request: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
    } });
    try {
        await assert.rejects(send('wait'), /timed out/i);
        assert.equal(signal?.aborted, true);
    }
    finally { dispose(); }
    const second = installClient({ request: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
    } });
    const pending = send('disposed');
    const rejected = assert.rejects(pending, /disposed/i);
    second();
    await rejected;
    assert.equal(signal?.aborted, true);
});

test('HTTP timeout cancels an unfinished response body even for a custom request wrapper', async () => {
    let cancelled = false;
    const dispose = installClient({ timeoutMs: 10, request: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; },
    })) });
    try {
        await assert.rejects(send('slow receipt'), /timed out/i);
        assert.equal(cancelled, true);
    }
    finally { dispose(); }
});

test('synchronous socket failure does not dispatch a fallback request', async () => {
    const socket = new Socket();
    socket.send = () => {
        throw new Error('send failed');
    };
    let requests = 0;
    const dispose = installClient({ socket, request: async () => {
        requests++;
        return new Response(JSON.stringify(saved));
    } });
    try {
        await assert.rejects(send('uncertain'), /send failed/);
        assert.equal(requests, 0);
    }
    finally { dispose(); }
});

test('all send helpers share a bounded pending count and malformed replies do not resolve success', async (t) => {
    assert.equal(typeof client.sendByFetch, 'function');
    assert.equal(typeof client.sendBySocket, 'function');
    const socket = new Socket();
    let requests = 0;
    const dispose = installClient({ socket, request: async () => {
        requests++;
        return new Promise<Response>(() => {});
    } });
    t.after(dispose);
    const helpers = [send, client.sendByFetch, client.sendBySocket];
    const pending = Array.from({ length: 128 }, (_, index) => helpers[index % helpers.length]!('pending'));
    const settled = Promise.allSettled(pending);
    for (const helper of helpers) await assert.rejects(helper('overflow'), /pending/i);
    assert.equal(requests, 43);
    assert.equal(socket.sent.length, 85);
    socket.reply(0, { ok: true, bytes: -1 });
    dispose();
    assert.ok((await settled).every((result) => result.status === 'rejected'));
});

test('invalid client values and receipts fail without retry; server rejection remains a Receipt', async () => {
    let calls = 0;
    const dispose = installClient({ request: async () => {
        calls++;
        return new Response(JSON.stringify({ ok: false, code: 1, error: { code: 'SERVER_BUSY', message: 'Busy' } }), { status: 503 });
    } });
    try {
        await assert.rejects(send({ content: '\uD800' }));
        await assert.rejects(send(null as never));
        assert.equal(calls, 0);
        assert.equal((await send('valid')).ok, false);
        assert.equal(calls, 1);
    }
    finally { dispose(); }
});
