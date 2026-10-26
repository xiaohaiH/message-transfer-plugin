#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ReceiverError } from './errors.js';
import { createReceiver } from './receiver.js';
import type { ReceiverOptions } from './types.js';

// CLI 帮助与核心默认值保持一致, 无需填写目录即可启动.
const help = `Usage: message-transfer [options]

Receive JSON messages: {"group":"notes","content":"text"}
If JSON parsing fails, save the original text to the default group.
Save under YYYYMMDD/[group]/name. Text name defaults to default.txt, without adding newlines.
File names prefer explicit name then File.name; duplicates use (N) before the extension.
Direct HTTP application/octet-stream or WebSocket binary messages save ungrouped default.bin files.

Options:
  -d, --directory <path>    Output directory (default: ./received)
      --host <host>         Listening host (default: 127.0.0.1; LAN: 0.0.0.0)
  -p, --port <port>         Listening port (default: 8787; 0: choose a free port)
      --path <path>         HTTP / direct WebSocket path (default: /device-data)
      --max-payload <bytes> Maximum text / direct WS message / processed bytes (default: 10485760)
      --max-file <bytes>    Maximum original file bytes (default: 104857600, 100 MiB)
      --origin <origin>     Allowed browser origin; repeat to allow several
      --require-origin      Reject clients without an Origin header
  -h, --help                Show this help

Set MESSAGE_TRANSFER_TOKEN to require a Bearer header or ?token= on connections.
The token is never printed. Use WSS behind HTTPS outside a trusted LAN.
Ctrl+C stops accepting messages and drains pending writes.
`;

/**
 * 先拒绝非十进制整数, 再由核心校验端口和消息大小的具体范围.
 * @param {string} value 命令行传入的端口或负载大小文本.
 * @param {string} name 出错时显示的命令行选项名, 例如 --port.
 */
function integer(value: string, name: string): number {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return Number(value);
}

/**
 * 本地日志只输出稳定错误码和系统错误码, 不打印令牌或请求 URL.
 * @param {unknown} error 启动, 运行或退出过程中捕获的原始异常.
 */
function describe(error: unknown): string {
    if (error instanceof ReceiverError) {
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        return `${error.code}: ${error.message}${cause?.code ? ` (${cause.code})` : ''}`;
    }
    return error instanceof Error ? error.message : 'Unexpected error.';
}

/** 解析参数后启动独立接收器, 退出信号会等待已接收消息写入完成. */
async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            'directory': { type: 'string', short: 'd' },
            'host': { type: 'string' },
            'port': { type: 'string', short: 'p' },
            'path': { type: 'string' },
            'max-payload': { type: 'string' },
            'max-file': { type: 'string' },
            'origin': { type: 'string', multiple: true },
            'require-origin': { type: 'boolean' },
            'help': { type: 'boolean', short: 'h' },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(help);
        return;
    }
    const options: ReceiverOptions = {};
    if (values.directory !== undefined) options.directory = values.directory;
    if (values.host !== undefined) options.host = values.host;
    if (values.port !== undefined) options.port = integer(values.port, '--port');
    if (values.path !== undefined) options.path = values.path;
    if (values['max-payload'] !== undefined) options.maxPayloadBytes = integer(values['max-payload'], '--max-payload');
    if (values['max-file'] !== undefined) options.maxFileBytes = integer(values['max-file'], '--max-file');
    if (values.origin !== undefined) options.allowedOrigins = values.origin;
    if (values['require-origin']) options.allowMissingOrigin = false;
    if (process.env.MESSAGE_TRANSFER_TOKEN !== undefined) options.token = process.env.MESSAGE_TRANSFER_TOKEN;
    options.onError = (error) => console.error(`message-transfer: ${describe(error)}`);
    const receiver = createReceiver(options);
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        void receiver
            .stop()
            .catch((error: unknown) => {
                console.error(`message-transfer: ${describe(error)}`);
                process.exitCode = 1;
            })
            .finally(() => {
                process.off('SIGINT', shutdown);
                process.off('SIGTERM', shutdown);
            });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    try {
        await receiver.start();
    }
    catch (error) {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        throw error;
    }
    const address = receiver.address;
    if (address && typeof address !== 'string') {
        const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
        console.log(`Listening on ws://${host}:${address.port}${options.path ?? '/device-data'}`);
        console.log(`POST: http://${host}:${address.port}${options.path ?? '/device-data'}`);
        console.log(`Directory: ${receiver.directory}`);
        if (['0.0.0.0', '::'].includes(address.address)) {
            console.log('LAN clients must use the computer\'s LAN IP, not the wildcard listening address.');
        }
    }
}

await main().catch(
    (error: unknown) => {
        console.error(`message-transfer: ${describe(error)}`);
        process.exitCode = 1;
    },
);
