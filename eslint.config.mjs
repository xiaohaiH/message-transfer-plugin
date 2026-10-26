import antfu from '@antfu/eslint-config';

// 保留项目的 4 空格和分号风格, 类型检查只使用本仓库的 tsconfig.
export default antfu(
    {
        formatters: {
            css: true,
            html: true,
            markdown: true,
            graphql: true,
            // astro: true,
            // slidev: true,
        },
        // 'unocss': { strict: true },
        typescript: {
            tsconfigPath: './tsconfig.json',
            ignoresTypeAware: ['**/*.md/**', '**/*.astro/*.ts', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/*.e2e-spec.ts'],
        },
        // 编辑器选项移至 .vscode/settings.json, 本项目没有 Vue 源文件.
        vue: false,
        stylistic: {
            indent: 4,
            semi: true,
        },
        rules: {
            /** 不允许出现 tab */
            'style/no-tabs': ['error', { allowIndentationTabs: false }],
            /** switch 冒号后面加空格 */
            'style/switch-colon-spacing': ['error', { after: true }],
            /** 必须存在分号 */
            'style/semi': ['error', 'always'],
            /** 赋值后允许换行, 避免把 JSDoc 从函数或类型前移到变量名与等号之间. */
            'style/operator-linebreak': ['error', 'before', { overrides: { '=': 'after' } }],
            // /** 4 个空格 */
            // 'indent': ['off'],
            // /** 4 个空格 */
            // 'ts/indent': ['error', 4, { SwitchCase: 1 }],
            // /** 尾随逗号 */
            // 'style/comma-dangle': ['error', 'always'],
            // /** 尾随逗号 */
            // 'comma-dangle': ['error', 'always'],
            /** 允许使用 const 进行枚举 */
            'no-restricted-syntax': ['off'],
            /** 允许 let 声明的变量不会被重赋值 */
            'prefer-const': ['off'],
            /** 允许出现无用的 return */
            'no-useless-return': 'off',
            /** 箭头函数参数需要圆括号包裹. */
            'style/arrow-parens': ['warn', 'always'],

            /** 每行语句数不能超过 1 句 */
            'style/max-statements-per-line': ['error', { max: 1 }],
            /** 不允许混合二进制运算符. */
            'style/no-mixed-operators': ['error'],
            /** 允许包含块内只有一句语句时, 省略包含块 */
            'curly': ['error', 'multi-line'],
            /** 允许语句与 if 同行 */
            'antfu/if-newline': ['off'],
            /** 导入语句后非导入语句时必须接空行 */
            'import/newline-after-import': ['error', { considerComments: false }],
            'no-unused-vars': ['off'],
            /** 声明变量未使用 */
            'unused-imports/no-unused-vars': 'off',
            /** 导入变量未使用 */
            'unused-imports/no-unused-imports': 'off',
            'no-console': 'warn',
            /** 不允许有空的代码块 */
            'no-empty': ['warn'],
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-constant-binary-expression': ['error'],
            /** 防止函数在变量上方时, 函数内部引用变量提示报错 */
            'ts/no-use-before-define': 'off',
            /** promise 函数定义后执行必须加上 await 或 .then */
            'ts/no-floating-promises': ['off'],
            /** 暂不检查 any 类型的实参, 保留现有规则开关. */
            'ts/no-unsafe-argument': ['off'],
            /** 暂不检查从 any 进行赋值, 保留现有规则开关. */
            'ts/no-unsafe-assignment': ['off'],
            /** 暂不检查 any 的成员访问, 保留现有规则开关. */
            'ts/no-unsafe-member-access': ['off'],
            /** 暂不检查 any 的调用, 保留现有规则开关. */
            'ts/no-unsafe-call': ['off'],
            /** 暂不检查 any 返回值, 保留现有规则开关. */
            'ts/no-unsafe-return': ['off'],
            /** 允许空值和null之类的混用做判断(eg: []?.length) */
            'ts/strict-boolean-expressions': ['off', {
                allowAny: true,
                allowNullableBoolean: true,
                allowNullableEnum: true,
                allowNullableNumber: true,
                allowNullableString: true,
            }],
            /** 允许类型中使用空对象(eg: null as unknown as {}) */
            'ts/no-empty-object-type': ['off'],
            // 强制统一使用 LF 作为换行符 (Unix).
            'style/linebreak-style': ['error', 'unix'],
            /** 参数说明按用户约定保留 TypeScript 类型, 不自动移除花括号类型. */
            'jsdoc/no-types': 'off',
            /** 多行说明的每行使用星号前缀, 保持 JSDoc 结构清晰. */
            'jsdoc/require-asterisk-prefix': ['error', 'always'],
            /** 沿用 Node 原生全局对象, 不因格式化额外改变运行时导入. */
            'node/prefer-global/process': ['error', 'always'],
            'node/prefer-global/buffer': ['error', 'always'],
            /** 允许直接返回既有 Promise, 保持启停队列的 Promise 语义. */
            'ts/promise-function-async': 'off',
            /** 保留公开接口的方法签名及其赋值兼容性, 不自动转换为函数属性. */
            'ts/method-signature-style': 'off',
            'ts/no-unused-expressions': ['error', {
                /** 允许在三目中调用存在返回值的函数(e.g: a ? c() : b()) */
                allowTernary: true,
                /** 允许逻辑短路赋值(e.g: a ? b() || (c = d) : e()) */
                allowShortCircuit: true,
            }],
        },
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
        rules: {
            /** 调整导入顺序 */
            'perfectionist/sort-imports': ['error', {
                groups: [
                    ['type-import', 'value-builtin', 'value-external'],
                    ['type-internal', 'value-internal'],
                    ['type-parent', 'value-parent'],
                    ['type-sibling', 'value-sibling'],
                    ['type-index', 'value-index'],
                    'ts-equals-import',
                    'unknown',
                    // 低版本配置
                    // ['builtin-type', 'builtin'],
                    // ['external-type', 'external'],
                    // ['internal-type', 'internal'],
                    // ['parent-type', 'parent'],
                    // ['parent-type', 'parent'],
                    // ['sibling-type', 'sibling'],
                    // ['index-type', 'index'],
                    // 'object',
                    // 'side-effect',
                    // 'unknown',
                ],
                newlinesBetween: 'ignore',
                internalPattern: ['^~/.*', '^@/.*'],
            }],
        },
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            /** 本项目使用 node:test, 不把测试导入自动改成 Vitest. */
            'test/no-import-node-test': 'off',
        },
    },
    {
        files: ['src/cli.ts', 'examples/**', 'scripts/**', '**/*.md/**'],
        rules: {
            /** ESM 命令入口需要等待启动和退出, 不是可复用库模块的顶层副作用. */
            'antfu/no-top-level-await': 'off',
            /** CLI 和示例的地址及目录输出属于用户界面, 允许明确的日志级别. */
            'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
        },
    },
    {
        files: ['.vscode/**/*.json', '.cursor/**/*.json', '**/*.jsonc'],
        rules: {
            /** 允许 jsonc 出现尾随逗号 */
            'jsonc/comma-dangle': ['error', 'always-multiline'],
        },
    },
    {
        files: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts'],
        rules: {
            /** 允许在判断中字符串与null之类的空值混用 */
            'ts/strict-boolean-expressions': ['off', {}],
            /** 允许空对象声明 */
            'ts/no-empty-object-type': ['error', {
                allowInterfaces: 'always',
                allowObjectTypes: 'always',
            }],
        },
    },
    {
        // 格式化不处理产物, 历史快照或用户接收数据, 锁文件由包管理器维护.
        ignores: [
            'node_modules/**',
            'dist/**',
            'received/**',
            '.pnpm-store/**',
            '.worktrees/**',
            '.eslintcache',
            'pnpm-workspace.yaml',
            'pnpm-lock.yaml',
            '.github/**/*.yml',
            '.cline/**',
            '.codex/**',
            '.history/**',
            '.agents/**',
        ],
    },
);
