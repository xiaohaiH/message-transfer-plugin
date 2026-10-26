import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';
import { groupDirectory, localDate, storedFilename } from '../src/filenames.js';

// 日期、分组和文件名分别生成, 互不混入其他组件.
test('local date directories and optional readable group directories are independent', () => {
    assert.equal(localDate(new Date(2026, 0, 2, 3, 4, 5)), '20260102');
    assert.equal(groupDirectory(''), '');
    assert.equal(groupDirectory('default'), 'default');
    assert.equal(groupDirectory('会议记录'), '会议记录');
    assert.equal(groupDirectory('a-1_b'), 'a-1_b');
    assert.equal(storedFilename('notes.txt'), 'notes.txt');
});

test('different local calendar days select different directories', () => {
    assert.equal(localDate(new Date(2026, 8, 28, 23, 59, 59)), '20260928');
    assert.equal(localDate(new Date(2026, 8, 29)), '20260929');
});

test('group case aliases, path characters, devices and Unicode normalization stay distinct', () => {
    const groups = ['', 'default', 'DEFAULT', 'a', 'A', '%41', '%41 ', '../a', '..\\a', 'a/b', 'a\\b', 'a_b', 'a:b', 'a?b', '.', '..', 'con', 'CON', ' ', '\0', 'é', 'e\u0301'];
    const names = groups.map(groupDirectory);
    assert.equal(new Set(names.map((name) => name.toLowerCase().normalize('NFD'))).size, groups.length);
    for (const name of names) {
        if (!name) continue;
        assert.equal(basename(name), name);
        // eslint-disable-next-line no-control-regex -- 目录不能包含控制字符或路径.
        assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001F]/u);
    }
    assert.equal(groupDirectory('con'), '%63on');
});

test('long group directories retain a stable digest without splitting Unicode', () => {
    const group = '会议'.repeat(42);
    const directory = groupDirectory(group);
    assert.ok(Buffer.byteLength(directory) <= 180);
    assert.match(directory, /^.+~[a-f0-9]{64}$/u);
    assert.equal(directory, groupDirectory(group));
    assert.notEqual(directory, groupDirectory(`${group}a`));
    assert.equal(Buffer.from(directory).toString('utf8'), directory);
});

test('filename numbering preserves the extension and reserves only internal or device names', () => {
    assert.equal(storedFilename('报表.xlsx', 1), '报表(1).xlsx');
    assert.equal(storedFilename('20261024_notes.txt'), '20261024_notes.txt');
    assert.equal(storedFilename('.message-transfer-text'), '%2Emessage-transfer-text');
    assert.equal(storedFilename('CON.txt'), '%43ON.txt');
});
