import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { installClient } from '../src/client-host.js';
import { sendByFetch } from '../src/client.js';
import { resolveOptions } from '../src/config.js';
import { FileStore } from '../src/file-store.js';
import * as api from '../src/index.js';
import { GroupedStore } from '../src/store.js';
import { fixture, success, tempDirectory } from './helpers.js';

// 日期/目录期望来自回执的独立字段, 不通过内部命名函数推导被测试的结果.
test('result codes are literal object constants and business errors remain independently identifiable', () => {
    assert.deepEqual((api as Record<string, unknown>).ReceiptCode, { SUCCESS: 0, FAILURE: 1 });
    assert.equal((api.ReceiverErrorCode as Record<string, unknown>).FILE_NAME_CONFLICT, 'FILE_NAME_CONFLICT');
    assert.equal((api.ReceiverErrorCode as Record<string, unknown>).INVALID_NAME, 'INVALID_NAME');
});

test('HTTP text separates date, optional group directory and independent name', async (t) => {
    const { url, directory } = await fixture(t);
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    const first = success(await sendByFetch({ group: '工作', name: '日志.txt', content: 'one' }));
    assert.equal(first.code, 0);
    assert.match(first.date, /^\d{8}$/);
    assert.equal(first.groupDirectory, '工作');
    assert.equal(first.file, '日志.txt');
    const second = success(await sendByFetch({ group: '工作', name: '日志.txt', content: '|two' }));
    assert.equal(second.file, first.file);
    assert.equal(await readFile(join(directory, first.date, '工作', '日志.txt'), 'utf8'), 'one\n|two\n');
    const other = success(await sendByFetch({ group: '工作', name: '另一个.log', content: 'other' }));
    assert.equal(other.file, '另一个.log');
    const plain = success(await sendByFetch('raw text'));
    assert.equal(plain.groupDirectory, '');
    assert.equal(plain.file, 'default.txt');
    assert.equal(await readFile(join(directory, plain.date, plain.file), 'utf8'), 'raw text\n');
    assert.deepEqual(await readdir(directory), [first.date]);
});

test('file naming prefers explicit name then original name, with no group prefix and numbered collisions', async (t) => {
    const { url, directory } = await fixture(t);
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    const file = new File([new Uint8Array([255, 0, 80, 75])], '报表.xlsx');
    for (const group of [undefined, '', '工作']) {
        const receipt = success(await sendByFetch({ file, ...(group === undefined ? {} : { group }) }));
        assert.equal(receipt.code, 0);
        assert.equal(receipt.groupDirectory, group ?? '');
        assert.equal(receipt.file, '报表.xlsx');
        assert.deepEqual(await readFile(join(directory, receipt.date, receipt.groupDirectory, receipt.file)), Buffer.from([255, 0, 80, 75]));
    }
    const different = success(await sendByFetch({ file: new Blob([new Uint8Array([255, 0, 80, 76])]), name: '报表.xlsx' }));
    assert.equal(different.file, '报表(1).xlsx');
    const renamed = success(await sendByFetch({ file, group: '工作', name: '重命名.xlsx' }));
    assert.equal(renamed.file, '重命名.xlsx');
    const blob = success(await sendByFetch(new Blob([])));
    assert.equal(blob.file, 'default.bin');
});

test('text refuses an existing original file with a stable reason and code, also after restart', async (t) => {
    const { receiver, url, directory } = await fixture(t);
    let dispose = installClient({ endpoint: url.replace('ws:', 'http:') });
    t.after(() => dispose());
    const uploaded = success(await sendByFetch({ file: new File(['binary'], 'notes.txt'), group: '工作' }));
    const request = { group: '工作', name: 'notes.txt', content: 'must not append' };
    for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await sendByFetch(request);
        assert.equal(rejected.ok, false);
        assert.equal(rejected.code, 1);
        if (!rejected.ok) {
            assert.equal(rejected.error.code, 'FILE_NAME_CONFLICT');
            assert.match(rejected.error.message, /already|occupied|text/i);
            assert.ok(!JSON.stringify(rejected).includes(directory));
        }
        if (attempt === 0) {
            dispose();
            await receiver.stop();
            await receiver.start();
            assert.ok(receiver.address && typeof receiver.address !== 'string');
            dispose = installClient({ endpoint: `http://127.0.0.1:${receiver.address.port}/device-data` });
        }
    }
    assert.equal(await readFile(join(directory, uploaded.date, uploaded.groupDirectory, uploaded.file), 'utf8'), 'binary');
    assert.deepEqual((await readdir(join(directory, uploaded.date, uploaded.groupDirectory))).sort(), ['.message-transfer-files', 'notes.txt']);
});

test('text ownership persists across store instances and uploaded files never replace text', async (t) => {
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = { directory, maxContentBytes: 1024 };
    const store = new GroupedStore(options);
    await store.prepare();
    const first = await store.append({ group: 'notes', name: 'notes.txt', content: 'one' });
    const restarted = new GroupedStore(options);
    await restarted.append({ group: 'notes', name: 'notes.txt', content: '|two' });
    const files = new FileStore(resolveOptions({ directory }));
    t.after(() => files.dispose());
    const owner = {};
    const upload = await files.begin(owner, { group: 'notes', name: 'notes.txt', size: 0 });
    const saved = await files.finish(owner, upload.uploadId);
    assert.equal(saved.file, 'notes(1).txt');
    assert.equal(await readFile(join(directory, first.date, 'notes', 'notes.txt'), 'utf8'), 'one\n|two\n');
});

test('text and files pin the local date when accepted, not when a hook or upload finishes', async (t) => {
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const before = new Date(2026, 9, 24, 23, 59, 59);
    t.mock.timers.enable({ apis: ['Date'], now: before.getTime() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const store = new GroupedStore({ directory, maxContentBytes: 1024, processContent: async (text) => {
        await gate;
        return text;
    } });
    const files = new FileStore(resolveOptions({ directory }));
    t.after(() => files.dispose());
    const text = store.append({ group: '', name: 'default.txt', content: 'text' });
    const owner = {};
    const upload = await files.begin(owner, { name: 'photo.png', size: 0 });
    t.mock.timers.setTime(new Date(2026, 9, 25, 0, 1).getTime());
    release();
    assert.equal((await text).date, '20261024');
    assert.equal((await files.finish(owner, upload.uploadId)).date, '20261024');
});

test('HTTP conflicts use 409 and independent names remain isolated within groups', async (t) => {
    const { url } = await fixture(t);
    const endpoint = url.replace('ws:', 'http:');
    t.after(installClient({ endpoint }));
    success(await sendByFetch({ file: new File(['binary'], 'default.txt'), group: 'work' }));
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ group: 'work', content: 'text' }) });
    assert.equal(response.status, 409);
    const failure = await response.json();
    assert.equal(failure.code, 1);
    assert.equal(failure.error.code, 'FILE_NAME_CONFLICT');
    for (const group of ['', 'other', 'default']) {
        const saved = success(await sendByFetch({ group, content: 'independent' }));
        assert.equal(saved.file, 'default.txt');
        assert.equal(saved.groupDirectory, group);
    }
});

test('failed text marker setup leaves an unowned target that is refused rather than guessed or renamed', async (t) => {
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const date = new Date(2026, 9, 24);
    const daily = join(directory, '20261024');
    await mkdir(daily);
    const markerDirectory = join(daily, '.message-transfer-text');
    await writeFile(markerDirectory, 'test-owned obstruction');
    const store = new GroupedStore({ directory, maxContentBytes: 1024 });
    const message = { group: '', name: 'notes.txt', content: 'not written' };
    await assert.rejects(store.append(message, date), { code: 'WRITE_FAILED' });
    assert.equal(await readFile(join(daily, 'notes.txt'), 'utf8'), '');
    await rm(markerDirectory);
    await assert.rejects(store.append(message, date), { code: 'FILE_NAME_CONFLICT' });
    assert.deepEqual(await readdir(daily), ['notes.txt']);
    assert.equal(await readFile(join(daily, 'notes.txt'), 'utf8'), '');
});

test('replacing a text file with an uploaded file invalidates its persistent text ownership', async (t) => {
    const { url, directory } = await fixture(t);
    t.after(installClient({ endpoint: url.replace('ws:', 'http:') }));
    const text = success(await sendByFetch({ name: 'notes.txt', content: 'text' }));
    // 保留旧文件占用原始 inode, 确定性验证被替换目标而不是依赖 inode 回收时机.
    await rename(join(directory, text.date, text.file), join(directory, text.date, 'test-owned-old.txt'));
    success(await sendByFetch(new File(['binary'], 'notes.txt')));
    const rejected = await sendByFetch({ name: 'notes.txt', content: 'must not append' });
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.code, 'FILE_NAME_CONFLICT');
    assert.equal(await readFile(join(directory, text.date, 'notes.txt'), 'utf8'), 'binary');
});

for (const boundary of ['date', 'group', 'temporary']) {
    test(`failed publication cleanup refuses a replaced ${boundary} directory and preserves unrelated files`, async (t) => {
        const directory = await tempDirectory();
        t.after(() => rm(directory, { recursive: true, force: true }));
        const files = new FileStore(resolveOptions({ directory }));
        t.after(() => files.dispose());
        const owner = {};
        const upload = await files.begin(owner, { name: 'photo.png', group: 'work', size: 0 });
        const [date] = await readdir(directory);
        const grouped = join(directory, date!, 'work');
        const [temporary] = await readdir(grouped);
        const victim = boundary === 'date' ? join(directory, date!) : boundary === 'group' ? grouped : join(grouped, temporary!);
        const outside = join(directory, 'test-owned-outside');
        const relative = boundary === 'date' ? join('work', temporary!) : boundary === 'group' ? temporary! : '';
        const unrelated = join(outside, relative);
        await mkdir(unrelated, { recursive: true });
        await writeFile(join(unrelated, 'data'), 'keep');
        const retained = join(directory, 'test-owned-retained');
        // 必须确认链接替换确实发生, 不能把准备阶段的重命名失败当作防护已通过.
        let injected = false;
        let unsupported = false;
        const publication = t.mock.method(fs, 'link', async () => {
            try {
                await rename(victim, retained);
            }
            catch (error) {
                if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
                    unsupported = true;
                    t.skip('This platform refuses renaming a directory containing an open upload');
                }
                throw error;
            }
            try {
                await symlink(outside, victim, 'junction');
                injected = true;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
                await rename(retained, victim);
                unsupported = true;
                t.skip('Creating directory links is not permitted');
            }
            throw Object.assign(new Error('Injected publication failure'), { code: 'EACCES' });
        });
        syncBuiltinESMExports();
        t.after(() => {
            publication.mock.restore();
            syncBuiltinESMExports();
        });
        await assert.rejects(files.finish(owner, upload.uploadId), { code: 'WRITE_FAILED' });
        assert.ok(injected || unsupported, 'the replacement must be installed or explicitly skipped for a known platform restriction');
        assert.equal(await readFile(join(unrelated, 'data'), 'utf8'), 'keep');
    });
}

test('date and group directory links are rejected without modifying their targets', async (t) => {
    const directory = await tempDirectory();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const outside = join(directory, 'test-owned-outside');
    await mkdir(outside);
    const date = new Date(2026, 9, 24);
    try {
        await symlink(outside, join(directory, '20261024'), 'junction');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating directory links is not permitted');
        return;
    }
    const store = new GroupedStore({ directory, maxContentBytes: 1024 });
    await assert.rejects(store.append({ group: '', name: 'default.txt', content: 'never' }, date));
    assert.deepEqual(await readdir(outside), []);
});
