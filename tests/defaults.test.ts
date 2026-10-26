import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createReceiver } from '../src/index.js';
import { messageTransferPlugin } from '../src/vite.js';
import { connect, nextReceipt, receiptPath, success, tempDirectory } from './helpers.js';

// 默认配置测试只在隔离的工作目录运行, 不向用户项目目录写入测试消息.
test('core and Vite plugin accept omitted options and expose the default output directory', () => {
    const receiver = createReceiver();
    assert.equal(receiver.directory, resolve('received'));
    assert.equal(receiver.state, 'stopped');
    assert.equal(messageTransferPlugin().name, 'vite-plugin-message-transfer');
});

test(
    'omitting directory writes text with the default newline to cwd/received and identifies the real file',
    { timeout: 8000 },
    async () => {
        const cwd = process.cwd();
        const root = await tempDirectory();
        process.chdir(root);
        let receiver: ReturnType<typeof createReceiver> | undefined;
        try {
            receiver = createReceiver({ port: 0 });
            assert.equal(receiver.directory, join(root, 'received'));
            await receiver.start();
            assert.ok(receiver.address && typeof receiver.address !== 'string');
            const ws = await connect(`ws://127.0.0.1:${receiver.address.port}/device-data`);
            const reply = nextReceipt(ws);
            ws.send('  hello\n原文  ');
            const saved = success(await reply);
            assert.equal(saved.group, '');
            assert.equal(saved.file, 'default.txt');
            assert.equal(saved.groupDirectory, '');
            assert.equal(saved.bytes, Buffer.byteLength('  hello\n原文  \n'));
            assert.equal(await readFile(receiptPath(receiver.directory, saved), 'utf8'), '  hello\n原文  \n');
        }
        finally {
            await receiver?.stop();
            process.chdir(cwd);
            await rm(root, { recursive: true, force: true });
        }
    },
);
