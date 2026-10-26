import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 在项目之外创建真实消费者, 防止工作区依赖掩盖漏打包或可选依赖问题.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'message-transfer-package-'));
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run this check using pnpm test:package.');

/**
 * 保留完整命令结果, 任一构建或消费者断言失败就终止验收.
 * @param {string} command 要执行的程序路径或命令.
 * @param {string[]} args 传给程序的参数列表.
 * @param {string} cwd 子进程工作目录.
 */
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env, CI: 'true' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    if (result.stdout) process.stdout.write(result.stdout);
}
/**
 * 兼容可执行版和脚本版 pnpm, 不通过不安全的 shell 字符串拼接参数.
 * @param {string[]} args pnpm 子命令及其参数.
 * @param {string} cwd 执行 pnpm 的工作目录.
 */
function runPnpm(args, cwd) {
    if (pnpm.endsWith('.exe')) run(pnpm, args, cwd);
    else run(process.execPath, [pnpm, ...args], cwd);
}

try {
    runPnpm(['pack', '--pack-destination', temporary]);
    const archive = (await readdir(temporary)).find(
        (file) => file.endsWith('.tgz'),
    );
    assert.ok(archive, 'pnpm pack must create an archive');
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(
        join(consumer, 'package.json'),
        JSON.stringify({
            name: 'isolated-consumer',
            private: true,
            type: 'module',
            dependencies: { '@xiaohaih/message-transfer-plugin': `file:${join(temporary, archive).replaceAll('\\', '/')}` },
        }),
    );
    await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
    runPnpm(['install', '--prod', '--ignore-scripts'], consumer);

    // 所有包导入都从隔离消费者解析, 不通过软链接回到本项目的 node_modules.
    await writeFile(
        join(consumer, 'verify.mjs'),
        `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { readFile, readdir } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { spawn } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import { createReceiver, ReceiptCode, ReceiverErrorCode } from '@xiaohaih/message-transfer-plugin';
    import { send as transfer, sendByFetch, sendBySocket } from '@xiaohaih/message-transfer-plugin/client';
    import { installClient } from '@xiaohaih/message-transfer-plugin/client-host';
    assert.deepEqual(Object.keys(await import('@xiaohaih/message-transfer-plugin/client')).sort(), ['ReceiptCode', 'ReceiverErrorCode', 'send', 'sendByFetch', 'sendBySocket']);
    assert.deepEqual(ReceiptCode, { SUCCESS: 0, FAILURE: 1 });
    const savedPath = receipt => join('received', receipt.date, receipt.groupDirectory, receipt.file);
    assert.equal(ReceiverErrorCode.INVALID_MESSAGE, 'INVALID_MESSAGE');
    const require = createRequire(import.meta.resolve('@xiaohaih/message-transfer-plugin'));
    assert.throws(() => require.resolve('vite'), { code: 'MODULE_NOT_FOUND' });
    for (const path of ['client-runtime', 'dist/client.js', 'src/client.ts']) {
      assert.throws(() => require.resolve('@xiaohaih/message-transfer-plugin/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    }
    const WebSocket = require('ws');
    const packageRoot = fileURLToPath(new URL('../', import.meta.resolve('@xiaohaih/message-transfer-plugin')));
    const manifest = JSON.parse(await readFile(new URL(import.meta.resolve('@xiaohaih/message-transfer-plugin/package.json')), 'utf8'));
    assert.equal(manifest.name, '@xiaohaih/message-transfer-plugin', 'The installed archive must have the requested package identity.');
    const files = await readdir(packageRoot);
    for (const required of ['dist', 'src', 'README.md', 'AGENTS.md', 'AI_CONTEXT.md']) {
      assert.ok(files.includes(required), 'Required package file missing: ' + required);
    }
    for (const document of ['AGENTS.md', 'AI_CONTEXT.md']) {
      const path = new URL('./' + document, import.meta.resolve('@xiaohaih/message-transfer-plugin/package.json'));
      const text = await readFile(path, 'utf8');
      assert.ok(text.startsWith('# AI'), document + ' must contain the AI onboarding guide');
      assert.ok(text.includes('[README.md](README.md)'), document + ' must link to the packaged usage guide');
    }
    for (const forbidden of ['tests', '.history', 'received', 'docs', '.certs']) assert.ok(!files.includes(forbidden));
    const examples = await readdir(join(packageRoot, 'examples'));
    for (const required of ['http.ts', 'https.ts', 'standalone.ts', 'sender.js', 'sender-host.js', 'sender.html']) assert.ok(examples.includes(required));
    const packaged = await readdir(packageRoot, { recursive: true });
    assert.ok(packaged.every(file => !/\\.(?:pem|key|p12|pfx)$/i.test(file)), 'Certificates and private keys must not be published.');
    /** 发送消息并校验消费者收到的成功回执.
     * @param {WebSocket} ws 已连接的消费者 WebSocket.
     * @param {object} message 要发送的消息内容.
     */
    async function send(ws, message) {
      const result = once(ws, 'message');
      ws.send(JSON.stringify(message));
      const receipt = JSON.parse(String((await result)[0]));
      assert.equal(receipt.ok, true);
      assert.equal(receipt.code, ReceiptCode.SUCCESS);
      return receipt;
    }
    // 不配置 directory, 检查产物而不是源码是否也使用 cwd/received.
    const receiver = createReceiver({ port: 0 });
    try {
      await receiver.start();
      const dispose = installClient({ endpoint: 'http://127.0.0.1:' + receiver.address.port + '/device-data' });
      try {
        const posted = await transfer({ group: 'sdk', name: 'events.log', content: 'one POST' });
        assert.equal(posted.ok, true);
        assert.equal(posted.code, ReceiptCode.SUCCESS);
        assert.equal(posted.file, 'events.log');
        assert.equal(await readFile(savedPath(posted), 'utf8'), 'one POST\\n');
        const explicit = await sendByFetch({ group: 'sdk', name: 'events.log', content: ' + explicit POST', autoNewline: false });
        assert.equal(explicit.ok, true);
        assert.equal(explicit.file, posted.file);
        assert.equal(await readFile(savedPath(posted), 'utf8'), 'one POST\\n + explicit POST');
        await assert.rejects(sendBySocket({ group: 'sdk', content: 'not sent' }), /No shared socket or HMR channel is available/);
        assert.equal(await readFile(savedPath(posted), 'utf8'), 'one POST\\n + explicit POST');
        const structured = await transfer({ name: 'object.json', content: { event: 'packed' }, autoNewline: false });
        assert.equal(structured.ok, true);
        assert.equal(await readFile(savedPath(structured), 'utf8'), '{"event":"packed"}');
        const snapshot = await sendByFetch(new File(['{"event":"packed"}'], 'object.json'));
        assert.equal(snapshot.ok, true);
        assert.equal(snapshot.file, 'object(1).json');
        assert.equal((await transfer({ name: 'object.json', content: 'later', autoNewline: false })).ok, true);
        assert.equal(await readFile(savedPath(snapshot), 'utf8'), '{"event":"packed"}');
        const binary = await sendByFetch({ file: new Blob([new Uint8Array([255, 0, 80, 75])]), name: 'packed.xlsx', group: 'files' });
        assert.equal(binary.ok, true);
        assert.equal(binary.kind, 'file');
        assert.equal(binary.bytes, 4);
        assert.equal(binary.originalName, 'packed.xlsx');
        assert.equal(binary.file, 'packed.xlsx');
        assert.equal(binary.groupDirectory, 'files');
        assert.deepEqual(await readFile(savedPath(binary)), Buffer.from([255, 0, 80, 75]));
        const duplicate = await sendByFetch({ file: new Blob([new Uint8Array([255, 0, 80, 75])]), name: 'packed.xlsx', group: 'files' });
        assert.deepEqual(duplicate, binary);
        assert.deepEqual((await readdir(join('received', binary.date, 'files'))).sort(), ['.message-transfer-files', 'packed.xlsx']);
        const collision = await transfer({ group: 'files', name: 'packed.xlsx', content: 'must not append' });
        assert.equal(collision.code, ReceiptCode.FAILURE);
        assert.equal(collision.error.code, ReceiverErrorCode.FILE_NAME_CONFLICT);
        assert.deepEqual(await readFile(savedPath(binary)), Buffer.from([255, 0, 80, 75]));
        const invalid = await transfer('null');
        assert.equal(invalid.ok, false);
        assert.equal(invalid.error.code, ReceiverErrorCode.INVALID_MESSAGE);
      } finally { dispose(); }
      for (const module of ['client', 'client-host', 'client-runtime', 'client-files', 'content', 'file-protocol', 'names', 'errors']) {
        const source = await readFile(new URL('./' + module + '.js', import.meta.resolve('@xiaohaih/message-transfer-plugin')), 'utf8');
        assert.ok(!source.includes('node:') && !source.includes("from 'ws'") && !source.includes("from 'vite'"));
      }
      const ws = new WebSocket('ws://127.0.0.1:' + receiver.address.port + '/device-data');
      await once(ws, 'open');
      const first = await send(ws, { group: 'packed', content: 'hello' });
      const second = await send(ws, { group: 'packed', content: ' world' });
      assert.equal(first.file, second.file);
      assert.equal(first.file, 'default.txt');
      assert.equal(first.groupDirectory, 'packed');
      assert.equal(await readFile(savedPath(first), 'utf8'), 'hello\\n world\\n');
      assert.equal(receiver.directory, join(process.cwd(), 'received'));
      const rawReply = once(ws, 'message');
      ws.send('raw packaged message');
      const fallback = JSON.parse(String((await rawReply)[0]));
      assert.equal(fallback.ok, true);
      assert.equal(fallback.file, 'default.txt');
      assert.equal(fallback.groupDirectory, '');
      assert.equal(await readFile(savedPath(fallback), 'utf8'), 'raw packaged message\\n');
      const rejected = once(ws, 'message');
      ws.send(JSON.stringify({ content: 'invalid override', autoNewline: null }));
      const invalid = JSON.parse(String((await rejected)[0]));
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, ReceiverErrorCode.INVALID_MESSAGE);
    } finally { await receiver.stop(); }
    const cliUrl = new URL('./cli.js', import.meta.resolve('@xiaohaih/message-transfer-plugin'));
    const bootstrap = "process.on('message', () => { process.disconnect(); process.emit('SIGTERM'); }); await import("
      + JSON.stringify(cliUrl.href) + "); if (process.exitCode) process.disconnect();";
    const childEnv = { ...process.env };
    delete childEnv.MESSAGE_TRANSFER_TOKEN;
    // 编译后的 CLI 也省略目录, 使用不同 group 避免与前面的默认组数据合并.
    const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap, '--', '--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnv });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exit = once(child, 'close');
    try {
      const address = await new Promise((resolve, reject) => {
        let stdout = '';
        child.stdout.on('data', chunk => {
          stdout += chunk.toString();
          const match = /Listening on (ws:\\/\\/[^\\s]+)/.exec(stdout);
          if (match) resolve(match[1]);
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error('CLI exited ' + code + ': ' + stderr)));
      });
      const client = new WebSocket(address);
      await once(client, 'open');
      const saved = await send(client, { group: 'cli', content: 'compiled CLI' });
      assert.equal(saved.file, 'default.txt');
      assert.equal(saved.groupDirectory, 'cli');
      assert.equal(await readFile(savedPath(saved), 'utf8'), 'compiled CLI\\n');
      child.send('stop');
      assert.equal((await exit)[0], 0, stderr);
    } finally {
      if (child.exitCode === null) { child.kill(); await exit; }
    }
    console.log('Isolated AI docs + runtime + compiled CLI passed; Vite is not installed.');
  `,
    );
    run(process.execPath, ['verify.mjs'], consumer);

    // CommonJS 消费者保留 .cjs, 通过原生动态 import 使用纯 ESM 包, 不新增 require 导出.
    await writeFile(join(consumer, 'verify.cjs'), `
    const assert = require('node:assert/strict');
    const { readFile } = require('node:fs/promises');
    const { join } = require('node:path');
    async function main() {
      const { createReceiver } = await import('@xiaohaih/message-transfer-plugin');
      const { sendByFetch } = await import('@xiaohaih/message-transfer-plugin/client');
      const { installClient } = await import('@xiaohaih/message-transfer-plugin/client-host');
      const receiver = createReceiver({ directory: 'commonjs-data', port: 0, autoNewline: true });
      let dispose;
      try {
        await receiver.start();
        dispose = installClient({ endpoint: 'http://127.0.0.1:' + receiver.address.port + '/device-data' });
        const first = await sendByFetch({ content: { source: 'commonjs' }, autoNewline: false });
        assert.equal(first.ok, true);
        const second = await sendByFetch({ content: 7 });
        assert.equal(second.ok, true);
        assert.equal(await readFile(join(receiver.directory, first.date, first.groupDirectory, first.file), 'utf8'), '{"source":"commonjs"}7\\n');
      } finally { if (dispose) dispose(); await receiver.stop(); }
      console.log('Isolated CommonJS dynamic import passed.');
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `);
    run(process.execPath, ['verify.cjs'], consumer);

    await writeFile(
        join(consumer, 'consumer.ts'),
        `
    import { createReceiver, ReceiptCode, ReceiverErrorCode, type MessageOption, type SocketAdapter } from '@xiaohaih/message-transfer-plugin';
    import type { ReceiverErrorCode as ErrorCode, Receipt } from '@xiaohaih/message-transfer-plugin';
    import { send as transfer, sendByFetch, sendBySocket } from '@xiaohaih/message-transfer-plugin/client';
    import { installClient } from '@xiaohaih/message-transfer-plugin/client-host';
    const browserSocket: WebSocket = null as never;
    const dispose = installClient({ socket: browserSocket, request: fetch });
    const transferred: Promise<Receipt> = transfer({ content: { event: 'client types' }, autoNewline: false });
    const posted: Promise<Receipt> = sendByFetch('raw client text');
    const socketSent: Promise<Receipt> = sendBySocket({ group: 'types', content: 42, autoNewline: true });
    // @ts-expect-error 换行覆盖只接受布尔值, 不接受字符串.
    transfer({ content: null, autoNewline: 'false' });
    const binary = new File([new Uint8Array([255, 0])], 'photo.png');
    const fileAuto: Promise<Receipt> = transfer(binary);
    const fileFetch: Promise<Receipt> = sendByFetch({ file: binary, name: 'copy.png', group: 'files' });
    const fileSocket: Promise<Receipt> = sendBySocket(new Blob([]));
    // @ts-expect-error 文件参数必须是明确提供的 Blob/File, 不接受任意磁盘路径.
    transfer({ file: '/private/key' });
    void fileAuto; void fileFetch; void fileSocket;
    // @ts-expect-error 自动发送仍不接受显式选择通道的参数.
    transfer({ content: 'text' }, { channel: 'http' });
    // @ts-expect-error 显式 Fetch 使用已安装的宿主配置, 不接受额外通道参数.
    sendByFetch('text', { channel: 'socket' });
    // @ts-expect-error 显式 Socket 不提供 HTTP 回退选项.
    sendBySocket('text', { fallback: 'http' });
    void dispose; void transferred; void posted; void socketSent;
    const code: ReceiverErrorCode = ReceiverErrorCode.WRITE_FAILED;
    const literal: 'WRITE_FAILED' = ReceiverErrorCode.WRITE_FAILED;
    const compatible: ErrorCode = 'WRITE_FAILED';
    // @ts-expect-error 错误码类型不接受常量对象之外的值.
    const invalid: ErrorCode = 'NOT_A_CODE';
    // @ts-expect-error as const 的成员必须保持只读类型.
    ReceiverErrorCode.WRITE_FAILED = 'WRITE_FAILED';
    const message: MessageOption = { group: 'a', name: 'events.log', content: [1, null, false], autoNewline: true };
    const resultCode: ReceiptCode = ReceiptCode.FAILURE;
    const successLiteral: 0 = ReceiptCode.SUCCESS;
    // @ts-expect-error 数字结果码只接受对象中的字面量值.
    const badResult: ReceiptCode = 2;
    void resultCode; void successLiteral; void badResult;
    const adapter: SocketAdapter = {
      attach(context) { context.matches({ url: '/' } as never); return { dispose() {} }; }
    };
    const receiver = createReceiver({ adapter, autoNewline: false,
      processContent(content, context) { return context.group + content; }
    });
    const defaults = createReceiver();
    const directory: string = defaults.directory;
    void receiver; void message; void directory; void code; void literal; void compatible; void invalid;
  `,
    );
    // 旧编译器只安装到临时工具目录, 不改变本库或宿主依赖.
    const tools = join(temporary, 'type-tools');
    await mkdir(tools);
    await writeFile(join(tools, 'package.json'), JSON.stringify({
        name: 'isolated-type-tools',
        private: true,
        dependencies: { typescript: '4.9.5' },
    }));
    runPnpm(['install', '--prod', '--ignore-scripts'], tools);
    await writeFile(join(consumer, 'verify-types.cjs'), `
    const assert = require('node:assert/strict');
    const { join, normalize } = require('node:path');
    const [compilerPath, moduleResolution, skipLibCheck] = process.argv.slice(2);
    const ts = require(compilerPath);
    const { options, errors } = ts.convertCompilerOptionsFromJson({
      noEmit: true, strict: true, target: 'ES2022', esModuleInterop: true,
      module: ['Node16', 'NodeNext'].includes(moduleResolution) ? moduleResolution : 'ESNext',
      moduleResolution, skipLibCheck: skipLibCheck === 'true',
    }, process.cwd());
    assert.deepEqual(errors, []);
    const source = join(process.cwd(), 'consumer.ts');
    const packageRoot = join(process.cwd(), 'node_modules/@xiaohaih/message-transfer-plugin');
    // /vite 验证入口发现, 不安装可选 peer 或假冒 Vite 声明来声称旧编译器兼容其依赖图.
    for (const [subpath, file] of [['', 'index'], ['/client', 'client'], ['/client-host', 'client-host'], ['/vite', 'vite']]) {
      const specifier = '@xiaohaih/message-transfer-plugin' + subpath;
      const resolved = ts.resolveModuleName(specifier, source, options, ts.sys).resolvedModule;
      assert.ok(resolved, ts.version + ' / ' + moduleResolution + ' must resolve ' + specifier);
      assert.equal(normalize(ts.sys.realpath(resolved.resolvedFileName)),
        normalize(ts.sys.realpath(join(packageRoot, 'dist', file + '.d.ts'))));
    }
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([source], options));
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\\n',
    }));
    console.log('TypeScript ' + ts.version + ' / ' + moduleResolution + ': public entries and consumer types passed (skipLibCheck=' + options.skipLibCheck + ').');
    `);
    // 现代矩阵继续完整检查声明; TS 4.9 单独隔离现代 @types/node 的声明检查, 仍检查消费者及负向用例.
    for (const [compiler, modes, skipLibCheck] of [
        [join(tools, 'node_modules/typescript/lib/typescript.js'), ['Node', 'Node16', 'NodeNext'], true],
        [join(root, 'node_modules/typescript/lib/typescript.js'), ['NodeNext', 'Node16', 'Bundler', 'Node'], false],
    ]) {
        for (const mode of modes) {
            run(process.execPath, ['verify-types.cjs', compiler, mode, String(skipLibCheck)], consumer);
        }
    }
    const builtCli = await readFile(join(root, 'dist/cli.js'), 'utf8');
    assert.ok(builtCli.startsWith('#!/usr/bin/env node'));
    console.log('Isolated consumer type declarations and CLI shebang passed.');
}
finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
