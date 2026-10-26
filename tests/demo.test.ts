import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as requestHttps } from 'node:https';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installClient } from '../src/client-host.js';
import { send as clientSend, sendByFetch, sendBySocket } from '../src/client.js';
import { closeServer, connect, listen, nextReceipt, receiptPath, send, success, tempDirectory } from './helpers.js';

// 子进程从临时工作目录启动真实示例, 防止测试回执写入用户自己的 received 目录.
const project = fileURLToPath(new URL('../', import.meta.url));
const loader = import.meta.resolve('tsx');
const timeout = { timeout: 20000 };
const certFile = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url));
const keyFile = fileURLToPath(new URL('./fixtures/localhost-key.pem', import.meta.url));
let ca: Buffer;

before(async () => {
    ca = await readFile(certFile);
    for (const config of ['tsconfig.build.json', 'tsconfig.browser.json']) {
        await promisify(execFile)(process.execPath, [
            join(project, 'node_modules/typescript/bin/tsc'),
            '-p',
            join(project, config),
        ]);
    }
});

test('package scripts provide build-first Vite, standalone WS, HTTP and HTTPS examples', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.scripts['demo:vite'] ?? '', /pnpm build.*vite.*examples\/vite\.config\.ts/);
    assert.match(pkg.scripts['demo:ws'] ?? '', /pnpm build.*tsx.*examples\/standalone\.ts/);
    assert.match(pkg.scripts['demo:http'] ?? '', /pnpm build.*tsx.*examples\/http\.ts/);
    assert.match(pkg.scripts['demo:https'] ?? '', /pnpm build.*tsx.*examples\/https\.ts/);
    for (const extension of ['pem', 'key', 'p12', 'pfx']) assert.ok(pkg.files.includes(`!**/*.${extension}`));
});

/**
 * 只信任公开测试证书, 不改变全局 TLS 策略, 不跟随重定向或自动重试.
 * @param {string | URL} input 测试拥有的本地 HTTP(S) 地址.
 * @param {RequestInit} init SDK 或测试传入的单次请求选项.
 */
async function demoFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    if (url.protocol === 'http:') return fetch(url, init);
    return new Promise<Response>((resolve, reject) => {
        const requestHeaders: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => {
            requestHeaders[name] = value;
        });
        const request = requestHttps(url, {
            ca,
            method: init.method ?? 'GET',
            headers: requestHeaders,
            signal: init.signal ?? undefined,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => {
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
                }
                resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode!, headers }));
            });
        });
        request.once('error', reject);
        if (init.body instanceof Blob) {
            const reader = init.body.stream().getReader();
            void (async () => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!request.write(value)) await once(request, 'drain');
                    }
                    request.end();
                }
                finally {
                    await reader.cancel();
                    reader.releaseLock();
                }
            })().catch((error) => request.destroy(error));
        }
        else {
            request.end(init.body);
        }
    });
}

/**
 * 等待页面地址和目录日志, 进程异常退出会立即让测试失败.
 * @param {TestContext} t 注册 demo 子进程退出和临时目录清理的测试上下文.
 * @param {'vite' | 'ws' | 'http' | 'https'} mode 要启动的示例模式, 决定入口及页面监听方式.
 * @param {boolean} customDirectory 是否显式设置保存目录, false 时验证默认 received 目录.
 * @param {number} port 监听端口, 默认由系统分配, 冲突测试使用测试自己占用的端口.
 * @param {string} base Vite 示例的公共基础路径, 其他示例模式不使用.
 */
async function startDemo(t: TestContext, mode: 'vite' | 'ws' | 'http' | 'https', customDirectory = false, port = 0, base = '/') {
    const root = await tempDirectory();
    const directory = join(root, customDirectory ? 'custom' : 'received');
    const onSignal = `process.on('message', () => { process.disconnect(); process.emit('SIGINT'); });`;
    const configFile = fileURLToPath(new URL('../examples/vite.config.ts', import.meta.url));
    const script =
        mode === 'vite'
            ? `import { createServer } from ${JSON.stringify(import.meta.resolve('vite'))};
           const server = await createServer({ configFile: ${JSON.stringify(configFile)}, clearScreen: false,
             base: ${JSON.stringify(base)}, envFile: false,
             server: { host: '127.0.0.1', port: 0, open: false, watch: null }, optimizeDeps: { noDiscovery: true } });
           process.on('message', async () => { process.disconnect(); await server.close(); });
           await server.listen();
           const port = server.httpServer.address().port;
           console.log('Page: http://127.0.0.1:' + port + ${JSON.stringify(`${base}sender.html`)});
           console.log('WebSocket: ws://127.0.0.1:' + port + '/device-data');`
            : `${onSignal} await import(${JSON.stringify(new URL(mode === 'ws' ? '../examples/standalone.ts' : `../examples/${mode}.ts`, import.meta.url).href)});
           if (process.exitCode) process.disconnect();`;
    const args = mode === 'vite' ? [] : ['--host', '127.0.0.1', '--port', String(port)];
    if (mode === 'ws') args.push('--page-port', '0');
    if (mode === 'https') args.push('--cert', certFile, '--key', keyFile);
    if (customDirectory && mode !== 'vite') args.push('--directory', directory);
    const env = { ...process.env, MESSAGE_TRANSFER_TOKEN: 'test-demo-token' };
    delete (env as NodeJS.ProcessEnv).MESSAGE_TRANSFER_DIRECTORY;
    if (customDirectory && mode === 'vite') (env as NodeJS.ProcessEnv).MESSAGE_TRANSFER_DIRECTORY = directory;
    const child = spawn(
        process.execPath,
        ['--import', loader, '--input-type=module', '--eval', script, '--', ...args],
        {
            cwd: root,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
    );
    let output = '';
    const exited = once(child, 'close');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const ready = new Promise<{ page: string; websocket: string }>(
        (resolve, reject) => {
            const inspect = (chunk: Buffer) => {
                output += chunk.toString();
                const page = /Page: (https?:\/\/\S+)/.exec(output)?.[1];
                const websocket = /(?:^|\n)WebSocket: (wss?:\/\/\S+)/.exec(output)?.[1];
                const businessReady = (mode !== 'ws' && mode !== 'https') || /Business WebSocket: wss?:\/\/\S+/.test(output);
                if (page && websocket && businessReady) resolve({ page, websocket });
            };
            child.stdout?.on('data', inspect);
            child.stderr?.on('data', inspect);
            child.once('error', reject);
            child.once(
                'exit',
                (code) => reject(new Error(`demo ${mode} exited ${code}: ${output}`)),
            );
        },
    );
    return { ...(await ready), directory, child, exited, output: () => output };
}

for (const base of ['/', '/nested/']) {
    test(`demo:vite redirects its ${base} entry to the working sender page`, timeout, async (t) => {
        const demo = await startDemo(t, 'vite', false, 0, base);
        const entry = new URL('./', demo.page);
        for (const method of ['GET', 'HEAD']) {
            const response = await fetch(new URL('?probe=entry', entry), { method, redirect: 'manual' });
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), `${base}sender.html`);
            assert.equal(await response.text(), '');
        }
        const page = await fetch(entry);
        assert.equal(page.status, 200);
        assert.equal(page.url, demo.page);
        assert.match(await page.text(), /id="message-form"/);

        // 获取页面模块及 SDK 的真实转换结果, 不是浏览器执行或 DOM 模拟测试.
        const pending = [new URL('sender.js', entry).href, new URL('sender-host.js', entry).href];
        const visited = new Set<string>();
        while (pending.length) {
            const url = pending.shift()!;
            if (visited.has(url)) continue;
            visited.add(url);
            const module = await fetch(url);
            assert.equal(module.status, 200);
            assert.match(module.headers.get('content-type') ?? '', /javascript/);
            for (const match of (await module.text()).matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
                const dependency = new URL(match[1]!, url);
                if (dependency.origin === entry.origin && !dependency.pathname.endsWith('/@vite/client')) pending.push(dependency.href);
            }
        }
        assert.ok([...visited].some((url) => url.includes('message-transfer:auto-client')));
        assert.ok([...visited].some((url) => url.endsWith('/dist/client-runtime.js')));
        assert.equal((await fetch(entry, { method: 'POST', redirect: 'manual' })).status, 404);
        assert.equal((await fetch(new URL('missing-page', entry), { redirect: 'manual' })).status, 404);
        assert.equal((await fetch(new URL('device-data', entry), { method: 'POST', body: 'unauthorized', redirect: 'manual' })).status, 401);
    });
}

for (const mode of ['vite', 'ws', 'http', 'https'] as const) {
    test(
        `demo:${mode} serves sender and persists grouped/raw messages in its printed default directory`,
        timeout,
        async (t) => {
            const demo = await startDemo(t, mode);
            const page = new URL(demo.page);
            const response = await demoFetch(page);
            assert.equal(response.status, 200);
            const html = await response.text();
            assert.match(html, /id="token"/);
            assert.doesNotMatch(html, /id="endpoint"/);
            assert.match(html, /id="method"/);
            assert.match(html, /value="sendByFetch"/);
            assert.match(html, /value="sendBySocket"/);
            assert.match(html, new RegExp(`data-business-socket="${mode === 'ws' || mode === 'https' ? 'true' : ''}"`));
            assert.match(html, /sender\.js/);
            const script = await demoFetch(new URL('/sender.js', page));
            assert.equal(script.status, 200);
            const senderScript = await script.text();
            assert.match(senderScript, /sendByFetch/);
            assert.match(senderScript, /sendBySocket/);
            assert.doesNotMatch(senderScript, /new WebSocket/);
            const hostScript = await demoFetch(new URL('/sender-host.js', page));
            assert.equal(hostScript.status, 200);
            assert.match(await hostScript.text(), /installClient/);
            if (mode !== 'vite') {
                for (const module of ['client', 'client-host', 'client-runtime', 'client-files', 'content', 'file-protocol', 'names', 'errors']) {
                    const asset = await demoFetch(new URL(`/@message-transfer/${module}.js`, page));
                    assert.equal(asset.status, 200);
                    assert.doesNotMatch(await asset.text(), /from ['"](?:node:|ws|vite['"])/);
                }
                for (const path of ['/@message-transfer/receiver.js', '/@message-transfer/file-store.js', '/@message-transfer/file-http.js', '/tests/fixtures/localhost-key.pem', '/.certs/localhost-key.pem']) {
                    assert.equal((await demoFetch(new URL(path, page))).status, 404);
                }
            }
            const endpoint = new URL('/device-data', page);
            assert.equal((await demoFetch(endpoint, { method: 'POST', body: 'unauthorized' })).status, 401);
            const posted = await demoFetch(endpoint, {
                method: 'POST',
                headers: { Authorization: 'Bearer test-demo-token', Origin: page.origin },
                body: '{"group":"post","content":"one POST"}',
            });
            assert.equal(posted.status, 200);
            const postReceipt = success(await posted.json());
            assert.equal(await readFile(receiptPath(demo.directory, postReceipt), 'utf8'), 'one POST\n');
            const url = new URL(demo.websocket);
            assert.match(html, new RegExp(`data-ws-port="${mode === 'ws' ? url.port : ''}"`));
            const tls = mode === 'https' ? { ca } : {};
            await assert.rejects(connect(url.href, { origin: page.origin, ...tls }), /Unexpected server response: 401/);
            url.searchParams.set('token', 'test-demo-token');
            await assert.rejects(
                connect(url.href, { origin: 'https://unrelated.example', ...tls }),
                /Unexpected server response: 403/,
            );
            const ws = await connect(url.href, { origin: page.origin, ...tls });
            const first = success(await send(ws, { group: 'notes', content: '一\n' }));
            const second = success(await send(ws, { group: 'notes', content: '二' }));
            assert.equal(second.file, first.file);
            assert.equal(first.file, 'default.txt');
            assert.equal(first.groupDirectory, 'notes');
            assert.equal(await readFile(receiptPath(demo.directory, first), 'utf8'), '一\n二\n');
            const defaultJson = success(await send(ws, { content: '默认 JSON\n' }));
            const rawReply = nextReceipt(ws);
            ws.send('  未封装的文本\n');
            const raw = success(await rawReply);
            assert.equal(raw.file, defaultJson.file);
            assert.equal(raw.file, 'default.txt');
            assert.equal(raw.groupDirectory, '');
            assert.equal(await readFile(receiptPath(demo.directory, raw), 'utf8'), '默认 JSON\n  未封装的文本\n');
            assert.ok(demo.output().includes(`Directory: ${demo.directory}`));
            assert.ok(!demo.output().includes('test-demo-token'));
            const privateUrl =
                mode === 'vite'
                    ? new URL(`/@fs/${receiptPath(demo.directory, first).replaceAll('\\', '/')}`, page)
                    : new URL(`/received/${first.date}/${first.groupDirectory}/${first.file}`, page);
            assert.notEqual((await demoFetch(privateUrl)).status, 200);
            const closed = once(ws, 'close');
            demo.child.send('stop');
            await closed;
            assert.equal((await demo.exited)[0], 0);
        },
    );
}

for (const mode of ['vite', 'ws', 'http', 'https'] as const) {
    test(
        `demo:${mode} honors an explicitly configured directory`,
        timeout,
        async (t) => {
            const demo = await startDemo(t, mode, true);
            const url = new URL(demo.websocket);
            url.searchParams.set('token', 'test-demo-token');
            const ws = await connect(url.href, { origin: new URL(demo.page).origin, ...(mode === 'https' ? { ca } : {}) });
            const saved = success(await send(ws, { content: 'custom' }));
            assert.equal(await readFile(receiptPath(demo.directory, saved), 'utf8'), 'custom\n');
            assert.ok(demo.output().includes(`Directory: ${demo.directory}`));
            demo.child.send('stop');
            assert.equal((await demo.exited)[0], 0);
        },
    );
}

// 外部页面监听仍严格使用指定端口, 独立接收器的自动换端口行为另行验证.
for (const mode of ['ws', 'http', 'https'] as const) {
    test(
        `demo:${mode} exits cleanly on a port conflict without stopping the occupied host`,
        timeout,
        async (t) => {
            const root = await tempDirectory();
            const host = createServer(
                (_request, response) => response.end('occupied host'),
            );
            t.after(async () => {
                await closeServer(host);
                await rm(root, { recursive: true, force: true });
            });
            const port = await listen(host);
            const file = fileURLToPath(
                new URL(mode === 'ws' ? '../examples/standalone.ts' : `../examples/${mode}.ts`, import.meta.url),
            );
            const args = ['--import', loader, file, '--host', '127.0.0.1', '--port', mode === 'ws' ? '0' : String(port)];
            if (mode === 'ws') args.push('--page-port', String(port));
            if (mode === 'https') args.push('--cert', certFile, '--key', keyFile);
            const env = { ...process.env };
            delete env.MESSAGE_TRANSFER_TOKEN;
            delete env.MESSAGE_TRANSFER_DIRECTORY;
            await assert.rejects(
                promisify(execFile)(process.execPath, args, { cwd: root, env, timeout: 8000 }),
                (error: unknown) => {
                    const failure = error as Error & { code: number; stderr: string };
                    assert.equal(failure.code, 1);
                    assert.match(failure.stderr, /EADDRINUSE/);
                    return true;
                },
            );
            assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'occupied host');
        },
    );
}

test('demo:ws prints its actual alternate direct WS port without touching the occupied host', timeout, async (t) => {
    const host = createServer((_request, response) => response.end('occupied host'));
    const port = await listen(host);
    t.after(() => closeServer(host));
    const demo = await startDemo(t, 'ws', false, port);
    const direct = new URL(demo.websocket);
    assert.notEqual(Number(direct.port), port);
    const html = await (await fetch(demo.page)).text();
    assert.ok(html.includes(`data-ws-port="${direct.port}"`));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'occupied host');
    demo.child.send('stop');
    assert.equal((await demo.exited)[0], 0);
});

for (const mode of ['ws', 'https'] as const) {
    test(`demo:${mode} persists all SDK methods using real shared WS/WSS and HTTP(S) without fallback`, timeout, async (t) => {
        const demo = await startDemo(t, mode);
        const page = new URL(demo.page);
        const url = new URL('/business-socket', page);
        url.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
        const tls = mode === 'https' ? { ca } : {};
        assert.ok(demo.output().includes(`Business WebSocket: ${url.href}`));
        await assert.rejects(connect(url.href, { origin: 'http://unrelated.example', ...tls }), /403/);
        await assert.rejects(connect(url.href, { ...tls }), /403/);
        await assert.rejects(connect(new URL('/other-socket', url).href, { origin: page.origin, ...tls }));
        const socket = await connect(url.href, { origin: page.origin, ...tls });
        t.after(() => socket.terminate());
        let token: string | undefined;
        let posts = 0;
        const dispose = installClient({ socket, token: () => token, endpoint: new URL('/device-data', page).href, request: (input, init) => {
            posts++;
            const headers = new Headers(init?.headers);
            headers.set('Origin', page.origin);
            return demoFetch(input, { ...init, headers });
        } });
        t.after(dispose);
        const denied = await sendBySocket('denied');
        assert.equal(denied.ok, false);
        if (!denied.ok) assert.equal(denied.error.code, 'UNAUTHORIZED');
        token = 'test-demo-token';
        const pong = once(socket, 'message');
        socket.send('demo:ping');
        assert.equal(String((await pong)[0]), 'demo:pong');
        const first = success(await clientSend({ group: 'sdk', name: 'events.log', content: 'auto|' }));
        const second = success(await sendByFetch({ group: 'sdk', name: 'events.log', content: 'fetch|' }));
        const third = success(await sendBySocket({ group: 'sdk', name: 'events.log', content: 'socket|' }));
        assert.equal(first.file, 'events.log');
        assert.equal(second.file, first.file);
        assert.equal(third.file, first.file);
        assert.equal(posts, 1);
        assert.equal(await readFile(receiptPath(demo.directory, first), 'utf8'), 'auto|\nfetch|\nsocket|\n');
        const closed = once(socket, 'close');
        socket.close();
        await closed;
        await assert.rejects(sendBySocket('must not POST'), /No shared socket or HMR channel is available/);
        assert.equal(posts, 1);
        assert.equal(await readFile(receiptPath(demo.directory, first), 'utf8'), 'auto|\nfetch|\nsocket|\n');
        const raw = success(await sendByFetch(' raw after disconnect\n'));
        assert.equal(await readFile(receiptPath(demo.directory, raw), 'utf8'), ' raw after disconnect\n');
        const alive = await connect(url.href, { origin: page.origin, ...tls });
        const stopped = once(alive, 'close');
        demo.child.send('stop');
        await stopped;
        assert.equal((await demo.exited)[0], 0);
    });
}

test('demo:http exercises Fetch and rejects socket-only sends rather than silently posting', timeout, async (t) => {
    const demo = await startDemo(t, 'http');
    let posts = 0;
    t.after(installClient({ token: 'test-demo-token', endpoint: new URL('/device-data', demo.page).href, request: (input, init) => {
        posts++;
        return fetch(input, init);
    } }));
    assert.equal((await clientSend('auto HTTP')).ok, true);
    assert.equal((await sendByFetch('explicit HTTP')).ok, true);
    await assert.rejects(sendBySocket('no socket'), /No shared socket or HMR channel is available/);
    assert.equal(posts, 2);
    demo.child.send('stop');
    assert.equal((await demo.exited)[0], 0);
});

test('demo shared host bounds connection count independently of receiver-owned direct sockets', timeout, async (t) => {
    const demo = await startDemo(t, 'ws');
    const page = new URL(demo.page);
    const url = new URL('/business-socket', page);
    url.protocol = 'ws:';
    for (let index = 0; index < 32; index++) {
        const socket = await connect(url.href, { origin: page.origin });
        t.after(() => socket.terminate());
    }
    await assert.rejects(connect(url.href, { origin: page.origin }), /503/);
    demo.child.send('stop');
    assert.equal((await demo.exited)[0], 0);
});

for (const mode of ['http', 'ws', 'https'] as const) {
    test(`demo:${mode} saves original files through every available SDK transport`, timeout, async (t) => {
        const demo = await startDemo(t, mode);
        const page = new URL(demo.page);
        const html = await (await demoFetch(page)).text();
        assert.match(html, /type="file"/);
        assert.match(html, /<fieldset\b[^>]+id="format"/);
        assert.match(html, /type="radio"[^>]*name="format"/);
        assert.doesNotMatch(html, /<select\b[^>]+id="format"/);
        assert.match(html, /100 MiB/);
        const socket = mode === 'http' ? undefined : await connect(`${mode === 'https' ? 'wss:' : 'ws:'}//${page.host}/business-socket`, { origin: page.origin, ...(mode === 'https' ? { ca } : {}) });
        t.after(() => socket?.terminate());
        const dispose = installClient({ endpoint: new URL('/device-data', page).href, token: 'test-demo-token', request: demoFetch, ...(socket ? { socket } : {}) });
        t.after(dispose);
        const bytes = new Uint8Array(131073).fill(165);
        const file = new File([bytes], '原始文件.xlsx');
        const names = new Set<string>();
        for (const method of mode === 'http' ? [clientSend, sendByFetch] : [clientSend, sendByFetch, sendBySocket]) {
            const receipt = await method({ file, group: '' });
            assert.ok(receipt.ok && 'kind' in receipt && receipt.kind === 'file');
            assert.equal(receipt.file, '原始文件.xlsx');
            assert.equal(receipt.code, 0);
            assert.deepEqual(await readFile(receiptPath(demo.directory, receipt)), Buffer.from(bytes));
            names.add(receipt.file);
            assert.equal((await demoFetch(new URL(`/received/${receipt.date}/${encodeURIComponent(receipt.file)}`, page))).status, 404);
            const renamed = success(await method({ file, group: '资料', name: '重命名.xlsx' }));
            assert.equal(renamed.groupDirectory, '资料');
            assert.equal(renamed.file, '重命名.xlsx');
            assert.deepEqual(await readFile(receiptPath(demo.directory, renamed)), Buffer.from(bytes));
            const conflict = await method({ group: '资料', name: renamed.file, content: 'not appended' });
            assert.ok(!conflict.ok);
            assert.equal(conflict.code, 1);
            assert.equal(conflict.error.code, 'FILE_NAME_CONFLICT');
            const differentBytes = bytes.slice();
            differentBytes[0] = 0;
            const different = success(await method({ file: new Blob([differentBytes]), name: file.name }));
            assert.equal(different.file, '原始文件(1).xlsx');
            assert.deepEqual(await readFile(receiptPath(demo.directory, different)), Buffer.from(differentBytes));
        }
        assert.equal(names.size, 1, 'Every transport reuses the same fully received original file.');
        if (mode === 'http') await assert.rejects(sendBySocket(file), /No shared socket/);
    });
}

test('HTTPS demo help describes required certificates without starting or exposing a private key', timeout, async () => {
    const result = await promisify(execFile)(process.execPath, [
        '--import',
        loader,
        fileURLToPath(new URL('../examples/https.ts', import.meta.url)),
        '--help',
    ]);
    assert.match(result.stdout, /--cert/);
    assert.match(result.stdout, /--key/);
    assert.doesNotMatch(result.stdout, /Page:|Directory:|BEGIN .*PRIVATE KEY/);
});

for (const args of [[], ['--cert', certFile], ['--cert', certFile, '--key', keyFile, '--page-port', '0']]) {
    test(`HTTPS demo rejects incomplete or unsupported TLS options ${JSON.stringify(args.map((value) => value.endsWith('.pem') ? '<fixture>' : value))}`, timeout, async (t) => {
        const root = await tempDirectory();
        t.after(() => rm(root, { recursive: true, force: true }));
        await assert.rejects(promisify(execFile)(process.execPath, [
            '--import',
            loader,
            fileURLToPath(new URL('../examples/https.ts', import.meta.url)),
            ...args,
        ], { cwd: root, timeout: 5000 }), (error: unknown) => {
            const failure = error as Error & { code: number; stdout: string; stderr: string };
            assert.equal(failure.code, 1);
            assert.match(failure.stderr, /--cert|--key|--page-port/);
            assert.doesNotMatch(failure.stdout, /Directory:|Page:/);
            assert.doesNotMatch(failure.stderr, /BEGIN .*PRIVATE KEY/);
            return true;
        });
    });
}
