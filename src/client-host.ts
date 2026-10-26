import { installContext } from './client-runtime.js';

/**
 * 宿主资源发出的事件处理器, 输入须经过协议验证.
 * @param {unknown} value 原始连接事件或 HMR 自定义负载.
 */
export type ClientListener = (value: unknown) => void;

/** 已有浏览器或兼容 ws 连接的最小接口, SDK 不创建或关闭它. */
export interface ClientSocket {
    /** 标准 WebSocket 状态, 只有值为 1 时才选择该连接. */
    readonly readyState: number;
    /**
     * 使用宿主已有连接发送文本帧.
     * @param {string} data 命名空间 JSON 请求帧.
     */
    send(data: string): void;
    /**
     * 增加监听器, 不覆盖宿主 onmessage.
     * @param {'message' | 'close' | 'error'} type 要订阅的连接事件.
     * @param {(event: unknown) => void} listener 本库自己的处理器.
     */
    addEventListener(type: 'message' | 'close' | 'error', listener: ClientListener): void;
    /**
     * 仅移除本库注册的监听器.
     * @param {'message' | 'close' | 'error'} type 原注册事件.
     * @param {(event: unknown) => void} listener 原注册处理器引用.
     */
    removeEventListener(type: 'message' | 'close' | 'error', listener: ClientListener): void;
}

/** 与 Vite 无运行时耦合的 HMR 结构接口. */
export interface ClientHot {
    /**
     * 订阅自定义事件及连接状态事件.
     * @param {string} event 宿主事件名.
     * @param {(data: unknown) => void} listener 本库事件处理器.
     */
    on(event: string, listener: ClientListener): void;
    /**
     * 移除自己注册的事件处理器.
     * @param {string} event 原注册事件名.
     * @param {(data: unknown) => void} listener 原注册处理器引用.
     */
    off(event: string, listener: ClientListener): void;
    /**
     * 发送命名空间自定义事件, 不控制 HMR 连接生命周期.
     * @param {string} event 本库请求事件名.
     * @param {unknown} data 带关联 id 的请求负载.
     */
    send(event: string, data: unknown): void;
}

/**
 * 接入已有请求工具时遵循 Fetch 语义, 禁用自动重试并遵守 signal 和 redirect.
 * @param {string} input 同源端点或宿主配置的代理地址.
 * @param {RequestInit | undefined} init POST 正文, 认证头, 取消信号及禁止重定向的策略.
 */
export type ClientRequest = (input: string, init?: RequestInit) => Promise<Response>;

/** 仅由宿主一次性安装环境资源, send, sendByFetch 和 sendBySocket 共用这些配置. */
export interface InstallClientOptions {
    /** 已建立的业务连接, 不提供时不会自行创建 WebSocket. */
    socket?: ClientSocket;
    /** Vite 集成自动提供的 HMR 上下文, 核心客户端不导入 Vite. */
    hot?: ClientHot;
    /** HTTP(S) 接收端点, 默认 /device-data, 相对地址沿用页面协议, 显式 URL 保持不变. */
    endpoint?: string;
    /** 应用令牌或每次发送时读取令牌的函数, 不复用 Vite 的 HMR 令牌. */
    token?: string | (() => string | undefined);
    /** 已有 Fetch 兼容请求函数, 默认使用 globalThis.fetch. */
    request?: ClientRequest;
    /** 整次发送的等待上限, 文本默认 30000 毫秒, 文件默认 300000 毫秒, 超时不重发. */
    timeoutMs?: number;
}

/**
 * 安装宿主上下文并返回幂等清理函数, 不关闭共享连接, 不影响其他安装的监听器.
 * @param {InstallClientOptions} options 宿主已有资源和默认配置, 无通道选择参数.
 */
export function installClient(options: InstallClientOptions): () => void {
    return installContext(options);
}
