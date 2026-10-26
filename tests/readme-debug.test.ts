import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { installClient } from '../src/client-host.js';
import type { ClientRequest } from '../src/client-host.js';
import * as client from '../src/client.js';
import { ReceiverErrorCode } from '../src/errors.js';
import type { Receipt, SuccessReceipt } from '../src/index.js';
import { fixture, receiptPath, success } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@xiaohaih/message-transfer-plugin';
const timeout = { timeout: 15000 };
const accepted: SuccessReceipt = {
    ok: true,
    code: 0,
    date: '20261024',
    groupDirectory: 'debug-case-001-before',
    group: 'debug-case-001-before',
    file: 'events.jsonl',
    bytes: 3,
};

/** 宿主示例的异步尝试接口, 完成不等于保存成功. @param {() => Record<string, unknown>} readFields 开启采集后才执行的白名单字段构造器. */
type DebugRecorder = (readFields: () => Record<string, unknown>) => Promise<void>;

interface LocalLog {
    /** 只捕获示例自己的本地日志. */
    level: 'log' | 'warn';
    /** 不包含真实用户数据的测试参数. */
    args: unknown[];
}

interface ExampleOptions {
    /** 对应 Vite 构建时替换的布尔常量. */
    development?: boolean;
    /** 显式切换宿主会话开关, 省略时按文档原样执行, 不覆盖默认值. */
    collection?: boolean;
    /** 真实接收器或测试请求工具使用的端点. */
    endpoint?: string;
    /** 通过正式宿主入口接入的请求函数, 不替换 SDK. */
    request?: ClientRequest;
    /** 模拟宿主日志方法被覆写且抛错. */
    loggerThrows?: boolean;
}

/** 读取待执行的实际文档代码, 缺少或重复标记不能退回到测试内副本. @param {string} name 代码块的稳定标记名. */
async function snippet(name: string): Promise<string> {
    const markdown = await readFile(join(root, 'README.md'), 'utf8');
    const marker = `<!-- readme:${name}:start -->`;
    const sections = markdown.split(marker);
    assert.equal(sections.length, 2, `README must contain exactly one ${marker}`);
    const section = sections[1]!.split(`<!-- readme:${name}:end -->`);
    assert.equal(section.length, 2, `README must close the ${name} example`);
    const blocks = [...section[0]!.matchAll(/```typescript\n([\s\S]*?)\n```/g)];
    assert.equal(blocks.length, 1, `README ${name} must contain one TypeScript example`);
    return blocks[0]![1]!;
}

/** 统一编译器虚拟文件键, 不将生成产物写进真实 dist. @param {string} file 编译器使用的绝对或相对文件名. */
function fileKey(file: string): string {
    const key = resolve(file).replaceAll('\\', '/');
    return ts.sys.useCaseSensitiveFileNames ? key : key.toLowerCase();
}

/** 输出真正的 TypeScript 语义诊断. @param {readonly ts.Diagnostic[]} issues 编译器返回的诊断集合. */
function diagnostics(issues: readonly ts.Diagnostic[]): string {
    return ts.formatDiagnostics(issues, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: fileKey,
        getNewLine: () => '\n',
    });
}

/**
 * 执行 README 帮助函数, 只替换宿主 DEV/会话常量与本地 console; send 始终为真实 SDK.
 * @param {TestContext} t 清理本次测试自己的客户端注册.
 * @param {ExampleOptions} options 受控宿主环境与请求函数.
 */
async function example(t: TestContext, options: ExampleOptions = {}) {
    let source = await snippet('host-debug');
    if (options.collection !== undefined) {
        const flag = 'const DEBUG_ENABLED = false;';
        assert.equal(source.split(flag).length, 2, 'The example must expose one default-off host session flag');
        source = source.replace(flag, `const DEBUG_ENABLED = ${options.collection};`);
    }
    assert.equal(source.split('import.meta.env.DEV').length, 2, 'The example must explicitly gate collection with Vite DEV');
    const compiled = ts.transpileModule(source.replace('import.meta.env.DEV', '__development'), {
        compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true,
    });
    assert.equal(diagnostics(compiled.diagnostics ?? []), '');
    const logs: LocalLog[] = [];
    const bodies: string[] = [];
    let notify = (_entry: LocalLog) => { /* 下面的 Promise 执行器同步安装实际观察者. */ };
    const logged = new Promise<LocalLog>((resolve) => {
        notify = resolve;
    });
    const logger = (level: LocalLog['level']) => (...args: unknown[]) => {
        const entry = { level, args };
        logs.push(entry);
        notify(entry);
        if (options.loggerThrows) throw new Error('Synthetic local logger failure');
    };
    const request: ClientRequest = options.request ?? (async () => Response.json(accepted));
    t.after(installClient({
        endpoint: options.endpoint ?? 'http://debug.invalid/device-data',
        timeoutMs: 3000,
        request: (url, init) => {
            bodies.push(String(init?.body));
            return request(url, init);
        },
    }));
    const exports: { recordDebug?: DebugRecorder } = {};
    runInNewContext(compiled.outputText, {
        exports,
        require: (id: string) => {
            assert.equal(id, `${packageName}/client`);
            return client;
        },
        __development: options.development ?? true,
        console: { log: logger('log'), warn: logger('warn') },
    }, { filename: 'README/host-debug.js', timeout: 1000 });
    assert.equal(typeof exports.recordDebug, 'function', 'The helper is host code, not a new SDK export');
    return { recordDebug: exports.recordDebug!, exports, logs, logged, bodies };
}

test('README instrumentation and call site typecheck against actual public declarations and Vite env types', timeout, async () => {
    const helper = await snippet('host-debug');
    const usage = await snippet('host-debug-usage');
    const configFile = ts.readConfigFile(join(root, 'tsconfig.browser.json'), ts.sys.readFile);
    assert.equal(configFile.error, undefined);
    const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
    assert.equal(diagnostics(config.errors), '');
    const declarations = new Map<string, string>();
    const build = ts.createProgram(config.fileNames, { ...config.options, emitDeclarationOnly: true });
    assert.equal(diagnostics(ts.getPreEmitDiagnostics(build)), '');
    const emitted = build.emit(undefined, (file, text) => declarations.set(fileKey(file), text));
    assert.equal(emitted.emitSkipped, false, diagnostics(emitted.diagnostics));
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const publicClient = fileKey(join(root, manifest.exports['./client'].types));
    assert.ok(declarations.has(publicClient), 'Compile the real exports target, not a made-up send declaration');
    const helperFile = join(root, 'tests', '__readme_consumer__', 'host-debug.ts');
    const usageFile = join(dirname(helperFile), 'usage.ts');
    declarations.set(fileKey(helperFile), helper);
    declarations.set(fileKey(usageFile), `${usage}\nconst finished: Promise<void> = recordDebug(() => ({}));\nvoid finished;\n`);
    const options: ts.CompilerOptions = {
        ...config.options,
        rootDir: root,
        paths: {},
        types: ['node', 'vite/client'],
        noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const originalSource = host.getSourceFile;
    host.fileExists = (file) => declarations.has(fileKey(file)) || ts.sys.fileExists(file);
    host.readFile = (file) => declarations.get(fileKey(file)) ?? ts.sys.readFile(file);
    host.directoryExists = (directory) => [...declarations.keys()].some((file) => file.startsWith(`${fileKey(directory)}/`))
        || ts.sys.directoryExists(directory);
    host.getSourceFile = (file, version, onError, fresh) => {
        const text = declarations.get(fileKey(file));
        return text === undefined ? originalSource(file, version, onError, fresh) : ts.createSourceFile(file, text, version, true);
    };
    const consumer = ts.createProgram([helperFile, usageFile], options, host);
    assert.equal(diagnostics(ts.getPreEmitDiagnostics(consumer)), '');
    assert.ok(consumer.getSourceFiles().some((file) => fileKey(file.fileName) === publicClient));

    // 负对照证明没有把导入降为 any: 两参数发送与非函数字段构造器必须报错.
    declarations.set(fileKey(usageFile), `${usage}\nimport { send } from '${packageName}/client';\nsend({ content: {} }, {});\nrecordDebug({ event: 'unsafe' });\n`);
    const invalid = ts.getPreEmitDiagnostics(ts.createProgram([helperFile, usageFile], options, host));
    assert.ok(invalid.some((issue) => issue.code === 2554), diagnostics(invalid));
    assert.ok(invalid.some((issue) => issue.code === 2353 || issue.code === 2345), diagnostics(invalid));
});

for (const [label, options] of [
    ['default-off during ordinary development', {}],
    ['explicitly disabled session in development', { development: true, collection: false }],
    ['disabled development with an enabled session', { development: false, collection: true }],
] satisfies Array<[string, ExampleOptions]>) {
    test(`README ${label} constructs nothing, sends nothing and preserves the business result`, timeout, async (t) => {
        const app = await example(t, options);
        let constructed = 0;
        const value = { business: 'unchanged' };
        const business = () => {
            app.recordDebug(() => {
                constructed++;
                throw new Error('The disabled callback must never run');
            });
            return value;
        };
        assert.equal(business(), value);
        await setImmediate();
        assert.equal(constructed, 0, 'A swallowed constructor exception must not hide disabled collection');
        assert.deepEqual(app.bodies, []);
        assert.deepEqual(app.logs, []);
    });
}

test('README enabled collection captures at the call site without awaiting the pending send', timeout, async (t) => {
    let release = (_response: Response) => { /* 下面的 Promise 执行器同步安装实际完成回调. */ };
    const response = new Promise<Response>((resolve) => {
        release = resolve;
    });
    const app = await example(t, { collection: true, request: () => response });
    let state = 'before';
    let captured = 0;
    let finished = false;
    let completion: Promise<void> | undefined;
    const value = { business: 'unchanged' };
    const business = () => {
        completion = app.recordDebug(() => {
            captured++;
            return { state };
        });
        assert.equal(typeof completion.then, 'function');
        void completion.then(() => {
            finished = true;
        });
        state = 'after';
        return value;
    };
    assert.equal(business(), value);
    assert.equal(captured, 1);
    assert.equal(app.bodies.length, 1);
    assert.deepEqual(JSON.parse(JSON.parse(app.bodies[0]!).content), { state: 'before' });
    await setImmediate();
    assert.equal(finished, false, 'Finishing the business operation must not imply a completed send');
    assert.deepEqual(app.logs, []);
    release(Response.json(accepted));
    assert.ok(completion);
    assert.equal(await completion, undefined);
    assert.equal(finished, true);
    assert.equal(app.logs.length, 1);
    assert.equal(app.bodies.length, 1);
});

test('README a later end-event receipt does not confirm an earlier pending diagnostic send', timeout, async (t) => {
    let releaseState = (_response: Response) => { /* 下面安装状态消息的完成回调. */ };
    let releaseEnd = (_response: Response) => { /* 下面安装结束事件的完成回调. */ };
    const stateResponse = new Promise<Response>((resolve) => {
        releaseState = resolve;
    });
    const endResponse = new Promise<Response>((resolve) => {
        releaseEnd = resolve;
    });
    let dispatched = 0;
    const app = await example(t, {
        collection: true,
        request: () => dispatched++ === 0 ? stateResponse : endResponse,
    });
    let stateFinished = false;
    const state = app.recordDebug(() => ({ event: 'state-observed' }));
    void state.then(() => {
        stateFinished = true;
    });
    const end = app.recordDebug(() => ({ event: 'operation-end' }));
    releaseEnd(Response.json(accepted));
    assert.equal(await end, undefined);
    await setImmediate();
    assert.equal(stateFinished, false, 'One successful end event is not a batch completion barrier');
    assert.equal(app.logs.length, 1);
    assert.equal(app.bodies.length, 2);
    releaseState(Response.json(accepted));
    assert.equal(await state, undefined);
    assert.equal(stateFinished, true);
    assert.equal(app.logs.length, 2);
});

test('README usage sends only its allowlisted fields through the real SDK and writes the receipt location', timeout, async (t) => {
    const server = await fixture(t, { autoNewline: false });
    const receipts: Receipt[] = [];
    const app = await example(t, {
        collection: true,
        endpoint: server.url.replace(/^ws:/, 'http:'),
        request: async (url, init) => {
            const response = await fetch(url, init);
            receipts.push(await response.clone().json() as Receipt);
            return response;
        },
    });
    const usage = ts.transpileModule(await snippet('host-debug-usage'), {
        compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS },
    });
    runInNewContext(usage.outputText, {
        exports: {},
        require: (id: string) => {
            assert.equal(id, './host-debug.js');
            return app.exports;
        },
    }, { filename: 'README/usage.js', timeout: 1000 });
    const log = await app.logged;
    assert.equal(receipts.length, 1);
    const receipt = success(receipts[0]!);
    assert.equal(log.level, 'log');
    assert.deepEqual(JSON.parse(JSON.stringify(log.args)), ['[debug:saved]', {
        date: receipt.date,
        groupDirectory: receipt.groupDirectory,
        file: receipt.file,
    }]);
    const text = await readFile(receiptPath(server.directory, receipt), 'utf8');
    assert.equal(text, `${JSON.stringify({ event: 'panel-open', route: '/orders/:id', activeTab: 'details', itemCount: 3 })}\n`);
    assert.equal(receipt.bytes, Buffer.byteLength(text));
    assert.equal(receipt.file, 'events.jsonl');
    const message = JSON.parse(app.bodies[0]!);
    assert.equal(message.autoNewline, true, 'The JSON-lines example explicitly overrides a receiver with newlines disabled');
    assert.equal(message.group, accepted.group);
    assert.equal(app.bodies.length, 1);
});

test('README handles a real server rejection separately without leaking the original error or retrying', timeout, async (t) => {
    const server = await fixture(t, {
        processContent: () => {
            throw new Error('PRIVATE_HOOK_DETAIL');
        },
    });
    const app = await example(t, { collection: true, endpoint: server.url.replace(/^ws:/, 'http:'), request: fetch });
    const completion = app.recordDebug(() => ({ event: 'panel-open' }));
    const log = await app.logged;
    assert.equal(await completion, undefined, 'A completed attempt may still have a rejected receipt');
    assert.equal(log.level, 'warn');
    assert.deepEqual(log.args, ['[debug:rejected]', ReceiverErrorCode.PROCESSING_FAILED]);
    await setImmediate();
    assert.equal(app.logs.length, 1);
    assert.equal(app.bodies.length, 1);
    assert.doesNotMatch(JSON.stringify(app.logs), /PRIVATE_HOOK_DETAIL/);
});

for (const synchronous of [false, true]) {
    test(`README isolates ${synchronous ? 'synchronous request errors' : 'Promise rejections'} without exposing details or retrying`, timeout, async (t) => {
        const app = await example(t, {
            collection: true,
            request: () => {
                const error = new Error('PRIVATE_REQUEST_DETAIL');
                if (synchronous) throw error;
                return Promise.reject(error);
            },
        });
        const value = { business: 'unchanged' };
        const business = () => {
            app.recordDebug(() => ({ event: 'panel-open' }));
            return value;
        };
        assert.equal(business(), value);
        const log = await app.logged;
        assert.equal(log.level, 'warn');
        assert.equal(log.args[0], '[debug:unconfirmed]');
        assert.doesNotMatch(JSON.stringify(log.args), /PRIVATE_REQUEST_DETAIL/);
        await setImmediate();
        assert.equal(app.bodies.length, 1);
        assert.equal(app.logs.length, 1);
    });
}

const invalidFields: Array<[string, () => Record<string, unknown>]> = [
    ['field construction', () => { throw new Error('PRIVATE_FIELD_DETAIL'); }],
    ['BigInt serialization', () => ({ value: 1n })],
    ['cyclic serialization', () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
    }],
    ['toJSON serialization', () => ({ toJSON() { throw new Error('PRIVATE_TOJSON_DETAIL'); } })],
];
for (const [label, fields] of invalidFields) {
    test(`README isolates ${label} failures before dispatch without altering the business result`, timeout, async (t) => {
        const app = await example(t, { collection: true });
        const value = { business: 'unchanged' };
        const business = () => {
            app.recordDebug(fields);
            return value;
        };
        assert.equal(business(), value);
        const log = await app.logged;
        assert.equal(log.level, 'warn');
        assert.equal(log.args[0], '[debug:unconfirmed]');
        assert.doesNotMatch(JSON.stringify(log.args), /PRIVATE_/);
        await setImmediate();
        assert.equal(app.bodies.length, 0);
        assert.equal(app.logs.length, 1);
    });
}

test('README instrumentation does not consume an unrelated business exception', timeout, async (t) => {
    const app = await example(t, { collection: true });
    const original = new Error('Business error must remain visible');
    assert.throws(() => {
        app.recordDebug(() => ({ event: 'panel-open' }));
        throw original;
    }, (error) => error === original);
    await app.logged;
    assert.equal(app.bodies.length, 1);
});

for (const outcome of ['success', 'rejected', 'unconfirmed']) {
    test(`README isolates a throwing local logger after ${outcome} with no unhandled rejection`, timeout, async (t) => {
        const app = await example(t, {
            collection: true,
            loggerThrows: true,
            request: async () => {
                if (outcome === 'unconfirmed') throw new Error('Synthetic transport error');
                return Response.json(outcome === 'success'
                    ? accepted
                    : {
                            ok: false,
                            code: 1,
                            error: { code: ReceiverErrorCode.FORBIDDEN, message: 'Forbidden.' },
                        }, { status: outcome === 'success' ? 200 : 403 });
            },
        });
        const completion = app.recordDebug(() => ({ event: 'panel-open' }));
        await app.logged;
        assert.equal(await completion, undefined);
        await setImmediate();
        assert.equal(app.logs.length, 1);
        assert.equal(app.bodies.length, 1);
        // node:test 会将未处理的拒绝报告为失败, 不安装吞掉全局异常的监听器.
    });
}

test('published AI guidance scopes authorization, treats received data as untrusted and separates consumer workflow', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const start = readme.indexOf('## AI 规则模板\n');
    const end = readme.indexOf('## 业务代码中的安全埋点\n');
    assert.ok(start >= 0 && end > start, 'The host rules must have their own navigable section');
    const collaboration = readme.slice(start, end);
    const rules = /```markdown\n([\s\S]*?)\n```/.exec(collaboration)?.[1];
    assert.ok(rules, 'README must provide a copyable host rule template');
    assert.match(rules, /^## 按需诊断数据采集$/m);
    assert.match(rules, /默认不采集/);
    assert.match(rules, /AI.*证据不足.*主动/);
    assert.match(rules, /不以设备类型/);
    assert.match(rules, /浏览器权限/);
    assert.match(rules, /无需用户.*指定工具/);
    assert.match(rules, /仅在启用采集时.*AI.*整理/);
    assert.match(rules, /普通开发无需填写/);
    assert.match(rules, /指导用户.*复现/);
    assert.match(rules, /无需.*(?:导出|发送)日志/);
    assert.match(rules, /预期事件.*成功回执/);
    assert.match(rules, /操作结束.*不代表.*收齐/);
    assert.match(rules, /原文件另行确认/);
    for (const field of ['<本次会话分组>', '<允许读取的路径或文件>', '<复现步骤与验收标准>']) assert.ok(rules.includes(field), field);
    assert.doesNotMatch(rules, /<实际接收根目录>/, 'The receive directory must come from host configuration, not a duplicate placeholder');
    assert.match(rules, /接收目录沿用宿主配置/);
    assert.match(rules, /AI 自动确认实际路径/);
    assert.match(rules, /仅在无法确定时询问/);
    assert.match(rules, /不要求用户重复填写/);
    assert.match(rules, /确认接收目录不等于获得授权/);
    assert.match(rules, /不可信/);
    assert.match(rules, /不是指令/);
    assert.match(rules, /已安装版本/);
    assert.doesNotMatch(rules, /pnpm (?:install|test|check)|init-ai/);
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const context = await readFile(join(root, 'AI_CONTEXT.md'), 'utf8');
    for (const [file, text] of [['AGENTS.md', agents], ['AI_CONTEXT.md', context]]) {
        assert.match(text!, /不可信/, file);
        assert.match(text!, /授权/, file);
        assert.match(text!, /白名单/, file);
        assert.match(text!, /本次新增的临时/, file);
        assert.match(text!, /默认不采集/, file);
        assert.match(text!, /证据不足/, file);
        assert.match(text!, /预期事件.*成功回执/, file);
    }
    assert.doesNotMatch(context, /仅当问题依赖手机/, 'Device type must not be the gate for collecting missing evidence');
    const workflow = context.indexOf('## 使用本库调试宿主项目');
    assert.ok(workflow > 0 && workflow < context.indexOf('## 1. 最短阅读路线 (源码仓库)'));
});
