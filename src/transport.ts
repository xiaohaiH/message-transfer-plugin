import detectPort from 'detect-port';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { ResolvedOptions } from './config.js';
import type { HttpHandler } from './http.js';
import type { HttpService, SocketAdapterContext, SocketBinding, UpgradeRejection } from './types.js';

// 只记录本库声明的路由, 防止多个接收器重复处理同一次 upgrade.
const routes = new WeakMap<HttpService, Set<string>>();

/**
 * 用固定服务端状态结束升级请求, 不反射请求中的不可信内容.
 * @param {Duplex} socket 尚未升级为 WebSocket 的底层连接.
 * @param {number} status 服务端选择的 HTTP 拒绝状态码.
 * @param {string} message 固定的 HTTP 状态摘要, 不包含客户端输入.
 */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * 仅挂接指定路径, 未匹配请求留给宿主, 清理时不关闭宿主服务.
 * @param {HttpService} server 由调用方或独立模式提供的 HTTP 升级宿主.
 * @param {SocketAdapterContext} context 核心提供的路由, 鉴权, 负载限制和连接接管回调.
 * @param {() => void} onHostClose 宿主关闭后通知核心清理本次挂接的回调.
 * @param {boolean} standalone 是否由核心独占宿主, 为 true 时主动拒绝无关升级路径.
 */
export function attachHttp(
    server: HttpService,
    context: SocketAdapterContext,
    onHostClose: () => void,
    standalone = false,
): SocketBinding {
    const claimed = routes.get(server) ?? new Set<string>();
    if (claimed.has(context.path)) throw new Error(`WebSocket path is already registered: ${context.path}`);
    const wss = new WebSocketServer({
        noServer: true,
        clientTracking: false, // 连接由核心统一管理, 不由调用方的宿主服务代为清理.
        maxPayload: context.maxPayloadBytes,
        perMessageDeflate: false,
    });
    claimed.add(context.path);
    routes.set(server, claimed);
    // eslint-disable-next-line ts/unbound-method -- 核心提供的 onError 是不依赖 this 的箭头函数.
    wss.on('error', context.onError);
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!context.matches(request)) {
            if (standalone) rejectUpgrade(socket, 404, 'Not Found');
            return;
        }
        const rejection: UpgradeRejection | undefined = context.verify(request);
        if (rejection) {
            rejectUpgrade(socket, rejection.status, rejection.message);
            return;
        }
        try {
            wss.handleUpgrade(
                request,
                socket,
                head,
                (ws) => context.accept(ws, request),
            );
        }
        catch (error) {
            context.onError(error);
            socket.destroy();
        }
    };
    server.on('upgrade', upgrade);
    server.once('close', onHostClose);
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            server.off('upgrade', upgrade);
            server.off('close', onHostClose);
            claimed.delete(context.path);
            if (claimed.size === 0) routes.delete(server);
            wss.close();
        },
    };
}

/**
 * 没有外部宿主时创建独立 HTTP/WS 监听, 该模式拥有全部底层资源.
 * @param {ResolvedOptions} options 已解析的监听地址, 端口, 容量和关闭超时配置.
 * @param {SocketAdapterContext} context 核心提供的 WebSocket 路由和安全回调.
 * @param {() => void} onHostClose 底层监听关闭后通知核心进入清理流程的回调.
 * @param {HttpHandler['handle']} handleRequest 核心 HTTP 路由, 未匹配时返回 false.
 */
export async function listenStandalone(
    options: ResolvedOptions,
    context: SocketAdapterContext,
    onHostClose: () => void,
    handleRequest: HttpHandler['handle'] = () => false,
): Promise<{
    /** 独立模式实际创建并成功监听的 HTTP 服务. */
    server: HttpService;
    /** 同时清理升级路由, 底层连接和监听端口的句柄. */
    binding: SocketBinding;
}> {
    const server = createServer(
        (request, response) => {
            if (handleRequest(request, response)) return;
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Message receiver: use the configured POST or WebSocket path.\n');
        },
    );
    const sockets = new Set<Socket>();
    server.on(
        'connection',
        (socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        },
    );
    const attached = attachHttp(server, context, onHostClose, true);
    try {
        let port = options.port;
        try {
            await listen(server, port, options.host);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
            port = await detectPort({ port, hostname: options.host });
            await listen(server, port, options.host);
        }
    }
    catch (error) {
        await attached.dispose();
        for (const socket of sockets) socket.destroy();
        if (server.listening) server.close();
        throw error;
    }
    // 只接管自己创建的服务器错误, 不改变外部服务器的错误处理语义.
    // eslint-disable-next-line ts/unbound-method -- 核心提供的诊断回调不依赖调用对象的 this.
    server.on('error', context.onError);
    return {
        server,
        binding: {
            async dispose() {
                await attached.dispose();
                await new Promise<void>(
                    (resolve, reject) => {
                    // 未完成的 HTTP 请求和升级握手也需要关闭上限, 防止进程一直无法退出.
                        const timer = setTimeout(() => {
                            for (const socket of sockets) socket.destroy();
                        }, options.shutdownTimeoutMs);
                        timer.unref();
                        server.close(
                            (error) => {
                                clearTimeout(timer);
                                // eslint-disable-next-line ts/unbound-method -- 移除先前注册的同一个无 this 诊断回调.
                                server.off('error', context.onError);
                                if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
                                    reject(error);
                                }
                                else {
                                    resolve();
                                }
                            },
                        );
                        server.closeIdleConnections();
                    },
                );
            },
        },
    };
}

/**
 * 监听指定端口并等待成功或首个绑定错误.
 * @param {ReturnType<typeof createServer>} server 本函数唯一拥有的独立 HTTP 服务.
 * @param {number} port 本次尝试监听的端口, 0 表示由系统分配.
 * @param {string} host 绑定主机名或 IP 地址.
 */
function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            server.off('error', onError);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(port, host);
        }
        catch (error) {
            onError(error as Error);
        }
    });
}
