import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// 检查可维护的源码说明, 不扫描生成产物, 用户接收数据和依赖代码.
const root = new URL('../', import.meta.url);

/** 收集项目自己维护的可执行源码, 便于注释要求随新文件持续生效. */
async function sources(): Promise<ts.SourceFile[]> {
    const result: ts.SourceFile[] = [];
    for (const directory of ['src', 'examples', 'tests', 'scripts']) {
        for (const file of await readdir(new URL(`${directory}/`, root))) {
            if (!/\.(?:ts|js|mjs)$/.test(file)) continue;
            const path = `${directory}/${file}`;
            const text = await readFile(new URL(path, root), 'utf8');
            result.push(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
        }
    }
    return result;
}

/**
 * 生成可定位到编辑器行号的诊断.
 * @param {ts.Node} node 缺少说明的语法节点.
 * @param {ts.SourceFile} source 节点所在的源码文件.
 */
function location(node: ts.Node, source: ts.SourceFile): string {
    return `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

/**
 * 收集需要参数说明的定义, 不执行传入源码.
 * @param {ts.SourceFile} source 要检查的源码或内存测试片段.
 */
function parameterIssues(source: ts.SourceFile): string[] {
    const issues: string[] = [];
    /** @param {ts.Node} node 当前遍历的语法节点. */
    function visit(node: ts.Node): void {
        // 内联函数, 局部回调和对象方法不强制写参数说明, 公共签名仍检查.
        if (
            ts.isFunctionLike(node)
            && !ts.isArrowFunction(node)
            && !ts.isFunctionExpression(node)
            && !(ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent))
        ) {
            const tags = [...ts.getJSDocTags(node)];
            // 函数类型的说明挂在别名或属性上, TypeScript 不自动向类型节点继承这些标签.
            if (
                ts.isFunctionTypeNode(node)
                && (ts.isTypeAliasDeclaration(node.parent) || ts.isPropertySignature(node.parent))
            ) {
                tags.push(...ts.getJSDocTags(node.parent));
            }
            const roots: ts.JSDocParameterTag[] = [];
            for (const tag of tags) {
                if (ts.isJSDocParameterTag(tag) && ts.isIdentifier(tag.name)) roots.push(tag);
            }
            for (const [index, parameter] of node.parameters.entries()) {
                if (parameter.name.getText(source) === 'this') continue;
                let documented = false;
                for (const tag of tags) {
                    if (!ts.isJSDocParameterTag(tag)) continue;
                    if (ts.isIdentifier(parameter.name)) {
                        if (tag.name.getText(source) !== parameter.name.text) continue;
                    }
                    // 解构形参使用同位置的根参数说明, 不能误用其他形参的注释.
                    else if (tag !== roots[index]) {
                        continue;
                    }
                    if (!tag.typeExpression || !tag.comment) continue;
                    const description = ts.getTextOfJSDocComment(tag.comment) ?? '';
                    if (
                        /[\u4E00-\u9FFF]/u.test(description)
                        && !/[\u3000-\u303F\uFF00-\uFF65\u2018-\u201F]/u.test(description)
                    ) {
                        documented = true;
                        break;
                    }
                }
                if (!documented) issues.push(`${location(node, source)} @param ${parameter.name.getText(source)}`);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return issues;
}

test('inline functions and runtime callbacks do not require parameter JSDoc', () => {
    const source = ts.createSourceFile('callbacks.ts', `
        const options = {
            onError: error => report(error),
            processContent(content) { return content; },
        };
        const fallback = options.onError ?? (error => report(error));
        const onMessage = data => consume(data);
        server.on('message', onMessage);
        [1, 2].map(value => value + 1);
        new Promise((resolve, reject) => listen(resolve, reject));
        server.on('close', function (error) { report(error); });
    `, ts.ScriptTarget.Latest, true);
    assert.deepEqual(parameterIssues(source), []);
});

test('named functions, constructors, class methods and API signatures still require parameter docs', () => {
    const source = ts.createSourceFile('api.ts', `
        function save(content: string) {}
        class Store {
            constructor(directory: string) {}
            write(message: string) {}
        }
        type Processor = (input: string) => string;
        interface Adapter {
            attach(context: unknown): void;
            onError: (error: Error) => void;
        }
    `, ts.ScriptTarget.Latest, true);
    const issues = parameterIssues(source);
    assert.equal(issues.length, 6);
    for (const name of ['content', 'directory', 'message', 'input', 'context', 'error']) {
        assert.ok(issues.some((issue) => issue.endsWith(`@param ${name}`)));
    }
});

test('required function parameters have typed Chinese JSDoc with ASCII punctuation', async () => {
    const issues = (await sources()).flatMap(parameterIssues);
    assert.equal(issues.length, 0, `Missing or invalid parameter comments:\n${issues.slice(0, 40).join('\n')}`);
});

test('core interface fields, including resolved overrides, have Chinese descriptions', async () => {
    const issues: string[] = [];
    for (const source of await sources()) {
        if (!source.fileName.startsWith('src/')) continue;
        /**
         * 类型字段逐项说明, 不能仅依赖父接口或整个类型的标题.
         * @param {ts.Node} node 当前检查的接口或内联类型成员.
         */
        function visit(node: ts.Node): void {
            if (ts.isPropertySignature(node)) {
                // 内联类型的注释可能紧跟左花括号, 不一定被 leading-comment API 视为行首注释.
                const prefix = source.text.slice(node.pos, node.getStart(source));
                const documented = prefix.includes('/**') && /[\u4E00-\u9FFF]/u.test(prefix);
                if (!documented) issues.push(`${location(node, source)} ${node.name.getText(source)}`);
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    assert.equal(issues.length, 0, issues.join('\n'));
});

test('receiver error-code constants have individual Chinese descriptions and a derived value type', async () => {
    const text = await readFile(new URL('src/errors.ts', root), 'utf8');
    const source = ts.createSourceFile('src/errors.ts', text, ts.ScriptTarget.Latest, true);
    let constants = 0;
    let derivedType = false;
    for (const statement of source.statements) {
        if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ReceiverErrorCode') {
            derivedType = statement.type.getText(source).replaceAll(/\s+/g, '')
                === 'typeofReceiverErrorCode[keyoftypeofReceiverErrorCode]';
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (declaration.name.getText(source) !== 'ReceiverErrorCode') continue;
            assert.ok(declaration.initializer && ts.isAsExpression(declaration.initializer));
            assert.equal(declaration.initializer.type.getText(source), 'const');
            const object = declaration.initializer.expression;
            assert.ok(ts.isObjectLiteralExpression(object));
            for (const property of object.properties) {
                const explanation = text.slice(property.pos, property.getStart(source));
                assert.ok(explanation.includes('/**') && explanation.includes('*/'));
                assert.match(explanation, /[\u4E00-\u9FFF]/u);
                assert.doesNotMatch(explanation, /[\u3000-\u303F\uFF00-\uFF65\u2018-\u201F]/u);
                constants++;
            }
        }
    }
    assert.ok(constants > 0, 'ReceiverErrorCode must be an as-const object with documented members');
    assert.ok(derivedType, 'ReceiverErrorCode type must be derived from the constant values');
});

test('published guidance describes direct binary reception as a current feature, not a legacy protocol', async () => {
    for (const file of ['AGENTS.md', 'AI_CONTEXT.md', 'README.md', 'src/cli.ts']) {
        const text = await readFile(new URL(file, root), 'utf8');
        assert.doesNotMatch(text, /旧版?(?:独立|独占)?\s*(?:WS|WebSocket)|旧文本入口|旧文本协议|legacy WebSocket/, file);
        if (file === 'README.md' || file === 'AI_CONTEXT.md') {
            assert.match(text, /application\/octet-stream/, file);
            assert.match(text, /default\.bin/, file);
        }
        else if (file === 'AGENTS.md') {
            // 操作约束通过明确章节引用技术细节, 不要求三份文档重复同一参数说明.
            assert.match(text, /直连.*共享/, file);
            assert.ok(text.includes('(AI_CONTEXT.md#2-架构和数据流)'), file);
        }
    }
});

test('public package references consistently use the scoped package identity', async () => {
    const { name } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    assert.equal(name, '@xiaohaih/message-transfer-plugin');
    const files = (await sources()).filter((source) => !source.fileName.startsWith('tests/')).map((source) => [source.fileName, source.text]);
    for (const path of ['tsconfig.json', 'README.md', 'AGENTS.md', 'AI_CONTEXT.md']) {
        files.push([path, await readFile(new URL(path, root), 'utf8')]);
    }
    const stale: string[] = [];
    for (const [path, text] of files) {
        // 同时检查正则字面量中的转义路径, 不把旧依赖别名视作新包的有效引用.
        for (const match of text!.replaceAll('\\/', '/').matchAll(/(?:@[\w.-]+\/)?message-transfer-plugins?/g)) {
            if (match[0] !== name) stale.push(`${path}: ${match[0]}`);
        }
    }
    assert.deepEqual(stale, [], 'Package imports, resolvers and public guidance must match package.json.name');
});

test('published guidance explains text conversion, newline overrides, file deduplication and CommonJS imports', async () => {
    for (const file of ['AGENTS.md', 'AI_CONTEXT.md', 'README.md']) {
        const text = await readFile(new URL(file, root), 'utf8');
        assert.match(text, /autoNewline/, file);
        assert.match(text, /JSON\.stringify/, file);
        assert.match(text, /去重/, file);
        assert.match(text, /\.message-transfer-files/, file);
    }
    const readme = await readFile(new URL('README.md', root), 'utf8');
    const start = readme.indexOf('## Vite 项目接入\n');
    const end = readme.indexOf('## 配置项\n');
    assert.ok(start >= 0 && end > start, 'Vite quick start must be followed by configuration');
    const quickStart = readme.slice(start, end);
    assert.match(quickStart, /^\/\/ const file/m);
    assert.match(quickStart, /^\/\/ await send\(/m);
    assert.match(readme, /content: unknown/);
    assert.match(readme, /await import\('@xiaohaih\/message-transfer-plugin'\)/);
    assert.match(readme, /await import\('@xiaohaih\/message-transfer-plugin\/vite'\)/);
});

test('README has a front navigation with working anchors and places configuration immediately after Vite', async () => {
    const readme = await readFile(new URL('README.md', root), 'utf8');
    // AI 模板中的 Markdown 标题不属于外层文档目录.
    const prose = readme.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
    const headings = [...prose.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    assert.deepEqual(headings.slice(0, 7), [
        '目录',
        '安装',
        'Vite 项目接入',
        '配置项',
        'CommonJS 接入指南',
        '独立接入',
        '挂接已有服务',
    ]);
    const navigation = prose.slice(prose.indexOf('## 目录\n'), prose.indexOf('## 安装\n'));
    for (const section of ['Vite 项目接入', '配置项', 'CommonJS 接入指南', '独立接入', '挂接已有服务', 'AI 规则模板']) {
        assert.ok(navigation.includes(`[${section}](#`), `Missing navigation entry: ${section}`);
    }
    const anchors = new Set([...prose.matchAll(/^#{2,4} (.+)$/gm)].map((match) => match[1]!.toLowerCase().replaceAll(/[^\p{L}\p{N}\s_-]/gu, '').replaceAll(' ', '-')));
    for (const [, anchor] of prose.matchAll(/\]\(#([^\s)]+)\)/g)) assert.ok(anchors.has(anchor!), `Broken README anchor: ${anchor}`);
    const configuration = prose.slice(prose.indexOf('## 配置项\n'), prose.indexOf('## CommonJS 接入指南\n'));
    for (const field of ['directory', 'autoNewline', 'maxFileBytes', 'processContent', 'timeoutMs']) assert.ok(configuration.includes(`\`${field}\``), field);
    assert.equal([...readme.matchAll(/^interface MessageOption \{/gm)].length, 1);
    assert.equal([...readme.matchAll(/^interface FileOption \{/gm)].length, 1);
    assert.doesNotMatch(readme, /\*\*group 只决定分组子目录, name 独立指定完整文件名\.\*\*/);
    assert.doesNotMatch(prose, /^## 实现与协议说明$/m, 'Detailed implementation belongs in the technical context, not a second user manual');
});

test('AGENTS delegates implementation details and transfer budgets to technical context', async () => {
    const agents = await readFile(new URL('AGENTS.md', root), 'utf8');
    for (const anchor of [
        '2-架构和数据流',
        '3-接入方式怎么选',
        '4-不可误改的协议和存储契约',
        '默认配置与资源预算',
        '5-启动和排障速查',
        '版本和验证边界',
    ]) {
        assert.ok(agents.includes(`(AI_CONTEXT.md#${anchor})`), `Missing technical-context entry: ${anchor}`);
    }
    assert.doesNotMatch(agents, /\b\d+\s*(?:MiB|KiB)\b/, 'Transfer sizes belong to the referenced technical context and configuration');
});

test('root guidance cross-links resolve to real Markdown headings outside code fences', async () => {
    const guides = new Map<string, { prose: string; anchors: Set<string> }>();
    for (const file of ['AGENTS.md', 'AI_CONTEXT.md', 'README.md']) {
        const text = await readFile(new URL(file, root), 'utf8');
        const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
        const anchors = new Set([...prose.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1]!.toLowerCase().replaceAll(/[^\p{L}\p{N}\s_-]/gu, '').replaceAll(' ', '-')));
        guides.set(file, { prose, anchors });
    }
    for (const [file, { prose }] of guides) {
        for (const [, target, fragment] of prose.matchAll(/\]\(([^/:\s)#]+\.md)?(?:#([^\s)]+))?\)/g)) {
            const destination = guides.get(target ?? file);
            assert.ok(destination, `Missing guide: ${file} -> ${target}`);
            if (fragment) assert.ok(destination.anchors.has(decodeURIComponent(fragment)), `Broken guide anchor: ${file} -> ${target ?? file}#${fragment}`);
        }
    }
});

test('ESLint scripts, development dependencies and editor formatter are configured', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    for (const dependency of ['eslint', '@antfu/eslint-config', 'eslint-plugin-format']) {
        assert.ok(pkg.devDependencies[dependency], `${dependency} must be a development dependency`);
        assert.equal(pkg.dependencies[dependency], undefined);
    }
    assert.match(pkg.scripts['lint:fix'] ?? '', /eslint\s+\.\s+--fix/);
    assert.match(pkg.scripts.lint ?? '', /eslint\s+\./);
    // VS Code 设置采用 JSONC, 允许已有 ESLint 规则保留多行尾逗号.
    const parsed = ts.parseConfigFileTextToJson(
        'settings.json',
        await readFile(new URL('.vscode/settings.json', root), 'utf8'),
    );
    assert.equal(parsed.error, undefined);
    const settings = parsed.config;
    assert.equal(settings['editor.defaultFormatter'], 'dbaeumer.vscode-eslint');
    assert.equal(settings['eslint.format.enable'], true);
    assert.equal(settings['editor.codeActionsOnSave']['source.fixAll.eslint'], 'explicit');
});
