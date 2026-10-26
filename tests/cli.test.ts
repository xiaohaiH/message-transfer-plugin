import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, nextReceipt, receiptPath, send, success, tempDirectory } from './helpers.js';

// 用真实子进程覆盖 CLI 参数, 默认目录和信号关闭, 不复用测试进程的状态.
const timeout = { timeout: 10000 };
const cli = new URL('../src/cli.ts', import.meta.url).href;
const loader = import.meta.resolve('tsx');

/**
 * 收集会自行退出的帮助和错误命令输出.
 * @param {string[]} args 交给 CLI 的帮助选项或故意构造的非法参数.
 */
async function command(args: string[]) {
    const child = spawn(process.execPath, ['--import', loader, 'src/cli.ts', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on(
        'data',
        (chunk: Buffer) => {
            stdout += chunk.toString();
        },
    );
    child.stderr.on(
        'data',
        (chunk: Buffer) => {
            stderr += chunk.toString();
        },
    );
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
}

/**
 * 等待真实启动日志, 而不是使用固定延时猜测端口是否就绪.
 * @param {ChildProcess} child 正在启动的 CLI 子进程, 监听其日志, 错误和退出事件.
 */
function listening(child: ChildProcess): Promise<string> {
    return new Promise(
        (resolve, reject) => {
            let output = '';
            let errors = '';
            child.stderr?.on(
                'data',
                (chunk: Buffer) => {
                    errors += chunk.toString();
                },
            );
            child.stdout?.on(
                'data',
                (chunk: Buffer) => {
                    output += chunk.toString();
                    const match = /Listening on (ws:\/\/\S+)/.exec(output);
                    if (match) resolve(match[1]!);
                },
            );
            child.once('error', reject);
            child.once(
                'exit',
                (code) => reject(new Error(`CLI exited ${code}: ${errors}`)),
            );
        },
    );
}

test('CLI help explains the optional directory without starting the service', timeout, async () => {
    const result = await command(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--directory/);
    assert.match(result.stdout, /received/);
    assert.match(result.stdout, /MESSAGE_TRANSFER_TOKEN/);
    assert.match(result.stdout, /--max-file/);
    assert.match(result.stdout, /104857600/);
    assert.equal(result.stderr, '');
});

for (const args of [
    ['--directory', ''],
    ['--unknown'],
    ['--directory', '.', '--port', 'NaN'],
    ['--directory', '.', '--port', '12.5'],
    ['--directory', '.', '--max-payload', '-1'],
    ['--directory', '.', '--max-file', '-1'],
    ['--directory', '.', '--max-file', '0'],
]) {
    test(`CLI rejects invalid arguments ${JSON.stringify(args)}`, timeout, async () => {
        const result = await command(args);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /^message-transfer: /);
        assert.match(result.stderr, /directory|Unknown|port|max-payload|max-file|positive/i);
        assert.equal(result.stdout, '');
    });
}

for (const customDirectory of [true, false]) {
    test(
        `CLI persists data and prints the actual directory, explicit directory: ${customDirectory}`,
        timeout,
        async (t) => {
            const root = await tempDirectory();
            const directory = join(root, customDirectory ? 'custom' : 'received');
            // Windows 的 kill(SIGINT) 不会投递 POSIX 信号, 通过 IPC 触发同一个 Node 信号事件.
            const bootstrap = `process.on('message', () => { process.disconnect(); process.emit('SIGINT'); });
            await import(${JSON.stringify(cli)});
            if (process.exitCode) process.disconnect();`;
            const args = ['--port', '0', '--path', '/receive'];
            if (customDirectory) args.push('--directory', directory);
            const child = spawn(
                process.execPath,
                ['--import', loader, '--input-type=module', '--eval', bootstrap, '--', ...args],
                {
                    cwd: root,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                    env: { ...process.env, MESSAGE_TRANSFER_TOKEN: 'do-not-log-this-token' },
                },
            );
            let output = '';
            child.stdout?.on(
                'data',
                (data: Buffer) => {
                    output += data.toString();
                },
            );
            child.stderr?.on(
                'data',
                (data: Buffer) => {
                    output += data.toString();
                },
            );
            const exited = once(child, 'close');
            t.after(async () => {
                if (child.exitCode === null && child.signalCode === null) child.kill();
                await exited;
                await rm(root, { recursive: true, force: true });
            });
            const url = await listening(child);
            assert.match(url, /\/receive$/);
            const ws = await connect(`${url}?token=do-not-log-this-token`);
            const receipt = success(await send(ws, { group: 'cli', content: 'a' }));
            await send(ws, { group: 'cli', content: 'b' });
            assert.equal(receipt.file, 'default.txt');
            assert.equal(receipt.groupDirectory, 'cli');
            assert.equal(await readFile(receiptPath(directory, receipt), 'utf8'), 'a\nb\n');
            const raw = nextReceipt(ws);
            ws.send('unparsed text');
            const fallback = success(await raw);
            assert.equal(fallback.file, 'default.txt');
            assert.equal(fallback.groupDirectory, '');
            assert.equal(await readFile(receiptPath(directory, fallback), 'utf8'), 'unparsed text\n');
            assert.ok(output.includes(`Directory: ${directory}`));
            assert.ok(!output.includes('do-not-log-this-token'));
            const closed = once(ws, 'close');
            child.send('SIGINT');
            await closed;
            assert.equal((await exited)[0], 0);
        },
    );
}
