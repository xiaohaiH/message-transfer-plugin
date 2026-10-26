import type { IncomingMessage } from 'node:http';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Environment, Plugin, WebSocketClient } from 'vite';
import { resolveOptions } from './config.js';
import { ReceiverError, ReceiverErrorCode } from './errors.js';
import { FILE_REQUEST } from './file-protocol.js';
import { createReceiver } from './receiver.js';
import type { Receiver } from './receiver.js';
import type { ReceiverOptions } from './types.js';

// HMR 的默认命名空间只允许一个接收器声明, 防止不同插件路径把同一消息写入两次.
const hmrOwners = new WeakMap<object, Receiver>();

/** 监听端口由 Vite 或外部宿主管理, 插件不接受独立服务的 host/port 选项. */
export type MessageTransferPluginOptions = Omit<
    ReceiverOptions,
    /** 监听主机由 Vite 或外部宿主决定, 插件不再单独配置. */
    | 'host'
    /** 监听端口由 Vite 或外部宿主决定, 插件不创建另一监听端口. */
    | 'port'
>;

/**
 * 开发时自动复用 HMR 并提供 HTTP/直连 WS 接口, 构建时不启动接收器.
 * @param {MessageTransferPluginOptions} options 保存目录, 路径和安全策略等核心选项, 不包含 host/port.
 */
export function messageTransferPlugin(options: MessageTransferPluginOptions = {}): Plugin {
    const resolved = resolveOptions(options);
    const directory = resolved.directory;
    const virtualClient = '\0message-transfer:auto-client';
    let endpoint = resolved.path;
    let useHot = true;
    // 源码测试与发布后的 JS 使用同一插件逻辑, 浏览器资源不导入 Node 核心.
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const clientModule = `/@fs/${fileURLToPath(new URL(`./client.${extension}`, import.meta.url)).replaceAll('\\', '/')}`;
    const hostModule = `/@fs/${fileURLToPath(new URL(`./client-host.${extension}`, import.meta.url)).replaceAll('\\', '/')}`;
    // 转义目录中的 glob 字符, 否则 private[1] 等合法目录名无法得到准确保护.
    const privatePattern = `${directory.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/**`;
    // Vite 重启会先创建新服务再关闭旧服务, 按宿主分别管理接收器.
    const byEnvironment = new WeakMap<Environment, Receiver>();
    const byHost = new WeakMap<object, Receiver>();
    const detachments = new WeakMap<Receiver, () => void>();
    /**
     * 先移除 HMR 监听器, 再由核心排空已接收任务, 不关闭 Vite 的共享连接.
     * @param {Receiver | undefined} current 当前宿主对应的接收器, 尚未启动时为空.
     */
    async function stop(current: Receiver | undefined): Promise<void> {
        if (!current) return;
        detachments.get(current)?.();
        detachments.delete(current);
        await current.stop();
    }
    return {
        name: 'vite-plugin-message-transfer',
        apply: 'serve',
        enforce: 'pre',
        configResolved(config) {
            endpoint = posix.join(config.base, resolved.path);
            useHot = config.server.hmr !== false && config.server.ws !== false;
        },
        resolveId(id) {
            if (id === '@xiaohaih/message-transfer-plugin/client') return { id: virtualClient, moduleSideEffects: true };
        },
        load(id) {
            if (id !== virtualClient) return;
            return `import { send, sendByFetch, sendBySocket } from ${JSON.stringify(clientModule)};
import { installClient } from ${JSON.stringify(hostModule)};
const dispose = installClient({ endpoint: ${JSON.stringify(endpoint)}, ${useHot ? 'hot: import.meta.hot' : ''} });
if (import.meta.hot) import.meta.hot.dispose(dispose);
export { send, sendByFetch, sendBySocket };
export { ReceiptCode, ReceiverErrorCode } from ${JSON.stringify(clientModule)};`;
        },
        config() {
            // Vite 会合并用户 deny 数组, 同时保留默认敏感文件规则, 防止默认目录被 HTTP 读取.
            return {
                server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', privatePattern] } },
                optimizeDeps: { exclude: ['@xiaohaih/message-transfer-plugin/client', '@xiaohaih/message-transfer-plugin/client-host'] },
            };
        },
        async configureServer(vite) {
            const server = options.server ?? (options.adapter ? undefined : (vite.httpServer ?? undefined));
            if (!server && !options.adapter) {
                throw new ReceiverError(
                    ReceiverErrorCode.INVALID_CONFIG,
                    'Vite middleware mode requires an explicit HTTP server or adapter.',
                );
            }
            if (server === vite.httpServer && vite.config.server.hmr !== false) {
                const hmr = typeof vite.config.server.hmr === 'object' ? vite.config.server.hmr : undefined;
                const hmrPath = hmr?.path ? posix.join(vite.config.base, hmr.path) : vite.config.base;
                if ((options.path ?? '/device-data') === hmrPath) {
                    throw new ReceiverError(ReceiverErrorCode.INVALID_CONFIG, 'Receiver path must not collide with the Vite HMR path.');
                }
            }
            const host = server ?? options.adapter!;
            await stop(byHost.get(host));
            const hotEnabled = vite.config.server.hmr !== false && vite.config.server.ws !== false;
            if (hotEnabled && hmrOwners.has(vite.ws)) {
                throw new ReceiverError(ReceiverErrorCode.INVALID_CONFIG, 'The message-transfer HMR namespace is already registered.');
            }
            const current = createReceiver({
                ...options,
                directory,
                ...(server ? { server } : {}),
                onError: options.onError ?? ((error) => {
                    vite.config.logger.error(`[message-transfer] ${error.code}: ${error.message}`);
                }),
            });
            byHost.set(host, current);
            if (hotEnabled) hmrOwners.set(vite.ws, current);
            try {
                await current.start();
            }
            catch (error) {
                if (hmrOwners.get(vite.ws) === current) hmrOwners.delete(vite.ws);
                if (byHost.get(host) === current) byHost.delete(host);
                throw error;
            }
            const requests = new WeakMap<object, IncomingMessage>();
            const closeListeners = new Map<WebSocketClient['socket'], () => void>();
            let detached = false;
            const onConnection = (socket: WebSocketClient['socket'], request: IncomingMessage) => {
                requests.set(socket, request);
                const onClose = () => {
                    requests.delete(socket);
                    closeListeners.delete(socket);
                    void current.releaseSharedFiles(request).catch(() => {
                        vite.config.logger.error('[message-transfer] WRITE_FAILED: Could not clean up file transfers.');
                    });
                };
                closeListeners.set(socket, onClose);
                socket.once('close', onClose);
            };
            const onMessage = (data: unknown, client: WebSocketClient) => {
                const request = requests.get(client.socket);
                // 没有可信握手上下文时拒绝接收, 不读取 data 中自报的来源或 Vite token.
                if (!request || detached) return;
                void current.handleSharedMessage(data, request).then((reply) => {
                    if (reply && !detached && client.socket.readyState === 1 && client.socket.bufferedAmount <= resolved.maxPendingBytes) {
                        client.send(reply.type, reply);
                    }
                }).catch(() => {
                    vite.config.logger.error('[message-transfer] TRANSPORT_ERROR: Could not send HMR receipt.');
                });
            };
            if (hotEnabled) {
                vite.ws.on('connection', onConnection);
                vite.ws.on('message-transfer:request', onMessage);
                vite.ws.on(FILE_REQUEST, onMessage);
            }
            detachments.set(current, () => {
                detached = true;
                if (hmrOwners.get(vite.ws) === current) hmrOwners.delete(vite.ws);
                vite.ws.off('connection', onConnection);
                vite.ws.off('message-transfer:request', onMessage);
                vite.ws.off(FILE_REQUEST, onMessage);
                for (const [socket, listener] of closeListeners) socket.off('close', listener);
                closeListeners.clear();
            });
            vite.middlewares.use((request, response, next) => {
                if (detached) {
                    next();
                    return;
                }
                const original = request.url;
                // 配合 Vite base 提供同源端点, 还原 URL 后不影响宿主后续路由.
                if (vite.config.base !== '/' && request.url?.startsWith(vite.config.base)) {
                    request.url = `/${request.url.slice(vite.config.base.length)}`;
                }
                let handled: boolean;
                try {
                    handled = current.handleRequest(request, response);
                }
                finally { request.url = original; }
                if (!handled) next();
            });
            // 本地显示真实目录, 远端回执仍只包含文件名而不暴露绝对路径.
            vite.config.logger.info(`[message-transfer] Directory: ${current.directory}`);
            // watcher 的 close 事件在 Vite 5-8 的开发服务器关闭时触发.
            vite.watcher.once('close', () => {
                void stop(current).finally(() => {
                    if (byHost.get(host) === current) byHost.delete(host);
                });
            });
            // Vite 6+ 的环境生命周期允许等待停止完成; watcher 监听覆盖 Vite 5.
            if ('environments' in vite) {
                for (const environment of Object.values(vite.environments)) byEnvironment.set(environment, current);
            }
        },
        async closeBundle() {
            if (!('environment' in this)) return;
            const current = byEnvironment.get(this.environment);
            byEnvironment.delete(this.environment);
            await stop(current);
        },
    };
}

export default messageTransferPlugin;
