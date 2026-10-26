import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

/** 页面事件测试的最小 DOM 控件, 不模拟 SDK 的传输选择逻辑. */
class Element extends EventTarget {
    /** 用户输入值. */
    value = '';
    /** 文件输入的测试选择, 不访问任何用户磁盘文件. */
    files: File[] = [];
    /** 单选项是否被选中. */
    checked = false;
    /** 单选组的子控件, 仅模拟真实 DOM 查询边界. */
    children: Element[] = [];
    /** 是否禁用当前控件或整个 fieldset. */
    disabled = false;
    /** 是否隐藏业务连接按钮. */
    hidden = false;
    /** 以纯文本展示的结果. */
    textContent = '';

    /** 查询单选组当前值. @param {string} selector 页面实际使用的单选项选择器. */
    querySelector(selector: string): Element | null {
        assert.equal(selector, 'input[name="format"]:checked');
        return this.children.find((child) => child.checked) ?? null;
    }
}

/** 测试主动完成 SDK 回执. @param {unknown} value 模拟返回的完整回执. */
type Complete = (value: unknown) => void;
/** 测试主动拒绝 SDK 等待. @param {Error} error 模拟网络或生命周期异常. */
type Fail = (error: Error) => void;
/** 示例宿主的状态回调. @param {string} text 纯文本连接提示. */
type Report = (text: string) => void;

/**
 * 执行实际页面脚本, 仅替代 SDK, 示例宿主工厂和浏览器 DOM 边界.
 * @param {string} href 模拟页面协议, file 页面不能发送.
 * @param {boolean} business 是否由 Node demo 声明同源业务连接.
 * @param {boolean} hot 是否模拟 Vite HMR 环境.
 */
async function page(href = 'http://localhost:8788/sender.html', business = false, hot = false) {
    const elements = new Map<string, Element>();
    for (const id of ['token', 'send', 'method', 'status', 'receipts', 'group', 'name', 'content', 'format', 'format-json', 'format-raw', 'format-file', 'file', 'file-controls', 'content-label', 'message-form', 'socket-controls', 'connection-status', 'connect', 'disconnect']) {
        elements.set(id, new Element());
    }
    const formats = ['json', 'raw', 'file'].map((value) => {
        const radio = elements.get(`format-${value}`)!;
        radio.value = value;
        radio.checked = value === 'json';
        return radio;
    });
    elements.get('format')!.children = formats;
    elements.get('method')!.value = 'send';
    elements.get('socket-controls')!.hidden = true;
    const calls: { method: string; value: unknown }[] = [];
    let resolve!: Complete;
    let reject!: Fail;
    let tokenProvider!: () => string | undefined;
    let disposed = 0;
    let hosts = 0;
    let connects = 0;
    let disconnects = 0;
    let hostDisposed = 0;
    let hotDispose: (() => void) | undefined;
    const source = await readFile(new URL('../examples/sender.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new WebSocket|channel:|transport:/);
    assert.match(source, /import\s+\{\s*send,\s*sendByFetch,\s*sendBySocket\s*\}/);
    const window = new EventTarget();
    const methods = Object.fromEntries(['send', 'sendByFetch', 'sendBySocket'].map((method) => [method, (value: unknown) => {
        calls.push({ method, value });
        return new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
    }]));
    runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.hot', '__hotContext'), {
        document: { getElementById: (id: string) => elements.get(id), body: { dataset: { businessSocket: business ? 'true' : '' } } },
        location: new URL(href),
        window,
        __hotContext: hot ? { dispose(callback: () => void) { hotDispose = callback; } } : undefined,
        ...methods,
        installClient: (options: { token: () => string | undefined }) => {
            tokenProvider = options.token;
            return () => {
                disposed++;
            };
        },
        createDemoSocket: (report: Report) => {
            hosts++;
            report('WS 已连接');
            return {
                connect() { connects++; },
                disconnect() { disconnects++; },
                dispose() { hostDisposed++; },
            };
        },
    });
    const flush = () => new Promise((done) => setImmediate(done));
    return {
        calls,
        window,
        token: () => tokenProvider(),
        resources: () => ({ disposed, hosts, connects, disconnects, hostDisposed }),
        hotDispose: () => hotDispose?.(),
        get: (id: string) => elements.get(id)!,
        chooseFormat: (value: string) => {
            for (const radio of formats) radio.checked = radio.value === value;
            elements.get('format')!.dispatchEvent(new Event('change'));
        },
        settle: async (value: unknown) => {
            resolve(value);
            await flush();
        },
        fail: async (message = 'timeout') => {
            reject(new Error(message));
            await flush();
        },
    };
}

test('sender exposes the three formats as a labelled native radio group with JSON selected', async () => {
    const html = await readFile(new URL('../examples/sender.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<select\b[^>]+id="format"/);
    const fieldset = /<fieldset\b[^>]+id="format"[^>]*>([\s\S]*?)<\/fieldset>/.exec(html)?.[1];
    assert.ok(fieldset);
    assert.match(fieldset, /<legend>消息格式<\/legend>/);
    for (const value of ['json', 'raw', 'file']) {
        const input: string | undefined = new RegExp(`<input\\b[^>]+id="format-${value}"[^>]*>`).exec(fieldset)?.[0];
        assert.ok(input);
        assert.match(input, /type="radio"/);
        assert.match(input, /name="format"/);
        assert.ok(input.includes(`value="${value}"`));
        assert.equal(/\bchecked\b/.test(input), value === 'json');
    }
});

test('radio changes switch file and text controls without leaking a file into text messages', async () => {
    const app = await page();
    assert.equal(app.get('format-json').checked, true);
    assert.equal(app.get('file-controls').hidden, true);
    assert.equal(app.get('content-label').hidden, false);
    app.chooseFormat('file');
    app.get('file').files = [new File(['bytes'], 'report.xlsx')];
    assert.equal(app.get('file-controls').hidden, false);
    assert.equal(app.get('content').disabled, true);
    assert.equal(app.get('group').disabled, false);
    app.chooseFormat('raw');
    assert.equal(app.get('file-controls').hidden, true);
    assert.equal(app.get('file').disabled, true);
    assert.equal(app.get('group').disabled, true);
    assert.equal(app.get('content').disabled, false);
    app.chooseFormat('json');
    assert.equal(app.get('group').disabled, false);
    app.get('content').value = 'text';
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(JSON.stringify(app.calls[0]!.value), '{"group":"","content":"text"}');
    await app.settle({ ok: true, code: 0, date: '20261007', groupDirectory: '', group: '', file: 'text.txt', bytes: 4 });
});

for (const method of ['send', 'sendByFetch', 'sendBySocket']) {
    test(`sender uploads the selected original file using only ${method}`, async () => {
        const app = await page();
        app.get('method').value = method;
        app.chooseFormat('file');
        assert.equal(app.get('file-controls').hidden, false);
        assert.equal(app.get('content-label').hidden, true);
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls.length, 0);
        assert.match(app.get('status').textContent, /选择.*文件/);
        const file = new File([new Uint8Array([255, 0, 80, 75])], '表格.xlsx');
        app.get('file').files = [file];
        app.get('group').value = 'files';
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls[0]!.method, method);
        assert.equal((app.calls[0]!.value as { file: File }).file, file);
        assert.equal((app.calls[0]!.value as { group: string }).group, 'files');
        assert.equal(app.get('file').disabled, true);
        assert.equal(app.get('format').disabled, true);
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls.length, 1);
        await app.settle({ ok: true, code: 0, date: '20261007', groupDirectory: 'files', kind: 'file', group: 'files', file: 'safe.xlsx', originalName: '表格.xlsx', bytes: 4, sha256: 'a'.repeat(64) });
        assert.match(app.get('status').textContent, /safe.xlsx/);
        assert.doesNotMatch(app.get('status').textContent, /追加/);
        assert.equal(app.get('file').disabled, false);
        assert.equal(app.get('format').disabled, false);
    });
    test(`sender calls only ${method} with structured or raw data and prevents double submission`, async () => {
        const app = await page();
        app.get('method').value = method;
        app.get('group').value = 'notes';
        app.get('content').value = 'first';
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls[0]!.method, method);
        assert.equal(JSON.stringify(app.calls[0]!.value), '{"group":"notes","content":"first"}');
        for (const id of ['send', 'token', 'method']) assert.equal(app.get(id).disabled, true);
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls.length, 1);
        await app.settle({ ok: true, code: 0, date: '20261007', groupDirectory: 'notes', group: 'notes', file: 'default.txt', bytes: 5 });
        assert.match(app.get('receipts').textContent, /20261007\/notes\/default\.txt/);
        assert.ok(app.get('receipts').textContent.includes(method));
        assert.match(app.get('status').textContent, /Directory/);
        app.chooseFormat('raw');
        assert.equal(app.get('group').disabled, true);
        app.get('content').value = ' raw\n';
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.deepEqual(app.calls[1], { method, value: ' raw\n' });
        await app.settle({ ok: true, code: 0, date: '20261007', groupDirectory: '', group: '', file: 'default.txt', bytes: 5 });
    });
}

for (const method of ['send', 'sendByFetch', 'sendBySocket']) {
    test(`sender passes an independent name through ${method} and disables it for raw text`, async () => {
        const html = await readFile(new URL('../examples/sender.html', import.meta.url), 'utf8');
        assert.match(html, /<input\b[^>]+id="name"/);
        const app = await page();
        app.get('method').value = method;
        app.get('group').value = '工作';
        app.get('name').value = 'notes.txt';
        app.get('content').value = 'text';
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal((app.calls[0]!.value as { name: string }).name, 'notes.txt');
        assert.equal(app.get('name').disabled, true);
        await app.settle({ ok: true, code: 0, date: '20261024', groupDirectory: '工作', group: '工作', file: 'notes.txt', bytes: 4 });
        assert.match(app.get('status').textContent, /20261024\/工作\/notes\.txt/);
        assert.equal(app.get('name').disabled, false);
        app.chooseFormat('file');
        const file = new File(['bytes'], 'original.xlsx');
        app.get('file').files = [file];
        app.get('name').value = 'override.xlsx';
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal((app.calls[1]!.value as { name: string }).name, 'override.xlsx');
        assert.equal((app.calls[1]!.value as { file: File }).file, file);
        await app.settle({ ok: false, code: 1, error: { code: 'FILE_NAME_CONFLICT', message: 'Filename occupied.' } });
        assert.match(app.get('status').textContent, /code: 1.*FILE_NAME_CONFLICT.*Filename occupied/);
        app.chooseFormat('raw');
        assert.equal(app.get('name').disabled, true);
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        assert.equal(app.calls[2]!.value, 'text');
        await app.fail();
        app.window.dispatchEvent(new Event('pagehide'));
        assert.equal(app.get('name').disabled, true);
    });
}

test('sender reports an unavailable socket as not sent, never falling back to Fetch', async () => {
    const app = await page();
    app.get('method').value = 'sendBySocket';
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await app.fail('No shared socket or HMR channel is available.');
    assert.match(app.get('status').textContent, /未发送/);
    assert.match(app.get('status').textContent, /HTTP/);
    assert.doesNotMatch(app.get('status').textContent, /可能已保存/);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0]!.method, 'sendBySocket');
    assert.equal(app.get('send').disabled, false);
});

test('sender reports uncertain delivery without resending or hiding Origin diagnostics', async () => {
    const app = await page();
    app.get('content').value = 'text';
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await app.fail();
    assert.match(app.get('status').textContent, /可能已保存/);
    assert.match(app.get('status').textContent, /Origin/);
    assert.equal(app.calls.length, 1);
    assert.equal(app.get('send').disabled, false);
});

test('sender registers current token values and only creates an explicitly configured demo socket', async () => {
    const app = await page('https://localhost:8789/sender.html', true);
    assert.equal(app.get('socket-controls').hidden, false);
    assert.equal(app.resources().hosts, 1);
    app.get('token').value = 'first';
    assert.equal(app.token(), 'first');
    app.get('token').value = 'second';
    assert.equal(app.token(), 'second');
    app.get('connect').dispatchEvent(new Event('click'));
    app.get('disconnect').dispatchEvent(new Event('click'));
    assert.equal(app.resources().connects, 1);
    assert.equal(app.resources().disconnects, 1);
    app.window.dispatchEvent(new Event('pagehide'));
    app.window.dispatchEvent(new Event('pagehide'));
    assert.equal(app.resources().disposed, 1);
    assert.equal(app.resources().hostDisposed, 1);
    assert.equal(app.get('send').disabled, true);
    assert.equal(app.get('format').disabled, true);
});

test('Vite page describes HMR and cleans only its own context on hot disposal', async () => {
    const app = await page('http://localhost:5174/sender.html', false, true);
    assert.equal(app.resources().hosts, 0);
    assert.equal(app.get('socket-controls').hidden, true);
    assert.match(app.get('connection-status').textContent, /HMR/);
    app.hotDispose();
    app.window.dispatchEvent(new Event('pagehide'));
    assert.equal(app.resources().disposed, 1);
    assert.equal(app.resources().hostDisposed, 0);
});

test('sender stays disposed when an in-flight request later settles', async () => {
    const app = await page();
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    app.window.dispatchEvent(new Event('pagehide'));
    await app.fail();
    assert.equal(app.get('send').disabled, true);
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(app.calls.length, 1);
});

test('sender explains file URL failures without installing a business socket or attempting a send', async () => {
    const app = await page('file:///tmp/sender.html', true);
    app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(app.calls.length, 0);
    assert.equal(app.resources().hosts, 0);
    assert.equal(app.get('send').disabled, true);
    assert.match(app.get('status').textContent, /pnpm demo:/);
});

test('sender safely displays error receipts and retains only the latest thirty results', async () => {
    const app = await page();
    for (let index = 0; index < 31; index++) {
        app.get('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await app.settle({ ok: false, code: 1, error: { code: 'INVALID_MESSAGE', message: `<b>receipt-${index}</b>` } });
    }
    assert.equal(app.calls.length, 31);
    assert.ok(app.get('receipts').textContent.includes('<b>receipt-30</b>'));
    assert.ok(!app.get('receipts').textContent.includes('<b>receipt-0</b>'));
    assert.equal(app.get('receipts').textContent.split('INVALID_MESSAGE').length - 1, 60);
});
