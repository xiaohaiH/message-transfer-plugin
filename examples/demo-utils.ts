import type { Receiver } from '@xiaohaih/message-transfer-plugin';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { ServerOptions as HttpsOptions, Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

/** Node 示例的监听及页面能力, 不改变 SDK 的通道选择策略. */
export type DemoMode = 'ws' | 'http' | 'https';
/** 页面宿主可以使用 HTTP 或 HTTPS, 关闭权限始终属于示例. */
export type DemoServer = Server | HttpsServer;

/** Node 示例共用参数, 默认监听局域网并使用核心的 received 目录. */
export interface DemoOptions {
    /** 启动入口决定的示例类型, HTTPS 模式使用 TLS 及 WSS. */
    mode: DemoMode;
    /** 绑定监听器并生成访问地址的主机名. */
    host: string;
    /** WebSocket 或 HTTP 接收服务使用的端口. */
    port: number;
    /** 浏览器发送页面使用的 HTTP 端口. */
    pagePort: number;
    /** 接收文件保存目录, 未设置时使用核心默认目录. */
    directory?: string;
    /** 可选的访问令牌, 仅从环境变量读取. */
    token?: string;
    /** HTTPS 必填的 PEM 证书路径, 不随页面发送. */
    cert?: string;
    /** HTTPS 必填的 PEM 私钥路径, 不打印或发布密钥内容. */
    key?: string;
}

/**
 * 参数解析不依赖 Vite, 令牌只从环境读取, 不打印到 URL 或命令行帮助中.
 * @param {DemoMode} mode 示例运行模式, 决定默认端口和参数规则.
 */
export function readDemoOptions(mode: DemoMode): DemoOptions | undefined {
    const { values } = parseArgs({
        options: {
            'host': { type: 'string' },
            'port': { type: 'string' },
            'page-port': { type: 'string' },
            'directory': { type: 'string', short: 'd' },
            'cert': { type: 'string' },
            'key': { type: 'string' },
            'help': { type: 'boolean', short: 'h' },
        },
        strict: true,
        allowPositionals: false,
    });
    const defaultPort = mode === 'ws' ? 8787 : mode === 'https' ? 8789 : 8788;
    if (values.help) {
        console.log(
            `pnpm demo:${mode} [--host 0.0.0.0] [--port ${defaultPort}] [--directory ./received]${mode === 'ws' ? ' [--page-port 8786]' : ''}${mode === 'https' ? ' --cert <certificate.pem> --key <private-key.pem>' : ''}`,
        );
        console.log('可用 MESSAGE_TRANSFER_TOKEN 环境变量启用鉴权.');
        return undefined;
    }
    /**
     * 将命令行端口转换为有效数字, 未提供时采用默认值.
     * @param {string | undefined} value 用户输入的端口字符串.
     * @param {number} fallback 当前模式的默认端口.
     */
    const port = (value: string | undefined, fallback: number) => {
        if (value === undefined) return fallback;
        if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('port must be between 0 and 65535.');
        return Number(value);
    };
    const host = values.host ?? '0.0.0.0';
    if (!host.trim() || host.includes('\0')) throw new Error('host must be a valid non-empty hostname.');
    if (mode !== 'ws' && values['page-port'] !== undefined) {
        throw new Error(`demo:${mode} shares one port; do not pass --page-port.`);
    }
    if (mode === 'https' && (!values.cert || !values.key)) {
        throw new Error('demo:https requires --cert and --key pointing to your locally trusted certificate and private key.');
    }
    if (mode !== 'https' && (values.cert !== undefined || values.key !== undefined)) {
        throw new Error('--cert and --key are only supported by demo:https.');
    }
    return {
        mode,
        host,
        port: port(values.port, defaultPort),
        pagePort: port(values['page-port'], 8786),
        ...(values.directory === undefined ? {} : { directory: values.directory }),
        ...(values.cert === undefined ? {} : { cert: values.cert }),
        ...(values.key === undefined ? {} : { key: values.key }),
        ...(process.env.MESSAGE_TRANSFER_TOKEN === undefined ? {} : { token: process.env.MESSAGE_TRANSFER_TOKEN }),
    };
}

// 跟踪示例自己拥有的 TCP 连接, 关闭时也清理尚未完成请求的客户端.
const connections = new WeakMap<DemoServer, Set<Socket>>();
const businessServers = new WeakMap<DemoServer, WebSocketServer>();

/**
 * 由示例宿主显式转交 HTTP 请求, 不侵入其他请求监听器.
 * @param {IncomingMessage} request 页面服务器实际收到的请求.
 * @param {ServerResponse} response 当前请求对应的响应.
 */
type DemoRequestHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

/** 页面宿主的显式接入配置, 与业务发送函数的参数分离. */
export interface SenderServerOptions {
    /** 独立直连 WS 的真实端口, 仅供页面诊断而非业务连接目标. */
    wsPort?: () => number | undefined;
    /** 精确转交 POST 请求, 未匹配时继续处理固定页面资源. */
    handleRequest?: DemoRequestHandler;
    /** 启用同源业务连接, 升级时获取已经启动的核心, 不混用直连 WS 协议. */
    sharedReceiver?: () => Receiver | undefined;
    /** HTTPS 所需证书和私钥, 不暴露任意 TLS 安全开关或把文件内容发送到浏览器. */
    tls?: Pick<HttpsOptions, 'cert' | 'key'>;
}

/**
 * 只提供固定页面和浏览器 SDK 模块, 不把项目目录或接收目录作为静态目录发布.
 * @param {SenderServerOptions} options 示例自己拥有的 HTTP(S), POST 和共享 WS 配置.
 */
export async function createSenderServer(options: SenderServerOptions = {}): Promise<DemoServer> {
    const { wsPort, handleRequest, sharedReceiver, tls } = options;
    const [html, javascript, hostScript] = await Promise.all([
        readFile(new URL('./sender.html', import.meta.url), 'utf8'),
        readFile(new URL('./sender.js', import.meta.url), 'utf8'),
        readFile(new URL('./sender-host.js', import.meta.url), 'utf8'),
    ]);
    // 只改写本示例的 SDK 裸导入, 避免旧浏览器依赖原生 import maps.
    const scripts = new Map([['/sender.js', javascript], ['/sender-host.js', hostScript]].map(([path, source]) => [
        path!,
        source!.replace(/(['"])@xiaohaih\/message-transfer-plugin\/(client(?:-host)?)\1/g, (_match, quote: string, entry: string) => `${quote}/@message-transfer/${entry}.js${quote}`),
    ]));
    for (const name of ['client', 'client-host', 'client-runtime', 'client-files', 'content', 'file-protocol', 'names', 'errors']) {
        scripts.set(`/@message-transfer/${name}.js`, await readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8'));
    }
    const serve = (request: IncomingMessage, response: ServerResponse) => {
        if (handleRequest?.(request, response)) return;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }
        const path = request.url?.split('?', 1)[0] ?? '';
        const page = path === '/' || path === '/sender.html';
        if (!page && !scripts.has(path)) {
            response.writeHead(404);
            response.end('Not Found');
            return;
        }
        const target = wsPort?.();
        if (wsPort && target === undefined) {
            response.writeHead(503);
            response.end('Receiver is starting.');
            return;
        }
        // 端口来自实际监听结果且必为整数, 不从请求参数向 HTML 注入内容.
        const body = page
            ? html.replace('data-ws-port=""', `data-ws-port="${target ?? ''}"`).replace('data-business-socket=""', `data-business-socket="${sharedReceiver ? 'true' : ''}"`)
            : scripts.get(path)!;
        response.writeHead(200, {
            'Content-Type': page ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
    };
    const server = tls ? createHttpsServer(tls, serve) : createServer(serve);
    const business = sharedReceiver ? new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024, perMessageDeflate: false }) : undefined;
    if (business) {
        businessServers.set(server, business);
        business.on('error', () => console.error('[demo] Business WebSocket server error.'));
    }
    const sockets = new Set<Socket>();
    connections.set(server, sockets);
    server.on(
        'connection',
        (socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        },
    );
    server.on(
        'upgrade',
        (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            const path = request.url?.split('?', 1)[0];
            if (path === '/business-socket' && business) {
                const receiver = sharedReceiver?.();
                if (receiver?.state !== 'running' || business.clients.size >= 32) {
                    rejectUpgrade(socket, 503, 'Service Unavailable');
                    return;
                }
                // 业务宿主先检查真实握手 Origin, 应用 token 仍由核心逐条验证, 不放进 URL.
                let sameOrigin = false;
                const origin = request.headers.origin;
                try {
                    sameOrigin = typeof origin === 'string' && new URL(origin).origin === origin
                        && request.headers.host !== undefined && origin === new URL(`${tls ? 'https:' : 'http:'}//${request.headers.host}`).origin;
                }
                catch { /* 无效或 opaque Origin 必须拒绝. */ }
                if (!sameOrigin) {
                    rejectUpgrade(socket, 403, 'Forbidden');
                    return;
                }
                try {
                    business.handleUpgrade(request, socket, head, (client) => {
                        client.on('error', () => {});
                        receiver.attachSharedSocket(client, request);
                        // 示例业务流量与 SDK 命名空间并存, 不把普通业务帧当作待保存的原文.
                        client.on('message', (raw, binary) => {
                            if (!binary && Buffer.isBuffer(raw) && raw.length === 9 && raw.toString() === 'demo:ping' && client.bufferedAmount < 1024) {
                                client.send('demo:pong');
                            }
                        });
                    });
                }
                catch { socket.destroy(); }
                return;
            }
            // 外部 HTTP(S) 的直连 WS 路径交给核心; 独立模式的页面端口不接管直连 WS 路径.
            if (wsPort || path !== '/device-data') rejectUpgrade(socket, 404, 'Not Found');
        },
    );
    return server;
}

/**
 * 在升级前用固定消息结束当前连接, 不反射请求输入或应用令牌.
 * @param {Duplex} socket 示例拥有的待升级连接.
 * @param {number} status 固定 HTTP 拒绝状态码.
 * @param {string} message 固定状态摘要, 不包含用户内容.
 */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * 等待真实监听完成, 同步抛错和异步端口冲突都撤销临时监听器.
 * @param {DemoServer} server 要启动的 HTTP(S) 服务.
 * @param {number} port 请求监听的端口.
 * @param {string} host 请求绑定的主机.
 */
export async function listenDemo(server: DemoServer, port: number, host: string): Promise<number> {
    await new Promise<void>(
        (resolve, reject) => {
            const ready = /** 监听成功事件处理器, 清理错误监听并完成等待. */ () => {
                server.off('error', failed);
                resolve();
            };
            const failed = (error: unknown) => {
                server.off('listening', ready);
                server.off('error', failed);
                reject(error);
            };
            server.once('listening', ready);
            server.once('error', failed);
            try {
                server.listen(port, host);
            }
            catch (error) {
                failed(error);
            }
        },
    );
    return (server.address() as AddressInfo).port;
}

/**
 * 先由调用方停止接收器, 再关闭示例的 HTTP 监听和剩余 TCP 连接.
 * @param {DemoServer} server 要关闭的示例 HTTP(S) 服务.
 */
export async function closeDemoServer(server: DemoServer): Promise<void> {
    const business = businessServers.get(server);
    businessServers.delete(server);
    if (business) {
        // 这些连接由 demo 创建, 核心仅解绑. 应用宿主退出时由 demo 负责最终关闭.
        for (const socket of business.clients) socket.terminate();
        await new Promise<void>((resolve) => business.close(() => resolve()));
    }
    for (const socket of connections.get(server) ?? []) socket.destroy();
    if (!server.listening) return;
    await new Promise<void>(
        (resolve, reject) =>
            server.close(
                (error) => (error ? reject(error) : resolve()),
            ),
    );
}

/**
 * 列出实际可以从浏览器访问的地址, 不把 0.0.0.0 当成客户端地址.
 * @param {string} host 服务绑定的主机名或通配地址.
 */
export function demoHosts(host: string): string[] {
    if (host !== '0.0.0.0' && host !== '::') return [host];
    const hosts = new Set(['127.0.0.1', 'localhost']);
    if (host === '::') hosts.add('::1');
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) hosts.add(entry.address);
        }
    }
    return [...hosts];
}

/**
 * 用 URL 规范化默认端口和 IPv6 方括号, 确保 Origin 白名单精确一致.
 * @param {string} host Origin 使用的主机名或 IPv6 地址.
 * @param {number} port Origin 使用的端口.
 * @param {'http:' | 'https:'} protocol 页面服务实际使用的协议, 不在客户端猜测或降级 TLS.
 */
export function pageOrigin(host: string, port: number, protocol: 'http:' | 'https:' = 'http:'): string {
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return new URL(`${protocol}//${authority}:${port}`).origin;
}

/**
 * 打印保存目录和两端地址, 手机直接访问 Page 地址即可.
 * @param {DemoOptions} options 示例监听及目录配置.
 * @param {Receiver} receiver 已启动的文件接收器.
 * @param {number} pagePort 页面服务实际监听端口.
 */
export function printDemo(options: DemoOptions, receiver: Receiver, pagePort: number): void {
    const address = receiver.address;
    if (!address || typeof address === 'string') throw new Error('Receiver is not listening.');
    console.log(`Directory: ${receiver.directory}`);
    const protocol = options.mode === 'https' ? 'https:' : 'http:';
    for (const host of demoHosts(options.host)) {
        const origin = pageOrigin(host, pagePort, protocol);
        console.log(`Page: ${origin}/sender.html`);
        const endpoint = new URL('/device-data', pageOrigin(host, address.port, protocol));
        endpoint.protocol = protocol === 'https:' ? 'wss:' : 'ws:';
        console.log(`WebSocket: ${endpoint.href}`);
        console.log(`POST: ${origin}/device-data`);
        if (options.mode !== 'http') {
            const shared = new URL('/business-socket', origin);
            shared.protocol = endpoint.protocol;
            console.log(`Business WebSocket: ${shared.href}`);
        }
    }
    if (options.mode === 'https') console.log('HTTPS/WSS 需要客户端信任证书且证书覆盖访问地址, 不要关闭 TLS 校验.');
    console.log('收到成功回执后, 到 Directory/date/groupDirectory/file 查找文件, 空 groupDirectory 省略. Ctrl+C 退出.');
}

/**
 * 保持信号清理幂等, 不在退出前丢弃已接收的写入.
 * @param {() => Promise<void>} stop 完成接收器和服务清理的异步回调.
 */
export function installShutdown(stop: () => Promise<void>): void {
    let stopping = false;
    const shutdown = () => {
        if (stopping) return;
        stopping = true;
        void stop()
            .catch(
                (error: unknown) => {
                    console.error(error);
                    process.exitCode = 1;
                },
            )
            .finally(() => {
                process.off('SIGINT', shutdown);
                process.off('SIGTERM', shutdown);
            });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
