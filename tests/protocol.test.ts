import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMessage } from '../src/protocol.js';

// 验证 JSON 字段校验和解析失败时的原文回退, 不允许静默丢失正文.
/** @param {string} code 当前协议校验预期产生的稳定错误码. */
function hasCode(code: string) {
    return (error: unknown) => {
        assert.equal((error as { code: string }).code, code);
        return true;
    };
}

test('parses the per-message group and preserves content exactly', () => {
    assert.deepEqual(parseMessage('{"group":"笔记 / A","content":"你好\\n"}'), {
        group: '笔记 / A',
        name: 'default.txt',
        content: '你好\n',
    });
});

test('missing and empty group both select the default group; empty content is valid', () => {
    assert.deepEqual(parseMessage('{"content":""}'), { group: '', name: 'default.txt', content: '' });
    assert.deepEqual(parseMessage('{"group":"","content":"x"}'), { group: '', name: 'default.txt', content: 'x' });
    assert.equal(parseMessage('{"group":" ","content":"x"}').group, ' ');
});

for (const raw of ['plain text', '  原始内容\n ', '{"group":"notes",', '', '\n']) {
    test(`unparseable JSON is preserved as default-group text: ${JSON.stringify(raw)}`, () => {
        assert.deepEqual(parseMessage(raw), { group: '', name: 'default.txt', content: raw });
    });
}

for (const raw of ['null', '[]', '"text"', '1', 'true', '{}', '{"content":1,"autoNewline":null}', '{"content":null,"autoNewline":"false"}']) {
    test(`rejects invalid message: ${raw}`, () => {
        assert.throws(() => parseMessage(raw), hasCode('INVALID_MESSAGE'));
    });
}

test('normalizes JSON content once without appending a newline and preserves explicit overrides', () => {
    for (const content of [1, null, true, { nested: ['中文', 2] }, ['x', false]]) {
        for (const autoNewline of [undefined, false, true]) {
            assert.deepEqual(parseMessage(JSON.stringify({ content, autoNewline })), {
                group: '',
                name: 'default.txt',
                content: JSON.stringify(content),
                ...(autoNewline === undefined ? {} : { autoNewline }),
            });
        }
    }
    assert.equal(parseMessage('{"content":"plain","autoNewline":true}').content, 'plain');
    assert.equal(parseMessage('{"content":"line\\r\\n"}').content, 'line\r\n');
});

for (const group of [null, 1, {}, []]) {
    test(`rejects non-string group: ${JSON.stringify(group)}`, () => {
        assert.throws(() => parseMessage(JSON.stringify({ group, content: 'x' })), hasCode('INVALID_GROUP'));
    });
}

test('independent text name is preserved and invalid names are rejected without raw fallback', () => {
    assert.equal(parseMessage('{"content":"x","name":"events.log"}').name, 'events.log');
    for (const name of ['', null, 1, '../x', 'folder/x', 'C:\\x', 'x\0', '\uD800', 'x'.repeat(256)]) {
        assert.throws(() => parseMessage(JSON.stringify({ name, content: 'x' })), hasCode('INVALID_NAME'));
    }
});

test('limits group by UTF-8 bytes, not JavaScript string length', () => {
    assert.throws(() => parseMessage('{"group":"中文","content":"x"}', 5), hasCode('INVALID_GROUP'));
    assert.equal(parseMessage('{"group":"中文","content":"x"}', 6).group, '中文');
});

test('rejects unpaired surrogates rather than silently merging distinct group names', () => {
    assert.throws(() => parseMessage('{"group":"\\ud800","content":"x"}'), hasCode('INVALID_GROUP'));
    assert.throws(() => parseMessage('{"content":"\\ud800"}'), hasCode('INVALID_MESSAGE'));
    assert.equal(parseMessage('{"group":"😀","content":"😀"}').content, '😀');
});

test('ignores extra metadata instead of letting messages choose a filesystem path', () => {
    assert.deepEqual(parseMessage('{"content":"x","path":"../../owned","filename":"owned"}'), {
        group: '',
        name: 'default.txt',
        content: 'x',
    });
});
