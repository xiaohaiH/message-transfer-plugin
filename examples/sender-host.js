import { installClient } from '@xiaohaih/message-transfer-plugin/client-host';

/**
 * 示例宿主建立并拥有业务连接, SDK 只注册并复用它, 不创建连接或重放消息.
 * @param {(status: string) => void} report 用纯文本展示连接状态的回调, 不传递原始异常或凭据.
 */
export function createDemoSocket(report) {
    let socket;
    let release;
    let disposed = false;

    /** 先清除当前归属和监听器, 再关闭本示例自己创建的连接. */
    function clear() {
        const cleanup = release;
        release = undefined;
        socket = undefined;
        if (cleanup) cleanup();
    }

    /** 仅初始化或手动操作时连接, 已有连接仍可用时不会再建立第二条. */
    function connect() {
        if (disposed || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
        clear();
        if (!['http:', 'https:'].includes(location.protocol) || typeof WebSocket === 'undefined') {
            report('当前环境不支持业务 WebSocket, 请使用 HTTP(S) 页面.');
            return;
        }
        try {
            const url = new URL('/business-socket', location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const label = url.protocol === 'wss:' ? 'WSS' : 'WS';
            const owned = new WebSocket(url.href);
            socket = owned;
            let uninstall;
            const onOpen = () => {
                if (socket === owned) report(`${label} 已连接, 可使用 sendBySocket.`);
            };
            const onError = () => {
                if (socket !== owned) return;
                clear();
                report(`${label} 连接失败, 请检查证书信任, Origin 和网络, 可手动重连.`);
            };
            const onClose = () => {
                if (socket !== owned) return;
                clear();
                report(`${label} 已断开, 不自动重连或重发, 可手动重连.`);
            };
            release = () => {
                owned.removeEventListener('open', onOpen);
                owned.removeEventListener('error', onError);
                owned.removeEventListener('close', onClose);
                if (uninstall) uninstall();
                if (owned.readyState < 2) {
                    try {
                        owned.close();
                    }
                    catch { /* 连接已失效时不尝试新连接或关闭别人的资源. */ }
                }
            };
            uninstall = installClient({ socket: owned });
            owned.addEventListener('open', onOpen);
            owned.addEventListener('error', onError);
            owned.addEventListener('close', onClose);
            report(`${label} 连接中, 请等待已连接提示再测试 Socket.`);
        }
        catch {
            clear();
            report('业务连接初始化失败, 可手动重试.');
        }
    }

    /** 主动断开仅由示例宿主创建的资源, 不关闭 Vite HMR 或其他业务连接. */
    function disconnect() {
        clear();
        report('业务连接已断开, sendBySocket 不会回退到 HTTP.');
    }

    /** 幂等清理, 之后任何旧按钮或迟到事件都不能建立新连接. */
    function dispose() {
        if (disposed) return;
        disposed = true;
        clear();
    }

    connect();
    return { connect, disconnect, dispose };
}
