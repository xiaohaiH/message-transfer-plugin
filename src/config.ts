import { resolve } from 'node:path';
import { ReceiverError, ReceiverErrorCode } from './errors.js';
import type { ReceiverOptions } from './types.js';

/** 填充默认值后的内部配置, 目录在创建接收器时就解析成绝对路径. */
export interface ResolvedOptions extends ReceiverOptions {
    /** 解析后的绝对输出目录, 未配置时为 cwd/received, 覆写父类型的可选属性. */
    directory: string;
    /** 已校验的绝对 HTTP/直连 WS 接收路径, 默认 /device-data, 解析后保证存在. */
    path: string;
    /** 独立监听地址, 默认 127.0.0.1; 外部宿主模式不使用此值. */
    host: string;
    /** 独立监听端口, 默认 8787, 0 表示由系统分配空闲端口. */
    port: number;
    /** 文本/直连 WS 完整消息和处理后正文的字节上限, 缺省补为 10 MiB. */
    maxPayloadBytes: number;
    /** 单个原始文件大小上限, 缺省补为 100 MiB, 覆写可选字段. */
    maxFileBytes: number;
    /** 同时活动的文件会话上限, 缺省补为 4, 不包含文本队列. */
    maxFileTransfers: number;
    /** 未完成文件的总传输时限, 缺省补为 300000 毫秒. */
    fileTransferTimeoutMs: number;
    /** group 的 UTF-8 字节上限, 缺省补为 256. */
    maxGroupBytes: number;
    /** 本实例所有连接共享的待处理消息数量上限, 默认 128. */
    maxPendingMessages: number;
    /** 本实例所有待处理原始消息的总字节上限, 默认 32 MiB. */
    maxPendingBytes: number;
    /** 本库接管的 WS 连接上限, 默认 32; HTTP 另有同值请求上限, 不控制共享宿主的连接总数. */
    maxConnections: number;
    /** 连接关闭握手的等待毫秒数, 默认 1000, 不限制内容处理耗时. */
    shutdownTimeoutMs: number;
    /** 文本是否自动补尾部 LF, 缺省补为 true, 覆写父类型的可选字段. */
    autoNewline: boolean;
    /** 是否允许未携带 Origin 的原生客户端, 缺省补为 true. */
    allowMissingOrigin: boolean;
}

/**
 * 用统一错误码报告配置问题, 避免延迟到收到消息时才失败.
 * @param {string} message 可以安全返回给调用方的配置错误摘要.
 */
function invalid(message: string): never {
    throw new ReceiverError(ReceiverErrorCode.INVALID_CONFIG, message);
}

/**
 * 验证独立模式和外部模式的互斥选项, 并补齐安全默认值.
 * @param {ReceiverOptions} options 接收器的配置选项.
 */
export function resolveOptions(options: ReceiverOptions = {}): ResolvedOptions {
    if (!options || typeof options !== 'object') invalid('options must be an object.');
    const directory = options.directory === undefined ? 'received' : options.directory;
    if (typeof directory !== 'string' || !directory.trim()) {
        invalid('directory must be a non-empty path.');
    }
    if (directory.includes('\0')) invalid('directory cannot contain NUL.');
    if (options.server && options.adapter) invalid('Provide either server or adapter, not both.');
    if ((options.server || options.adapter) && (options.host !== undefined || options.port !== undefined)) {
        invalid('host and port are standalone-only; omit them when using server or adapter.');
    }
    if (options.server && (typeof options.server.on !== 'function' || typeof options.server.address !== 'function')) {
        invalid('server must be a Node HTTP/HTTPS server.');
    }
    if (options.adapter && typeof options.adapter.attach !== 'function') invalid('adapter must provide attach().');
    const result: ResolvedOptions = {
        // 先保留调用方的钩子和接入选项, 再覆盖已解析字段并补齐可选属性的默认值.
        ...options,
        directory: resolve(directory),
        path: options.path ?? '/device-data',
        host: options.host ?? '127.0.0.1',
        port: options.port ?? 8787,
        maxPayloadBytes: options.maxPayloadBytes ?? 10 * 1024 * 1024,
        maxFileBytes: options.maxFileBytes ?? 100 * 1024 * 1024,
        maxFileTransfers: options.maxFileTransfers ?? 4,
        fileTransferTimeoutMs: options.fileTransferTimeoutMs ?? 300000,
        maxGroupBytes: options.maxGroupBytes ?? 256,
        maxPendingMessages: options.maxPendingMessages ?? 128,
        maxPendingBytes: options.maxPendingBytes ?? 32 * 1024 * 1024,
        maxConnections: options.maxConnections ?? 32,
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1000,
        allowMissingOrigin: options.allowMissingOrigin ?? true,
        autoNewline: options.autoNewline === undefined ? true : options.autoNewline,
    };
    if (
        typeof result.path !== 'string'
        || !result.path.startsWith('/')
        || result.path.startsWith('//')
        // eslint-disable-next-line no-control-regex -- 接收路径必须显式拒绝控制字符.
        || /[\s?#\\\u0000-\u001F\u007F]/u.test(result.path)
        || new URL(result.path, 'http://localhost').pathname !== result.path
    ) {
        invalid('path must be a canonical absolute URL pathname without a query or fragment.');
    }
    if (typeof result.host !== 'string' || !result.host.trim()) invalid('host must be a non-empty string.');
    if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) {
        invalid('port must be an integer between 0 and 65535.');
    }
    for (const name of [
        'maxPayloadBytes',
        'maxFileBytes',
        'maxFileTransfers',
        'fileTransferTimeoutMs',
        'maxGroupBytes',
        'maxPendingMessages',
        'maxPendingBytes',
        'maxConnections',
        'shutdownTimeoutMs',
    ] as const) {
        if (!Number.isSafeInteger(result[name]) || result[name] <= 0) {
            invalid(`${name} must be a positive safe integer.`);
        }
    }
    if (result.shutdownTimeoutMs > 2_147_483_647) invalid('shutdownTimeoutMs exceeds the timer limit.');
    if (result.fileTransferTimeoutMs > 2_147_483_647) invalid('fileTransferTimeoutMs exceeds the timer limit.');
    if (typeof result.allowMissingOrigin !== 'boolean') invalid('allowMissingOrigin must be a boolean.');
    if (typeof result.autoNewline !== 'boolean') invalid('autoNewline must be a boolean.');
    if (options.token !== undefined && (typeof options.token !== 'string' || !options.token)) {
        invalid('token must not be empty.');
    }
    for (const callback of ['processContent', 'onError'] as const) {
        if (options[callback] !== undefined && typeof options[callback] !== 'function') {
            invalid(`${callback} must be a function.`);
        }
    }
    if (options.allowedOrigins !== undefined) {
        if (!Array.isArray(options.allowedOrigins)) {
            invalid('allowedOrigins must be an array of exact HTTP(S) origins.');
        }
        result.allowedOrigins = options.allowedOrigins.map(
            (origin) => {
                try {
                    const url = new URL(origin);
                    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
                        // eslint-disable-next-line unicorn/error-message -- 此异常只用于进入下方统一的配置错误分支.
                        throw new Error();
                    }
                    return origin;
                }
                catch {
                    return invalid('allowedOrigins must contain canonical HTTP(S) origins, without a trailing slash.');
                }
            },
        );
    }
    return result;
}
