import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { readdir, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { closeDemoServer, createSenderServer } from '../examples/demo-utils.js';
import { clientFile, sendSharedFile } from '../src/client-files.js';
import { FILE_REQUEST, isFileSuccess } from '../src/file-protocol.js';
import { validUnicode } from '../src/names.js';
import { fixture, listen, receiptPath, tempDirectory } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeRead = Blob.prototype.arrayBuffer;

/** Node 没有 FileReader, 仅在这个 DOM 边界替代事件 API, 仍读取实际 Blob 字节. */
class Reader {
    static instances: Reader[] = [];
    result: ArrayBuffer | string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;
    size = 0;

    constructor() {
        Reader.instances.push(this);
    }

    /** 只允许 SDK 读取有界切片, 不能把整文件交给替身. @param {Blob} blob SDK 当前读取的切片. */
    readAsArrayBuffer(blob: Blob): void {
        this.size = blob.size;
        assert.ok(blob.size <= 65536, 'FileReader must only receive bounded slices');
        void nativeRead.call(blob).then((result) => {
            if (this.aborted) return;
            this.result = result;
            this.onload?.();
        });
    }

    /** 模拟本地读取取消, 不触碰远端连接. */
    abort(): void {
        this.aborted = true;
        this.onabort?.();
    }
}

/**
 * 仅为当前测试安装缺失的 DOM API, 测试结束恢复所有全局状态.
 * @param {TestContext} t 当前测试的资源清理上下文.
 * @param {typeof Reader} reader 当前测试所需的 FileReader 行为.
 */
function installReader(t: TestContext, reader: typeof Reader = Reader): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
    Reader.instances = [];
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: reader });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'FileReader', previous);
        else Reflect.deleteProperty(globalThis, 'FileReader');
    });
}

/** 隐藏较新的 Blob API, 保持真实的原始字节和原生品牌检查. @param {Uint8Array<ArrayBuffer>} bytes 当前测试的完整文件. */
function basicFile(bytes: Uint8Array<ArrayBuffer>): File {
    const file = new File([bytes], 'compat.bin');
    const slice = file.slice.bind(file);
    file.slice = (...args) => Object.defineProperty(slice(...args), 'arrayBuffer', { value: undefined });
    return file;
}

/** 使用真实接收器和文件存储, 只在共享消息调用边界省去网络. @param {TestContext} t 当前测试的资源清理上下文. */
async function channel(t: TestContext) {
    const { receiver, directory } = await fixture(t);
    const request = { headers: { host: 'local.test', origin: 'http://local.test' }, url: '/business' } as IncomingMessage;
    const frames: Record<string, unknown>[] = [];
    const cleaning: Promise<unknown>[] = [];
    let seq = 0;
    const rpc = async (frame: Record<string, unknown>) => {
        frames.push(frame);
        const reply = await receiver.handleSharedMessage({ ...frame, type: FILE_REQUEST, id: 'compat', seq: seq++ }, request);
        assert.ok(reply);
        return reply.receipt;
    };
    return {
        receiver,
        directory,
        frames,
        rpc,
        abort: (uploadId: string) => { cleaning.push(rpc({ action: 'abort', uploadId })); },
        drain: () => Promise.all(cleaning),
    };
}

test('shared files work without AbortSignal.throwIfAborted and preserve original bytes', async (t) => {
    const host = await channel(t);
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const result = await sendSharedFile(clientFile(new File([bytes], 'signal.bin'))!, host.rpc, host.abort, controller.signal);
    assert.ok(isFileSuccess(result));
    assert.deepEqual(await readFile(receiptPath(host.directory, result)), Buffer.from(bytes));
    assert.deepEqual(host.frames.map((frame) => frame.action), ['start', 'chunk', 'finish']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('FileReader fallback reads only 64 KiB slices and releases its listeners after success', async (t) => {
    installReader(t);
    const host = await channel(t);
    const controller = new AbortController();
    const bytes = new Uint8Array(65537).fill(0xAF);
    const result = await sendSharedFile(clientFile(basicFile(bytes))!, host.rpc, host.abort, controller.signal);
    assert.ok(isFileSuccess(result));
    assert.deepEqual(await readFile(receiptPath(host.directory, result)), Buffer.from(bytes));
    assert.deepEqual(Reader.instances.map((reader) => reader.size), [65536, 1]);
    for (const reader of Reader.instances) {
        assert.equal(reader.onload, null);
        assert.equal(reader.onerror, null);
        assert.equal(reader.onabort, null);
    }
    assert.deepEqual(host.frames.map((frame) => frame.action), ['start', 'chunk', 'chunk', 'finish']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const mode of ['throw', 'error', 'empty-result'] as const) {
    test(`FileReader ${mode} fails safely and cancels the known upload without sending a chunk`, async (t) => {
        class FailedReader extends Reader {
            /** 模拟 DOM 读取边界的同步或异步失败. @param {Blob} _blob 当前待读取的有界切片. */
            override readAsArrayBuffer(_blob: Blob): void {
                if (mode === 'throw') throw new Error('File read failed.');
                queueMicrotask(() => {
                    if (mode === 'error') {
                        this.error = new Error('File read failed.');
                        this.onerror?.();
                    }
                    else {
                        this.onload?.();
                    }
                });
            }
        }
        installReader(t, FailedReader);
        const host = await channel(t);
        const controller = new AbortController();
        await assert.rejects(sendSharedFile(clientFile(basicFile(new Uint8Array([1])))!, host.rpc, host.abort, controller.signal), /read/i);
        await host.drain();
        assert.deepEqual(host.frames.map((frame) => frame.action), ['start', 'abort']);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        for (const reader of Reader.instances) {
            assert.equal(reader.onload, null);
            assert.equal(reader.onerror, null);
            assert.equal(reader.onabort, null);
        }
        const [date] = await readdir(host.directory);
        assert.deepEqual(await readdir(join(host.directory, date!)), []);
    });
}

test('cancelling a FileReader read stops local work and aborts the upload exactly once', { timeout: 5000 }, async (t) => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    class HeldReader extends Reader {
        /** 保持读取在途, 由测试通过真实 AbortSignal 取消. @param {Blob} _blob 当前待读取的有界切片. */
        override readAsArrayBuffer(_blob: Blob): void {
            enter();
        }
    }
    installReader(t, HeldReader);
    const host = await channel(t);
    const controller = new AbortController();
    const pending = sendSharedFile(clientFile(basicFile(new Uint8Array([255])))!, host.rpc, host.abort, controller.signal);
    await Promise.race([entered, pending.then(() => assert.fail('Read should remain pending'))]);
    const rejected = assert.rejects(pending, /cancel|abort/i);
    controller.abort();
    await rejected;
    await host.drain();
    assert.equal(Reader.instances.length, 1);
    assert.equal(Reader.instances[0]!.aborted, true);
    assert.equal(Reader.instances[0]!.onload, null);
    assert.equal(Reader.instances[0]!.onerror, null);
    assert.equal(Reader.instances[0]!.onabort, null);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(host.frames.map((frame) => frame.action), ['start', 'abort']);
});

test('an already cancelled basic signal rejects before any file request', async (t) => {
    const host = await channel(t);
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    controller.abort();
    await assert.rejects(sendSharedFile(clientFile(new Blob([]))!, host.rpc, host.abort, controller.signal), /File transfer cancelled/);
    assert.deepEqual(host.frames, []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('portable Unicode validation matches lossless UTF-8 for surrogate boundaries', () => {
    const units = [0, 0x41, 0xD7FF, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xE000, 0xFFFF];
    const values = ['', '中文 😀', ...units.map((unit) => String.fromCharCode(unit))];
    for (const a of units) {
        for (const b of units) {
            for (const c of units) values.push(String.fromCharCode(a, b, c));
        }
    }
    for (const value of values) assert.equal(validUnicode(value), Buffer.from(value, 'utf8').toString('utf8') === value);
});

/** 检查发布的浏览器模块, 避免最低目标不能解析的语法回归. @param {string} file 当前模块名. @param {string} text 实际发给浏览器的 JavaScript. */
function portableSyntax(file: string, text: string): void {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const unsupported: string[] = [];
    /** @param {ts.Node} node 当前检查的 JavaScript 语法节点. */
    function visit(node: ts.Node): void {
        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) {
            unsupported.push('optional chaining');
        }
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind)) {
            unsupported.push('new logical operator');
        }
        if (ts.isPropertyDeclaration(node) || ts.isPrivateIdentifier(node)) unsupported.push('class field');
        if (ts.isRegularExpressionLiteral(node) && /\(\?<[=!]/.test(node.getText(source))) unsupported.push('regexp lookbehind');
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ['at', 'replaceAll', 'findLast', 'toSorted', 'throwIfAborted'].includes(node.expression.name.text)) {
            unsupported.push(node.expression.name.text);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.deepEqual(unsupported, [], file);
}

test('browser dependency graph is built to ES2019 without lowering the Node build target', { timeout: 30000 }, async (t) => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.build, /tsconfig\.browser\.json/);
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    for (const config of ['tsconfig.build.json', 'tsconfig.browser.json']) {
        await promisify(execFile)(process.execPath, [tsc, '-p', join(root, config), '--outDir', directory]);
    }
    const pending = ['client.js', 'client-host.js'];
    const visited = new Set<string>();
    while (pending.length) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        const text = await readFile(join(directory, file), 'utf8');
        portableSyntax(file, text);
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        for (const statement of source.statements) {
            if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
            assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
            const path = statement.moduleSpecifier.text;
            assert.match(path, /^\.\/[^/]+\.js$/);
            pending.push(path.slice(2));
        }
    }
    assert.ok(visited.has('client-files.js'));
    assert.ok(visited.has('names.js'));
    assert.ok(visited.has('content.js'));
    assert.match(await readFile(join(directory, 'storage-path.js'), 'utf8'), /1n/, 'Node-only code retains its supported runtime features');
});

test('browser-facing sources avoid unsupported regex and demo syntax', async () => {
    for (const file of ['examples/sender.js', 'examples/sender-host.js']) portableSyntax(file, await readFile(join(root, file), 'utf8'));
    for (const file of ['src/client-runtime.ts', 'src/names.ts', 'src/content.ts']) {
        assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /\(\?<[=!]/, file);
    }
});

test('sender keeps radio spacing and receipt wrapping without newer CSS support', async () => {
    const html = await readFile(join(root, 'examples/sender.html'), 'utf8');
    assert.match(html, /\.radio-group input\s*\{[^}]*margin:\s*0 0\.5rem 0 0;/);
    assert.match(html, /pre\s*\{[^}]*overflow-wrap:\s*break-word;[^}]*overflow-wrap:\s*anywhere;/);
});

test('sender wraps long file hashes and names in the status message on narrow screens', async () => {
    const html = await readFile(join(root, 'examples/sender.html'), 'utf8');
    assert.match(html, /#status\s*\{[^}]*overflow-wrap:\s*break-word;/);
});

test('Node sender scripts resolve SDK modules without native import maps', async (t) => {
    const host = await createSenderServer();
    t.after(() => closeDemoServer(host));
    const port = await listen(host);
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(`${base}/sender.html`)).text();
    assert.doesNotMatch(page, /type=["']importmap["']/);
    for (const file of ['sender.js', 'sender-host.js']) {
        const text = await (await fetch(`${base}/${file}`)).text();
        portableSyntax(file, text);
        assert.doesNotMatch(text, /from\s*['"]@xiaohaih\/message-transfer-plugin\//);
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement)) continue;
            assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
            const path = statement.moduleSpecifier.text;
            assert.match(path, /^(?:\.\/|\/)/);
            const response = await fetch(new URL(path, `${base}/${file}`));
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') ?? '', /javascript/);
        }
    }
});
