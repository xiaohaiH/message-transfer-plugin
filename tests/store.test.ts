import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { localDate } from '../src/filenames.js';
import { GroupedStore } from '../src/store.js';
import { receiptPath, tempDirectory } from './helpers.js';

/** @param {TestContext} t 注册测试目录清理的上下文. */
async function directory(t: TestContext) {
    const path = await tempDirectory();
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

/** 生成已规范化的测试文本, 默认独立名称固定为 default.txt. @param {string} group 分组目录. @param {string} content 正文. */
function message(group: string, content: string) {
    return { group, name: 'default.txt', content };
}

test('appends the same group and name without a separator when autoNewline is disabled', async (t) => {
    const dir = await directory(t);
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024, autoNewline: false });
    await store.prepare();
    const first = await store.append(message('notes', '你好\n'));
    const second = await store.append(message('notes', 'world'));
    assert.equal(receiptPath(dir, first), receiptPath(dir, second));
    assert.equal(first.bytes, 7);
    assert.equal(first.group, 'notes');
    assert.equal(first.file, 'default.txt');
    assert.equal(await readFile(receiptPath(dir, first), 'utf8'), '你好\nworld');
    assert.deepEqual(await readdir(dir), [first.date]);
});

test('isolates group directories and reuses text ownership after recreating the store', async (t) => {
    const dir = await directory(t);
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024 });
    await store.prepare();
    const a = await store.append(message('a', 'one'));
    const b = await store.append(message('b', 'two'));
    const ungrouped = await store.append(message('', ''));
    assert.notEqual(receiptPath(dir, a), receiptPath(dir, b));
    assert.equal(ungrouped.groupDirectory, '');
    const restarted = new GroupedStore({ directory: dir, maxContentBytes: 1024 });
    const again = await restarted.append(message('a', 'three'));
    assert.equal(receiptPath(dir, again), receiptPath(dir, a));
    assert.equal(await readFile(receiptPath(dir, a), 'utf8'), 'one\nthree\n');
    assert.equal(await readFile(receiptPath(dir, b), 'utf8'), 'two\n');
    assert.equal(ungrouped.bytes, 1);
    assert.equal(await readFile(receiptPath(dir, ungrouped), 'utf8'), '\n');
});

test('creates nested roots and encodes groups into one safe directory component', async (t) => {
    const root = await directory(t);
    const dir = join(root, 'nested', 'received');
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024 });
    await store.prepare();
    const saved = await store.append(message('../../escape/C:\\file\u0000', 'safe'));
    assert.equal(basename(saved.groupDirectory), saved.groupDirectory);
    assert.doesNotMatch(saved.groupDirectory, /[\\/\0]/u);
    assert.deepEqual(await readdir(root), ['nested']);
    assert.equal(await readFile(receiptPath(dir, saved), 'utf8'), 'safe\n');
});

test('preserves same-group receipt order before asynchronous processing', async (t) => {
    const dir = await directory(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const calls: string[] = [];
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024, processContent: async (content, context) => {
        assert.equal(context.group, 'a');
        assert.equal(context.groupDirectory, 'a');
        assert.ok(context.receivedAt instanceof Date);
        calls.push(content);
        if (content === 'first') await gate;
        return content.toUpperCase();
    } });
    const first = store.append(message('a', 'first'));
    const second = store.append(message('a', 'second'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['first']);
    release();
    const [saved] = await Promise.all([first, second]);
    await store.drain();
    assert.equal(await readFile(receiptPath(dir, saved), 'utf8'), 'FIRST\nSECOND\n');
});

test('a blocked group does not block another group', async (t) => {
    const dir = await directory(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024, processContent: async (content, { group }) => {
        if (group === 'a') await gate;
        return content;
    } });
    const blocked = store.append(message('a', 'a'));
    t.after(() => release());
    assert.equal((await store.append(message('b', 'b'))).group, 'b');
    release();
    await blocked;
});

test('recovers the queue after hook failure without saving that message', async (t) => {
    const dir = await directory(t);
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024, processContent: (content) => {
        if (content === 'bad') throw new Error('private detail');
        return content;
    } });
    const rejected = store.append(message('a', 'bad'));
    const next = store.append(message('a', 'good'));
    await assert.rejects(rejected, { code: 'PROCESSING_FAILED' });
    assert.equal(await readFile(receiptPath(dir, await next), 'utf8'), 'good\n');
});

test('rejects oversized transformed content before creating directories or files', async (t) => {
    const dir = await directory(t);
    const store = new GroupedStore({ directory: dir, maxContentBytes: 4, processContent: () => '中文' });
    await assert.rejects(store.append(message('a', 'x')), { code: 'MESSAGE_TOO_LARGE' });
    assert.deepEqual(await readdir(dir), []);
});

test('arrival date is fixed before a queued hook crosses midnight', async (t) => {
    const dir = await directory(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024, processContent: async (content) => {
        if (content === 'before') await gate;
        return content;
    } });
    const before = store.append(message('notes', 'before'), new Date(2026, 8, 28, 23, 59, 59));
    const after = store.append(message('notes', 'after'), new Date(2026, 8, 29, 0, 0, 1));
    release();
    const results = await Promise.all([before, after]);
    assert.equal(results[0]!.date, '20260928');
    assert.equal(results[1]!.date, '20260929');
    assert.equal(await readFile(receiptPath(dir, results[0]!), 'utf8'), 'before\n');
    assert.equal(await readFile(receiptPath(dir, results[1]!), 'utf8'), 'after\n');
});

test('reports a root that is actually a file at startup', async (t) => {
    const dir = await directory(t);
    const file = join(dir, 'not-a-directory');
    await writeFile(file, 'x');
    const store = new GroupedStore({ directory: file, maxContentBytes: 1024 });
    await assert.rejects(store.prepare(), { code: 'DIRECTORY_UNAVAILABLE' });
});

test('refuses a non-regular target and keeps the queue usable after failure', async (t) => {
    const dir = await directory(t);
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024 });
    const file = join(dir, localDate(new Date()), 'default.txt');
    await mkdir(file, { recursive: true });
    await assert.rejects(store.append(message('', 'bad')), { code: 'WRITE_FAILED' });
    await rm(file, { recursive: true });
    await store.append(message('', 'good'));
    assert.equal(await readFile(file, 'utf8'), 'good\n');
});

test('refuses a symbolic-link target', async (t) => {
    const dir = await directory(t);
    const target = join(dir, 'outside.txt');
    await writeFile(target, 'untouched');
    await mkdir(join(dir, localDate(new Date())));
    try {
        await symlink(target, join(dir, localDate(new Date()), 'default.txt'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating symlinks requires Windows Developer Mode or administrator permission');
        return;
    }
    const store = new GroupedStore({ directory: dir, maxContentBytes: 1024 });
    await assert.rejects(store.append(message('', 'bad')), { code: 'WRITE_FAILED' });
    assert.equal(await readFile(target, 'utf8'), 'untouched');
});
