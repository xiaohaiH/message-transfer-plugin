import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveOptions } from '../src/config.js';
import { isFileSuccess } from '../src/file-protocol.js';
import { FileStore } from '../src/file-store.js';
import { localDate } from '../src/filenames.js';
import { GroupedStore } from '../src/store.js';
import type { ReceiverOptions } from '../src/types.js';
import { tempDirectory } from './helpers.js';

/**
 * 只在测试独占目录创建文件会话, 清理不遍历用户接收目录.
 * @param {TestContext} t 注册测试资源清理的上下文.
 * @param {ReceiverOptions} options 本次测试覆盖的容量和超时限制.
 */
async function fixture(t: TestContext, options: ReceiverOptions = {}) {
    const root = await tempDirectory();
    // 本文件的 directory 是日期输出目录, root 才是实例配置根目录.
    const directory = join(root, localDate(new Date()));
    await mkdir(directory);
    const store = new FileStore(resolveOptions({ directory: root, ...options }));
    t.after(async () => {
        await store.dispose();
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return { store, root, directory, owner: {} };
}

test('file defaults allow 100 MiB independently of the unchanged text and buffer limits', () => {
    const options = resolveOptions();
    assert.equal(options.maxFileBytes, 100 * 1024 * 1024);
    assert.equal(options.maxPayloadBytes, 10 * 1024 * 1024);
    assert.equal(options.maxPendingBytes, 32 * 1024 * 1024);
    assert.equal(options.maxFileTransfers, 4);
    assert.equal(options.fileTransferTimeoutMs, 300000);
    for (const key of ['maxFileBytes', 'maxFileTransfers', 'fileTransferTimeoutMs']) {
        for (const value of [0, -1, 1.2, Number.NaN]) assert.throws(() => resolveOptions({ [key]: value }), /positive safe integer/);
    }
    assert.throws(() => resolveOptions({ fileTransferTimeoutMs: 2147483648 }), /timer limit/);
});

test('file store keeps exact binary bytes, publishes only complete files and never appends or overwrites', async (t) => {
    const { store, owner, directory: daily } = await fixture(t);
    const directory = join(daily, '文档');
    const names: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const data = Buffer.from([0, 255, 128, 10, 13, attempt, 80, 75]);
        const started = await store.begin(owner, { name: '报表.xlsx', group: '文档', size: data.length });
        assert.equal(started.step, 'ready');
        assert.equal(started.chunkBytes, 65536);
        const entries = await readdir(directory);
        const temporary = entries.filter((name) => name.startsWith('.message-transfer-upload-'));
        assert.equal(temporary.length, 1);
        assert.deepEqual(entries.sort(), [...names, ...temporary, ...(attempt === 0 ? [] : ['.message-transfer-files'])].sort());
        const first = await store.append(owner, started.uploadId, 0, data.subarray(0, 3));
        assert.equal(first.offset, 3);
        await store.append(owner, started.uploadId, 3, data.subarray(3));
        const saved = await store.finish(owner, started.uploadId);
        assert.equal(saved.ok, true);
        assert.equal(saved.kind, 'file');
        assert.equal(saved.originalName, '报表.xlsx');
        assert.equal(saved.group, '文档');
        assert.equal(saved.bytes, data.length);
        assert.equal(saved.sha256, createHash('sha256').update(data).digest('hex'));
        assert.equal(saved.file, attempt === 0 ? '报表.xlsx' : '报表(1).xlsx');
        assert.match(saved.file, /\.xlsx$/);
        assert.doesNotMatch(saved.file, /[\\/:]/);
        assert.ok(Buffer.byteLength(saved.file) <= 240);
        assert.deepEqual(await readFile(join(directory, saved.file)), data);
        names.push(saved.file);
    }
    assert.notEqual(names[0], names[1]);
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', ...names].sort());
});

test('ungrouped files preserve readable original names and number duplicates before the extension', async (t) => {
    const { store, owner, directory } = await fixture(t);
    for (const [name, duplicate] of [
        ['报告 Q4.xlsx', '报告 Q4(1).xlsx'],
        ['Photo.JPG', 'Photo(1).JPG'],
        ['100%完成.xlsx', '100%完成(1).xlsx'],
        ['archive.tar.gz', 'archive.tar(1).gz'],
        ['README', 'README(1)'],
        ['.hidden', '.hidden(1)'],
        [`${'a'.repeat(251)}.png`, `${'a'.repeat(248)}(1).png`],
        [`${'表'.repeat(83)}.xlsx`, `${'表'.repeat(82)}(1).xlsx`],
    ] as const) {
        for (const [index, group] of [undefined, ''].entries()) {
            const data = Buffer.from(`copy-${index}`);
            const ready = await store.begin(owner, { name, size: data.length, ...(group === undefined ? {} : { group }) });
            await store.append(owner, ready.uploadId, 0, data);
            const saved = await store.finish(owner, ready.uploadId);
            assert.equal(saved.file, index === 0 ? name : duplicate);
            assert.equal(saved.originalName, name);
            assert.equal(saved.group, '');
            assert.ok(isFileSuccess(saved));
            assert.ok(Buffer.byteLength(saved.file) <= 255);
            assert.deepEqual(await readFile(join(directory, saved.file)), data);
        }
        assert.equal(await readFile(join(directory, name), 'utf8'), 'copy-0');
    }
});

test('numbering skips existing files, directories and hard links and continues after restart', async (t) => {
    const { store, owner, root, directory } = await fixture(t);
    await writeFile(join(directory, 'report.xlsx'), 'keep');
    await mkdir(join(directory, 'report(1).xlsx'));
    await link(join(directory, 'report.xlsx'), join(directory, 'report(2).xlsx'));
    for (let index = 3; index < 12; index++) await writeFile(join(directory, `report(${index}).xlsx`), 'keep');
    const ready = await store.begin(owner, { name: 'report.xlsx', size: 0 });
    const saved = await store.finish(owner, ready.uploadId);
    assert.equal(saved.file, 'report(12).xlsx');
    await store.dispose();
    const restarted = new FileStore(resolveOptions({ directory: root }));
    t.after(() => restarted.dispose());
    const next = await restarted.begin(owner, { name: 'report.xlsx', size: 1 });
    await restarted.append(owner, next.uploadId, 0, Buffer.from('x'));
    assert.equal((await restarted.finish(owner, next.uploadId)).file, 'report(13).xlsx');
    assert.equal(await readFile(join(directory, 'report.xlsx'), 'utf8'), 'keep');
    assert.equal(await readFile(join(directory, 'report(2).xlsx'), 'utf8'), 'keep');
    assert.deepEqual(await readdir(join(directory, 'report(1).xlsx')), []);
});

test('concurrent stores publish the same original name without races or overwrites', async (t) => {
    const { store, owner, root, directory } = await fixture(t);
    const other = new FileStore(resolveOptions({ directory: root }));
    t.after(() => other.dispose());
    const receipts = await Promise.all([store, other, store, other].map(async (current, index) => {
        const ready = await current.begin(owner, { name: 'parallel.png', size: 1 });
        await current.append(owner, ready.uploadId, 0, Buffer.from([index]));
        const saved = await current.finish(owner, ready.uploadId);
        assert.deepEqual(await readFile(join(directory, saved.file)), Buffer.from([index]));
        return saved.file;
    }));
    assert.deepEqual(receipts.sort(), ['parallel(1).png', 'parallel(2).png', 'parallel(3).png', 'parallel.png']);
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', ...receipts]);
});

test('numbering never follows an existing symbolic link', async (t) => {
    const { store, owner, directory } = await fixture(t);
    const target = join(directory, 'test-owned-target');
    await writeFile(target, 'keep');
    try {
        await symlink(target, join(directory, 'report.xlsx'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating symlinks requires Windows Developer Mode or administrator permission');
        return;
    }
    const ready = await store.begin(owner, { name: 'report.xlsx', size: 0 });
    assert.equal((await store.finish(owner, ready.uploadId)).file, 'report(1).xlsx');
    assert.equal(await readFile(target, 'utf8'), 'keep');
});

test('ungrouped portable names escape unsafe characters and reserved device or temporary names', async (t) => {
    const { store, owner } = await fixture(t);
    for (const [name, safe] of [
        ['a<b>"c|d?e*.xlsx', 'a%3Cb%3E%22c%7Cd%3Fe%2A.xlsx'],
        ['100%完成.xlsx', '100%完成.xlsx'],
        ['CON.txt', '%43ON.txt'],
        ['nul .txt', '%6Eul .txt'],
        ['COM1', '%43OM1'],
        ['LPT¹.log', '%4CPT¹.log'],
        ['CONOUT$.log', '%43ONOUT$.log'],
        ['.message-transfer-upload-example', '%2Emessage-transfer-upload-example'],
        ['.message-transfer-files', '%2Emessage-transfer-files'],
    ] as const) {
        const ready = await store.begin(owner, { name, size: 0 });
        const saved = await store.finish(owner, ready.uploadId);
        assert.equal(saved.file, safe);
        assert.equal(saved.originalName, name);
    }
});

test('truncating escaped extensionless names never leaves trailing Windows spaces or an empty name', async (t) => {
    const { store, owner, directory } = await fixture(t);
    for (const [name, expected] of [
        [`${'a'.repeat(252)}  *`, 'a'.repeat(252)],
        [`${' '.repeat(254)}*`, 'file'],
    ]) {
        const ready = await store.begin(owner, { name, size: 0 });
        const saved = await store.finish(owner, ready.uploadId);
        assert.equal(saved.file, expected);
        assert.ok((await readdir(directory)).includes(saved.file));
    }
});

test('file receipt names accept 255 UTF-8 bytes but reject oversized or path-shaped names', () => {
    const receipt = { ok: true, code: 0, date: '20261024', groupDirectory: '', kind: 'file', group: '', bytes: 0, originalName: 'file.png', sha256: 'a'.repeat(64) };
    for (const file of ['a'.repeat(255), `${'表'.repeat(83)}.xlsx`]) assert.equal(isFileSuccess({ ...receipt, file }), true);
    for (const file of ['a'.repeat(256), '表'.repeat(86), '../file.png', 'folder/file.png', 'C:\\file.png']) {
        assert.equal(isFileSuccess({ ...receipt, file }), false);
    }
});

test('an original text-looking file retains its name and rejects a later text append', async (t) => {
    const { store, owner, root, directory } = await fixture(t);
    const name = 'default.txt';
    const ready = await store.begin(owner, { name, size: 6 });
    await store.append(owner, ready.uploadId, 0, Buffer.from('binary'));
    const saved = await store.finish(owner, ready.uploadId);
    assert.equal(saved.file, name);
    const duplicate = await store.begin(owner, { name, size: 6 });
    await store.append(owner, duplicate.uploadId, 0, Buffer.from('binary'));
    assert.deepEqual(await store.finish(owner, duplicate.uploadId), saved);
    const text = new GroupedStore({ directory: root, maxContentBytes: 1024 });
    await assert.rejects(text.append({ group: '', name, content: 'text' }), { code: 'FILE_NAME_CONFLICT' });
    assert.equal(await readFile(join(directory, saved.file), 'utf8'), 'binary');
});

test('empty files and maximum length names work without losing the original extension', async (t) => {
    const { store, owner, directory } = await fixture(t);
    const started = await store.begin(owner, { name: `${'长'.repeat(80)}.png`, group: '组'.repeat(80), size: 0 });
    const saved = await store.finish(owner, started.uploadId);
    assert.equal(saved.bytes, 0);
    assert.match(saved.file, /\.png$/);
    assert.ok(Buffer.byteLength(saved.file) <= 255);
    assert.equal((await readFile(join(directory, saved.groupDirectory, saved.file))).length, 0);
    const special = await store.begin(owner, { name: 'from-linux*.xlsx', size: 0 });
    const encoded = await store.finish(owner, special.uploadId);
    assert.match(encoded.file, /%2A\.xlsx$/);
    assert.doesNotMatch(encoded.file, /\*/);
});

test('raw unknown-length sessions keep owner isolation and reject invalid chunks with a safe validation error', async (t) => {
    const { store, owner, directory } = await fixture(t);
    const ready = await store.beginRaw(owner);
    await assert.rejects(store.append({}, ready.uploadId, 0, Buffer.from([1])), { code: 'INVALID_MESSAGE' });
    await assert.rejects(store.append(owner, ready.uploadId, 0, null as never), { code: 'INVALID_MESSAGE' });
    assert.deepEqual(await readdir(directory), []);
});

test('file metadata rejects traversal, invalid sizes and oversize before allocating a temporary directory', async (t) => {
    const { store, owner, directory } = await fixture(t, { maxFileBytes: 8 });
    for (const name of ['', '..', '../photo.png', 'C:\\key.pem', 'x\0.png', 'x\n.png', '\uD800.png', `${'a'.repeat(256)}.png`]) {
        await assert.rejects(store.begin(owner, { name, size: 1 }), { code: 'INVALID_NAME' });
    }
    for (const size of [-1, 1.5, Number.NaN]) await assert.rejects(store.begin(owner, { name: 'a.png', size }), { code: 'INVALID_MESSAGE' });
    await assert.rejects(store.begin(owner, { name: 'a.png', size: 9 }), { code: 'MESSAGE_TOO_LARGE' });
    await assert.rejects(store.begin(owner, { name: 'a.png', size: 1, group: 'a'.repeat(257) }), { code: 'INVALID_GROUP' });
    assert.deepEqual(await readdir(directory), []);
});

test('file sessions isolate owners and clean incomplete, oversized and out-of-order transfers', async (t) => {
    const { store, owner, directory } = await fixture(t);
    let started = await store.begin(owner, { name: 'photo.png', size: 4 });
    await assert.rejects(store.append({}, started.uploadId, 0, Buffer.from('safe')), { code: 'INVALID_MESSAGE' });
    await assert.rejects(store.abort({}, started.uploadId), { code: 'INVALID_MESSAGE' });
    await store.append(owner, started.uploadId, 0, Buffer.from('safe'));
    await store.abort(owner, started.uploadId);
    assert.deepEqual(await readdir(directory), []);
    for (const [offset, bytes] of [[1, 1], [0, 5], [0, 65537]]) {
        started = await store.begin(owner, { name: 'photo.png', size: 4 });
        await assert.rejects(store.append(owner, started.uploadId, offset!, Buffer.alloc(bytes!)));
        assert.deepEqual(await readdir(directory), []);
    }
    started = await store.begin(owner, { name: 'photo.png', size: 4 });
    await assert.rejects(store.finish(owner, started.uploadId), { code: 'INVALID_MESSAGE' });
    assert.deepEqual(await readdir(directory), []);
});

test('file capacity counts opening sessions, rejects concurrent chunks and releases only the selected owner', async (t) => {
    const { store, owner, directory } = await fixture(t, { maxFileTransfers: 1 });
    const opening = store.begin(owner, { name: 'one.bin', size: 2 });
    await assert.rejects(store.begin({}, { name: 'two.bin', size: 2 }), { code: 'SERVER_BUSY' });
    const first = await opening;
    const writing = store.append(owner, first.uploadId, 0, Buffer.from('a'));
    await assert.rejects(store.append(owner, first.uploadId, 0, Buffer.from('a')), { code: 'SERVER_BUSY' });
    await writing;
    await store.release({});
    await store.append(owner, first.uploadId, 1, Buffer.from('b'));
    await store.release(owner);
    assert.deepEqual(await readdir(directory), []);
    await store.begin({}, { name: 'after.bin', size: 0 });
    await store.dispose();
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(store.begin({}, { name: 'closed.bin', size: 0 }), { code: 'SHUTTING_DOWN' });
});

test('total file lifetime is bounded even when the peer has sent a chunk', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { store, owner, directory } = await fixture(t, { fileTransferTimeoutMs: 100 });
    const started = await store.begin(owner, { name: 'slow.bin', size: 2 });
    t.mock.timers.tick(90);
    await store.append(owner, started.uploadId, 0, Buffer.from('a'));
    t.mock.timers.tick(10);
    await assert.rejects(store.append(owner, started.uploadId, 1, Buffer.from('b')));
    await store.dispose();
    assert.deepEqual(await readdir(directory), []);
});

test('file names never silently truncate a long extension', async (t) => {
    const { store, owner, directory } = await fixture(t);
    await assert.rejects(store.begin(owner, { name: `file.${'a'.repeat(49)}`, size: 0 }), { code: 'INVALID_NAME' });
    assert.deepEqual(await readdir(directory), []);
});

test('cancellation during opening cleans owned resources and stop drains an already committed file', async (t) => {
    const { store, owner, directory } = await fixture(t);
    const opening = store.begin(owner, { name: 'cancelled.png', size: 1 });
    const cancelled = assert.rejects(opening, { code: 'SHUTTING_DOWN' });
    await store.release(owner);
    await cancelled;
    assert.deepEqual(await readdir(directory), []);
    const ready = await store.begin(owner, { name: 'complete.png', size: 0 });
    const committed = store.finish(owner, ready.uploadId);
    await store.dispose();
    const result = await committed;
    assert.equal(result.kind, 'file');
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', result.file]);
});

test('cleanup failure is reported locally and never recursively removes unexpected files', async (t) => {
    const observed: unknown[] = [];
    const { store, owner, directory } = await fixture(t, { onError: (error) => {
        observed.push(error);
    } });
    const ready = await store.begin(owner, { name: 'partial.bin', size: 1 });
    const [temporary] = await readdir(directory);
    const retained = join(directory, temporary!, 'unexpected-test-file');
    await writeFile(retained, 'keep');
    await assert.rejects(store.abort(owner, ready.uploadId));
    assert.equal(observed.length, 1);
    assert.equal((observed[0] as { code: string }).code, 'WRITE_FAILED');
    assert.equal(await readFile(retained, 'utf8'), 'keep');
});

test('cleanup preserves an unknown replacement of the owned temporary data file', async (t) => {
    const { store, owner, root, directory } = await fixture(t);
    const ready = await store.begin(owner, { name: 'partial.bin', size: 1 });
    await store.append(owner, ready.uploadId, 0, Buffer.from('A'));
    const [temporary] = await readdir(directory);
    const source = join(directory, temporary!, 'data');
    const retained = join(root, 'test-owned-original');
    await rename(source, retained);
    await writeFile(source, 'unknown');
    await assert.rejects(store.abort(owner, ready.uploadId), { code: 'WRITE_FAILED' });
    assert.equal(await readFile(source, 'utf8'), 'unknown');
    assert.equal(await readFile(retained, 'utf8'), 'A');
    assert.deepEqual(await readdir(directory), [temporary]);
});

for (const method of ['release', 'dispose'] as const) {
    test(`${method} drains other committed uploads before reporting one cleanup failure`, async (t) => {
        let reported!: () => void;
        const failure = new Promise<void>((resolve) => {
            reported = resolve;
        });
        const { store, owner, directory } = await fixture(t, { onError: () => reported() });
        await store.begin(owner, { name: 'incomplete.bin', size: 1 });
        const [temporary] = await readdir(directory);
        assert.ok(temporary);
        assert.match(temporary, /^\.message-transfer-upload-/);
        await writeFile(join(directory, temporary, 'unrelated'), 'keep');
        const ready = await store.begin(owner, { name: 'complete.bin', size: 0 });
        const cleanup = store as unknown as {
            /** 清理本次上传资源. @param {unknown} upload 原方法接收的自有上传. */
            remove: (upload: unknown) => Promise<void>;
        };
        const remove = cleanup.remove.bind(cleanup);
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        t.mock.method(cleanup, 'remove', async (upload: unknown) => {
            if ((upload as { id: string }).id === ready.uploadId) {
                entered();
                await gate;
            }
            await remove(upload);
        });
        const finishing = store.finish(owner, ready.uploadId);
        await waiting;
        let settled = false;
        const stopping = method === 'dispose' ? store.dispose() : store.release(owner);
        const rejected = assert.rejects(stopping, { code: 'WRITE_FAILED' });
        void stopping.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        try {
            await failure;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(settled, false, 'cleanup failure must not finish shutdown while another committed upload is still cleaning');
        }
        finally {
            release();
            await finishing;
            await rejected;
        }
        assert.equal(await readFile(join(directory, temporary, 'unrelated'), 'utf8'), 'keep');
        assert.equal(await readFile(join(directory, 'complete.bin'), 'utf8'), '');
    });
}

test('publication refuses a hard-linked temporary file rather than exposing a linked output', async (t) => {
    const { store, owner, directory } = await fixture(t);
    const started = await store.begin(owner, { name: 'photo.png', size: 1 });
    await store.append(owner, started.uploadId, 0, Buffer.from('a'));
    const [temporary] = await readdir(directory);
    const retained = join(directory, 'test-owned-link');
    await link(join(directory, temporary!, 'data'), retained);
    await assert.rejects(store.finish(owner, started.uploadId), { code: 'WRITE_FAILED' });
    assert.deepEqual(await readdir(directory), ['test-owned-link']);
    assert.equal(await readFile(retained, 'utf8'), 'a');
});
