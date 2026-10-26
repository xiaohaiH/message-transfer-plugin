import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveOptions } from '../src/config.js';
import { FILE_CHUNK_BYTES, isFileSuccess } from '../src/file-protocol.js';
import { FileStore } from '../src/file-store.js';
import { localDate } from '../src/filenames.js';
import { GroupedStore } from '../src/store.js';
import { tempDirectory } from './helpers.js';

/** 测试只使用独占临时目录. @param {TestContext} t 测试资源上下文. */
async function fixture(t: TestContext) {
    const root = await tempDirectory();
    const stores: FileStore[] = [];
    const create = () => {
        const store = new FileStore(resolveOptions({ directory: root }));
        stores.push(store);
        return store;
    };
    t.after(async () => {
        await Promise.all(stores.map((store) => store.dispose()));
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return { root, create, store: create(), owner: {} };
}

/**
 * 分片完整上传测试字节, 不依赖接收器或真实宿主.
 * @param {FileStore} store 当前文件管理器.
 * @param {Buffer} data 本测试拥有的原始字节.
 * @param {string} name 完整文件名.
 * @param {string} group 可选分组.
 */
async function save(store: FileStore, data: Buffer, name = 'sample.bin', group = '') {
    const owner = {};
    const ready = await store.begin(owner, { name, group, size: data.length });
    for (let offset = 0; offset < data.length; offset += FILE_CHUNK_BYTES) {
        await store.append(owner, ready.uploadId, offset, data.subarray(offset, offset + FILE_CHUNK_BYTES));
    }
    return store.finish(owner, ready.uploadId);
}

for (const { label, textName, uploadName, expected, occupied } of [
    { label: 'plain name', textName: 'notes.txt', uploadName: 'notes.txt', expected: 'notes(1).txt' },
    { label: 'numbered candidate', textName: 'notes(1).txt', uploadName: 'notes.txt', expected: 'notes(2).txt', occupied: true },
    { label: 'escaped name alias', textName: 'a*.txt', uploadName: 'a%2A.txt', expected: 'a%2A(1).txt' },
    { label: 'truncated name alias', textName: `${'*'.repeat(84)}.txt`, uploadName: `${'*'.repeat(83)}.txt`, expected: `${'%2A'.repeat(82)}(1).txt` },
    { label: 'truncated numbered candidate', textName: `${'a'.repeat(248)}(1).txt`, uploadName: `${'a'.repeat(251)}.txt`, expected: `${'a'.repeat(248)}(2).txt`, occupied: true },
]) {
    test(`text-first identical upload stays immutable after subsequent text append: ${label}`, async (t) => {
        const { root, store, create } = await fixture(t);
        const options = { directory: root, maxContentBytes: 1024, autoNewline: false };
        const text = new GroupedStore(options);
        if (occupied) await save(store, Buffer.from('different'), uploadName);
        const first = await text.append({ group: '', name: textName, content: 'A' });
        const uploaded = await save(store, Buffer.from('A'), uploadName);
        await new GroupedStore(options).append({ group: '', name: textName, content: 'B' });
        const directory = join(root, first.date);
        assert.equal(await readFile(join(directory, first.file), 'utf8'), 'AB');
        assert.equal(await readFile(join(directory, uploaded.file), 'utf8'), 'A');
        assert.equal(uploaded.file, expected);
        await store.dispose();
        assert.deepEqual(await save(create(), Buffer.from('A'), uploadName), uploaded);
        await assert.rejects(text.append({ group: '', name: uploaded.file, content: 'C' }), { code: 'FILE_NAME_CONFLICT' });
        assert.equal(await readFile(join(directory, uploaded.file), 'utf8'), 'A');
    });
}

test('identical complete files reuse the basename, original bytes and digest after restart', async (t) => {
    const { root, store, create } = await fixture(t);
    const data = Buffer.alloc(FILE_CHUNK_BYTES * 3 + 7, 0xA5);
    data[data.length - 1] = 17;
    const first = await save(store, data);
    const directory = join(root, first.date);
    const before = await lstat(join(directory, first.file), { bigint: true });
    const markers = join(directory, '.message-transfer-files');
    const proofs = await readdir(markers);
    assert.equal(proofs.length, 1);
    assert.match(proofs[0]!, /^[a-f0-9]{64}$/);
    const proof = await lstat(join(markers, proofs[0]!), { bigint: true });
    assert.ok(proof.isFile() && !proof.isSymbolicLink());
    assert.equal(proof.nlink, 1n);
    assert.equal(proof.size, 0n);
    await mkdir(join(directory, '.message-transfer-upload-unrelated'));
    await writeFile(join(directory, '.message-transfer-upload-unrelated', 'data'), 'untouched');
    await store.dispose();
    const second = await save(create(), data);
    assert.deepEqual(second, first);
    assert.ok(isFileSuccess(second));
    assert.equal(second.code, 0);
    assert.equal(second.bytes, data.length);
    assert.equal(second.sha256, createHash('sha256').update(data).digest('hex'));
    const after = await lstat(join(directory, first.file), { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.nlink, 1n);
    assert.deepEqual(await readdir(markers), proofs);
    const reusedProof = await lstat(join(markers, proofs[0]!), { bigint: true });
    assert.equal(reusedProof.ino, proof.ino);
    assert.equal(reusedProof.mtimeNs, proof.mtimeNs);
    assert.deepEqual(await readFile(join(directory, first.file)), data);
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', '.message-transfer-upload-unrelated', 'sample.bin']);
    assert.equal(await readFile(join(directory, '.message-transfer-upload-unrelated', 'data'), 'utf8'), 'untouched');
});

test('unmarked identical occupied candidates are numbered without claiming or migrating them', async (t) => {
    const { root, store, create } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    await mkdir(directory);
    await writeFile(join(directory, 'sample.bin'), 'same');
    await writeFile(join(directory, 'sample(1).bin'), 'same');
    const before = await lstat(join(directory, 'sample.bin'), { bigint: true });
    const first = await save(store, Buffer.from('same'));
    assert.equal(first.file, 'sample(2).bin');
    const markers = join(directory, '.message-transfer-files');
    const proofs = await readdir(markers);
    assert.equal(proofs.length, 1);
    await store.dispose();
    assert.deepEqual(await save(create(), Buffer.from('same')), first);
    assert.deepEqual(await readdir(markers), proofs);
    const after = await lstat(join(directory, 'sample.bin'), { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await readFile(join(directory, 'sample(1).bin'), 'utf8'), 'same');
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample(1).bin', 'sample(2).bin', 'sample.bin']);
});

for (const replacement of ['file', 'proof directory']) {
    test(`stale original-file proof cannot authorize an identical replacement ${replacement}`, async (t) => {
        const { root, store, create } = await fixture(t);
        const first = await save(store, Buffer.from('same'));
        const directory = join(root, first.date);
        const markers = join(directory, '.message-transfer-files');
        const proofs = await readdir(markers);
        assert.equal(proofs.length, 1);
        const retained = join(root, 'test-owned-retained');
        if (replacement === 'file') {
            // 保留 inode, 确定性验证旧证明不能授权被替换的候选.
            await rename(join(directory, first.file), retained);
            await writeFile(join(directory, first.file), 'same');
        }
        else {
            await rename(markers, retained);
        }
        await store.dispose();
        const restarted = create();
        const next = await save(restarted, Buffer.from('same'));
        assert.equal(next.file, 'sample(1).bin');
        assert.deepEqual(await save(restarted, Buffer.from('same')), next);
        assert.equal((await readdir(markers)).length, replacement === 'file' ? 2 : 1);
        if (replacement === 'file') assert.equal(await readFile(retained, 'utf8'), 'same');
        else assert.deepEqual(await readdir(retained), proofs);
        assert.equal(await readFile(join(directory, first.file), 'utf8'), 'same');
    });
}

for (const kind of ['nonempty', 'directory', 'hardlink', 'symlink']) {
    test(`unsafe original-file proof is refused without deleting its ${kind} replacement`, async (t) => {
        const { root, store } = await fixture(t);
        const first = await save(store, Buffer.from('same'));
        const directory = join(root, first.date);
        const markers = join(directory, '.message-transfer-files');
        const [proof] = await readdir(markers);
        assert.ok(proof);
        const marker = join(markers, proof);
        const retained = join(root, 'test-owned-proof');
        if (kind === 'nonempty') {
            await writeFile(marker, 'keep');
        }
        else if (kind === 'hardlink') {
            await link(marker, retained);
        }
        else {
            await rename(marker, retained);
            if (kind === 'directory') {
                await mkdir(marker);
                await writeFile(join(marker, 'unrelated'), 'keep');
            }
            else {
                try {
                    await symlink(retained, marker);
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
                    t.skip('Creating symlinks requires Windows Developer Mode or administrator permission');
                    return;
                }
            }
        }
        const before = await lstat(marker, { bigint: true });
        await assert.rejects(save(store, Buffer.from('same')), { code: 'WRITE_FAILED' });
        const after = await lstat(marker, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.nlink, before.nlink);
        assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
        assert.equal(await readFile(join(directory, first.file), 'utf8'), 'same');
        assert.deepEqual(await readdir(markers), [proof]);
        assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample.bin']);
        if (kind === 'directory') assert.equal(await readFile(join(marker, 'unrelated'), 'utf8'), 'keep');
        else assert.equal(await readFile(marker, 'utf8'), kind === 'nonempty' ? 'keep' : '');
    });
}

for (const kind of ['file', 'junction']) {
    test(`original-file proof directory rejects an existing ${kind} without touching unknown resources`, async (t) => {
        const { root, store } = await fixture(t);
        const directory = join(root, localDate(new Date()));
        await mkdir(directory);
        const markers = join(directory, '.message-transfer-files');
        const retained = join(root, 'test-owned-outside');
        if (kind === 'file') {
            await writeFile(markers, 'keep');
        }
        else {
            await mkdir(retained);
            await writeFile(join(retained, 'unrelated'), 'keep');
            try {
                await symlink(retained, markers, 'junction');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
                t.skip('Creating junctions requires permission on this platform');
                return;
            }
        }
        await assert.rejects(save(store, Buffer.from('same')), { code: 'WRITE_FAILED' });
        // 标记失败后的新目标不回滚或认领为文本, 只清理本上传的临时硬链接.
        assert.equal(await readFile(join(directory, 'sample.bin'), 'utf8'), 'same');
        assert.equal((await lstat(join(directory, 'sample.bin'))).nlink, 1);
        const text = new GroupedStore({ directory: root, maxContentBytes: 1024 });
        await assert.rejects(text.append({ group: '', name: 'sample.bin', content: 'B' }), { code: 'FILE_NAME_CONFLICT' });
        assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample.bin']);
        if (kind === 'file') {
            assert.equal(await readFile(markers, 'utf8'), 'keep');
        }
        else {
            assert.ok((await lstat(markers)).isSymbolicLink());
            assert.deepEqual(await readdir(retained), ['unrelated']);
            assert.equal(await readFile(join(retained, 'unrelated'), 'utf8'), 'keep');
        }
    });
}

test('a linked original-file proof directory cannot authorize reuse of an otherwise valid candidate', async (t) => {
    const { root, store } = await fixture(t);
    const first = await save(store, Buffer.from('same'));
    const directory = join(root, first.date);
    const markers = join(directory, '.message-transfer-files');
    const proofs = await readdir(markers);
    const retained = join(root, 'test-owned-proofs');
    await rename(markers, retained);
    try {
        await symlink(retained, markers, 'junction');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating junctions requires permission on this platform');
        return;
    }
    await assert.rejects(save(store, Buffer.from('same')), { code: 'WRITE_FAILED' });
    assert.ok((await lstat(markers)).isSymbolicLink());
    assert.deepEqual(await readdir(retained), proofs);
    assert.equal(await readFile(join(retained, proofs[0]!), 'utf8'), '');
    assert.equal(await readFile(join(directory, first.file), 'utf8'), 'same');
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample.bin']);
});

for (const boundary of ['marker', 'directory']) {
    test(`original-file proof ${boundary} replacement during creation fails without deleting replacements`, async (t) => {
        const { root, store } = await fixture(t);
        const directory = join(root, localDate(new Date()));
        const markers = join(directory, '.message-transfer-files');
        const retained = join(root, 'test-owned-proof');
        const originalOpen = fs.open;
        let replacement = '';
        // 目录在排他打开前替换, 标记在打开后替换; 避免 Windows 禁止移动含打开文件的目录.
        const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
            const path = String(args[0]);
            if (boundary === 'directory' && dirname(path) === markers && !replacement) {
                replacement = path;
                await rename(markers, retained);
                await mkdir(markers);
            }
            const handle = await originalOpen(...args);
            try {
                if (boundary === 'marker' && dirname(path) === markers && !replacement) {
                    replacement = path;
                    await rename(path, retained);
                    await writeFile(path, '');
                }
                return handle;
            }
            catch (error) {
                await handle.close();
                throw error;
            }
        });
        syncBuiltinESMExports();
        t.after(() => {
            opening.mock.restore();
            syncBuiltinESMExports();
        });
        await assert.rejects(save(store, Buffer.from('same')), { code: 'WRITE_FAILED' });
        assert.ok(replacement);
        assert.equal(await readFile(replacement, 'utf8'), '');
        if (boundary === 'marker') assert.equal(await readFile(retained, 'utf8'), '');
        else assert.deepEqual(await readdir(retained), []);
        assert.equal(await readFile(join(directory, 'sample.bin'), 'utf8'), 'same');
        assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample.bin']);
        const text = new GroupedStore({ directory: root, maxContentBytes: 1024 });
        await assert.rejects(text.append({ group: '', name: 'sample.bin', content: 'B' }), { code: 'FILE_NAME_CONFLICT' });
    });
}

test('exclusive original-file proof creation preserves a pre-existing marker and fails closed', async (t) => {
    const { root, store } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    const markers = join(directory, '.message-transfer-files');
    const originalOpen = fs.open;
    let occupied = '';
    const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const path = String(args[0]);
        if (dirname(path) === markers && !occupied) {
            occupied = path;
            await writeFile(path, 'unknown');
        }
        return originalOpen(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
        opening.mock.restore();
        syncBuiltinESMExports();
    });
    await assert.rejects(save(store, Buffer.from('same')), { code: 'WRITE_FAILED' });
    assert.ok(occupied);
    assert.equal(await readFile(occupied, 'utf8'), 'unknown');
    assert.equal(await readFile(join(directory, 'sample.bin'), 'utf8'), 'same');
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'sample.bin']);
});

for (const boundary of ['marker', 'directory']) {
    test(`original-file proof ${boundary} must remain identical throughout bounded comparison`, async (t) => {
        const { root, store } = await fixture(t);
        const first = await save(store, Buffer.alloc(FILE_CHUNK_BYTES + 1, 65));
        const directory = join(root, first.date);
        const target = join(directory, first.file);
        const markers = join(directory, '.message-transfer-files');
        const [proof] = await readdir(markers);
        assert.ok(proof);
        const marker = join(markers, proof);
        const retained = join(root, 'test-owned-proof');
        const originalOpen = fs.open;
        let replaced = false;
        const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
            const handle = await originalOpen(...args);
            if (String(args[0]) === target && !replaced) {
                replaced = true;
                await rename(boundary === 'marker' ? marker : markers, retained);
                if (boundary === 'directory') await mkdir(markers);
                await writeFile(marker, '');
            }
            return handle;
        });
        syncBuiltinESMExports();
        t.after(() => {
            opening.mock.restore();
            syncBuiltinESMExports();
        });
        const next = await save(store, Buffer.alloc(FILE_CHUNK_BYTES + 1, 65));
        assert.ok(replaced);
        assert.equal(next.file, 'sample(1).bin');
        assert.equal(await readFile(marker, 'utf8'), '');
        if (boundary === 'marker') assert.equal(await readFile(retained, 'utf8'), '');
        else assert.deepEqual(await readdir(retained), [proof]);
        assert.equal((await readdir(markers)).length, 2);
    });
}

test('a published path replaced with mutable text is never relabeled as an original file', async (t) => {
    const { root, store } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    const target = join(directory, 'notes.txt');
    const retained = join(root, 'test-owned-original');
    const text = new GroupedStore({ directory: root, maxContentBytes: 1024, autoNewline: false });
    const originalLink = fs.link;
    const publication = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
        await originalLink(...args);
        if (String(args[1]) === target) {
            await rename(target, retained);
            await text.append({ group: '', name: 'notes.txt', content: 'A' });
        }
    });
    syncBuiltinESMExports();
    t.after(() => {
        publication.mock.restore();
        syncBuiltinESMExports();
    });
    await assert.rejects(save(store, Buffer.from('A'), 'notes.txt'), { code: 'WRITE_FAILED' });
    publication.mock.restore();
    syncBuiltinESMExports();
    const uploaded = await save(store, Buffer.from('A'), 'notes.txt');
    assert.equal(uploaded.file, 'notes(1).txt');
    await text.append({ group: '', name: 'notes.txt', content: 'B' });
    assert.equal(await readFile(target, 'utf8'), 'AB');
    assert.equal(await readFile(retained, 'utf8'), 'A');
    assert.equal(await readFile(join(directory, uploaded.file), 'utf8'), 'A');
    assert.equal((await readdir(join(directory, '.message-transfer-files'))).length, 1);
});

test('proof creation stays bound to the uploaded inode when the published path becomes text', async (t) => {
    const { root, store } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    const markers = join(directory, '.message-transfer-files');
    const target = join(directory, 'notes.txt');
    const retained = join(root, 'test-owned-original');
    const text = new GroupedStore({ directory: root, maxContentBytes: 1024, autoNewline: false });
    const originalOpen = fs.open;
    let replaced = false;
    const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        try {
            if (dirname(String(args[0])) === markers && !replaced) {
                replaced = true;
                await rename(target, retained);
                await text.append({ group: '', name: 'notes.txt', content: 'A' });
            }
            return handle;
        }
        catch (error) {
            await handle.close();
            throw error;
        }
    });
    syncBuiltinESMExports();
    t.after(() => {
        opening.mock.restore();
        syncBuiltinESMExports();
    });
    await assert.rejects(save(store, Buffer.from('A'), 'notes.txt'), { code: 'WRITE_FAILED' });
    assert.ok(replaced);
    opening.mock.restore();
    syncBuiltinESMExports();
    const uploaded = await save(store, Buffer.from('A'), 'notes.txt');
    assert.equal(uploaded.file, 'notes(1).txt');
    await text.append({ group: '', name: 'notes.txt', content: 'B' });
    assert.equal(await readFile(target, 'utf8'), 'AB');
    assert.equal(await readFile(retained, 'utf8'), 'A');
    assert.equal(await readFile(join(directory, uploaded.file), 'utf8'), 'A');
    assert.equal((await readdir(markers)).length, 2);
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', '.message-transfer-text', 'notes(1).txt', 'notes.txt']);
});

test('same-size different bytes number, and every occupied numbered candidate can be reused', async (t) => {
    const { store, root } = await fixture(t);
    const a = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 1, 1);
    const b = Buffer.from(a);
    b[b.length - 1] = 2;
    const c = Buffer.from(a);
    c[FILE_CHUNK_BYTES] = 3;
    assert.equal((await save(store, a)).file, 'sample.bin');
    assert.equal((await save(store, b)).file, 'sample(1).bin');
    const third = await save(store, c);
    assert.equal(third.file, 'sample(2).bin');
    assert.equal((await save(store, c)).file, third.file);
    assert.equal((await save(store, b)).file, 'sample(1).bin');
    assert.deepEqual((await readdir(join(root, third.date))).sort(), ['.message-transfer-files', 'sample(1).bin', 'sample(2).bin', 'sample.bin']);
});

test('empty uploads deduplicate but distinct names, groups and dates remain independent', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 24, 23, 59, 59) });
    const { store, root, owner } = await fixture(t);
    const empty = Buffer.alloc(0);
    const first = await save(store, empty);
    assert.deepEqual(await save(store, empty), first);
    const named = await save(store, empty, 'other.bin');
    const grouped = await save(store, empty, 'sample.bin', 'group');
    assert.equal(named.file, 'other.bin');
    assert.equal(grouped.file, 'sample.bin');
    assert.equal(grouped.groupDirectory, 'group');
    const pending = await store.begin(owner, { name: 'sample.bin', size: 0 });
    t.mock.timers.tick(2000);
    assert.deepEqual(await store.finish(owner, pending.uploadId), first);
    const tomorrow = await save(store, empty);
    assert.notEqual(tomorrow.date, first.date);
    assert.equal(tomorrow.file, first.file);
    assert.deepEqual((await readdir(join(root, first.date))).sort(), ['.message-transfer-files', 'group', 'other.bin', 'sample.bin']);
    assert.deepEqual((await readdir(join(root, tomorrow.date))).sort(), ['.message-transfer-files', 'sample.bin']);
    assert.deepEqual((await readdir(join(root, first.date, 'group'))).sort(), ['.message-transfer-files', 'sample.bin']);
    assert.equal((await readdir(join(root, first.date, '.message-transfer-files'))).length, 2);
    assert.equal((await readdir(join(root, first.date, 'group', '.message-transfer-files'))).length, 1);
    assert.equal((await readdir(join(root, tomorrow.date, '.message-transfer-files'))).length, 1);
});

test('comparison is only attempted after complete validation and abort cleans only its upload', async (t) => {
    const { store, root, owner } = await fixture(t);
    const first = await save(store, Buffer.from('same'));
    const pending = await store.begin({}, { name: 'sample.bin', size: 4 });
    const invalid = await store.begin(owner, { name: 'sample.bin', size: 4 });
    await store.append(owner, invalid.uploadId, 0, Buffer.from('sam'));
    await assert.rejects(store.finish(owner, invalid.uploadId), { code: 'INVALID_MESSAGE' });
    const aborted = await store.begin(owner, { name: 'sample.bin', size: 4 });
    await store.append(owner, aborted.uploadId, 0, Buffer.from('same'));
    await store.abort(owner, aborted.uploadId);
    const names = await readdir(join(root, first.date));
    assert.equal(names.filter((name) => name.startsWith('.message-transfer-upload-')).length, 1);
    assert.ok(pending.uploadId);
    assert.equal(await readFile(join(root, first.date, first.file), 'utf8'), 'same');
    assert.equal((await save(store, Buffer.from('same'))).file, first.file);
});

test('concurrent identical finishes across instances reuse one file and disposal drains them', async (t) => {
    const { store, create, root } = await fixture(t);
    const other = create();
    const ready = await Promise.all([store, other, store, other, store, other, store, other].map(async (current) => {
        const owner = {};
        const started = await current.begin(owner, { name: 'parallel.bin', size: 4 });
        await current.append(owner, started.uploadId, 0, Buffer.from('same'));
        return { current, owner, id: started.uploadId };
    }));
    const finishing = Promise.all(ready.map(({ current, owner, id }) => current.finish(owner, id)));
    await Promise.all([store.dispose(), other.dispose()]);
    const receipts = await finishing;
    assert.deepEqual(new Set(receipts.map((receipt) => receipt.file)), new Set(['parallel.bin']));
    const directory = join(root, receipts[0]!.date);
    assert.deepEqual((await readdir(directory)).sort(), ['.message-transfer-files', 'parallel.bin']);
    assert.equal((await lstat(join(directory, 'parallel.bin'))).nlink, 1);
});

test('publication lock spans temporary hardlink cleanup across store instances', async (t) => {
    const { store, create, root, owner } = await fixture(t);
    const other = create();
    // 仅延迟测试实例的清理, 不替换真实文件系统操作或放宽 nlink 校验.
    const cleanup = store as unknown as {
        /** 清理本实例资源. @param {unknown} upload 原方法接收的自有上传. */
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
        entered();
        await gate;
        await remove(upload);
    });
    const ready = await store.begin(owner, { name: 'window.bin', size: 4 });
    await store.append(owner, ready.uploadId, 0, Buffer.from('same'));
    const finishing = store.finish(owner, ready.uploadId);
    let duplicate: ReturnType<typeof save> | undefined;
    try {
        await waiting;
        const target = join(root, localDate(new Date()), 'window.bin');
        assert.equal((await lstat(target)).nlink, 2);
        duplicate = save(other, Buffer.from('same'), 'window.bin');
        // 另一分组仍可正常发布, 队列不覆盖接收或整个实例.
        assert.equal((await save(other, Buffer.from('same'), 'window.bin', 'independent')).file, 'window.bin');
    }
    finally { release(); }
    const [first, second] = await Promise.all([finishing, duplicate!]);
    assert.deepEqual(second, first);
    assert.deepEqual((await readdir(join(root, first.date))).sort(), ['.message-transfer-files', 'independent', 'window.bin']);
});

test('publication stops at the first free candidate without scanning later numbered files', async (t) => {
    const { store, root } = await fixture(t);
    const first = await save(store, Buffer.from('different'));
    const directory = join(root, first.date);
    await writeFile(join(directory, 'sample(2).bin'), 'same');
    assert.equal((await save(store, Buffer.from('same'))).file, 'sample(1).bin');
    assert.equal(await readFile(join(directory, 'sample(2).bin'), 'utf8'), 'same');
});

test('hardlinks and directories with identical or empty contents are not accepted for reuse', async (t) => {
    const { store, root } = await fixture(t);
    const first = await save(store, Buffer.from('same'));
    const directory = join(root, first.date);
    await link(join(directory, first.file), join(directory, 'owned-link'));
    await mkdir(join(directory, 'sample(1).bin'));
    const next = await save(store, Buffer.from('same'));
    assert.equal(next.file, 'sample(2).bin');
    assert.equal((await save(store, Buffer.from('same'))).file, next.file);
    assert.equal(await readFile(join(directory, 'owned-link'), 'utf8'), 'same');
    assert.equal((await lstat(join(directory, first.file))).nlink, 2);
    assert.deepEqual(await readdir(join(directory, 'sample(1).bin')), []);
});

test('symbolic candidates are skipped even when their target contains identical bytes', async (t) => {
    const { store, root } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    await mkdir(directory);
    const target = join(root, 'owned-target');
    await writeFile(target, 'same');
    try {
        await symlink(target, join(directory, 'sample.bin'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating symlinks requires Windows Developer Mode or administrator permission');
        return;
    }
    assert.equal((await save(store, Buffer.from('same'))).file, 'sample(1).bin');
    assert.equal(await readFile(target, 'utf8'), 'same');
    assert.ok((await lstat(join(directory, 'sample.bin'))).isSymbolicLink());
});

test('junction candidates are skipped and linked group directories are refused', async (t) => {
    const { store, root } = await fixture(t);
    const directory = join(root, localDate(new Date()));
    const target = join(root, 'owned-target');
    await mkdir(directory);
    await mkdir(target);
    await writeFile(join(target, 'retained'), 'keep');
    try {
        await symlink(target, join(directory, 'sample.bin'), 'junction');
        await symlink(target, join(directory, 'group'), 'junction');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating junctions requires permission on this platform');
        return;
    }
    assert.equal((await save(store, Buffer.alloc(0))).file, 'sample(1).bin');
    await assert.rejects(save(store, Buffer.alloc(0), 'sample.bin', 'group'), { code: 'WRITE_FAILED' });
    assert.deepEqual(await readdir(target), ['retained']);
    assert.equal(await readFile(join(target, 'retained'), 'utf8'), 'keep');
});

test('temporary directory replacement with a junction is refused without cleaning its target', async (t) => {
    const { store, root, owner } = await fixture(t);
    const first = await save(store, Buffer.from('same'));
    const ready = await store.begin(owner, { name: 'sample.bin', size: 4 });
    await store.append(owner, ready.uploadId, 0, Buffer.from('same'));
    const directory = join(root, first.date);
    const temporary = (await readdir(directory)).find((name) => name.startsWith('.message-transfer-upload-'))!;
    const original = join(directory, temporary);
    const moved = join(root, 'owned-moved');
    try {
        await rename(original, moved);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('This platform refuses renaming a directory containing an open upload');
        return;
    }
    try {
        await symlink(moved, original, 'junction');
    }
    catch (error) {
        await rename(moved, original);
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.skip('Creating junctions requires permission on this platform');
        return;
    }
    await assert.rejects(store.finish(owner, ready.uploadId), { code: 'WRITE_FAILED' });
    assert.equal(await readFile(join(moved, 'data'), 'utf8'), 'same');
    assert.equal(await readFile(join(directory, first.file), 'utf8'), 'same');
});
