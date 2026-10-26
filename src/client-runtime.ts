import { clientFile, fileResult, sendSharedFile } from './client-files.js';
import type { ClientHot, ClientSocket, InstallClientOptions } from './client-host.js';
import { contentText } from './content.js';
import { ReceiptCode, ReceiverErrorCode } from './errors.js';
import { FILE_HEADER, FILE_REPLY, FILE_REQUEST, fileHeader, isFileSuccess } from './file-protocol.js';
import { textName, validUnicode as unicode, validLocation } from './names.js';
import type { Receipt, SendInput } from './types.js';

const REQUEST = 'message-transfer:request';
const REPLY = 'message-transfer:receipt';
const codes = new Set<string>(Object.values(ReceiverErrorCode));

/** 一次宿主安装拥有的监听器及 HMR 可用状态. */
interface Host {
    /** 安装时的选项快照, 不修改调用者的对象. */
    options: InstallClientOptions;
    /** 未知初始状态可以交给 HMR 自身排队, 明确断开后不再向其派发新消息. */
    hotReady: boolean;
    /** 连接错误后不继续选择同一失败连接, 重连由宿主重新注册. */
    socketFailed: boolean;
    /** 幂等移除该安装拥有的监听器. */
    dispose(): void;
}

/** 单条已派发消息的等待状态, 关联 id 不提供去重或恰好一次保证. */
interface Pending {
    /** 本次实际使用的配置及连接所有者, 仅相关宿主清理会取消等待. */
    owners: Set<Host>;
    /** 共享连接对应的宿主, HTTP 请求不设置此字段. */
    host?: Host;
    /** 所使用的资源对象, 防止另一个宿主的同名事件伪造回执. */
    channel?: ClientSocket | ClientHot;
    /** 文件阶段处理器, 只有固定通道且 id 相符的帧才交给它. @param {Record<string, unknown>} frame 未验证阶段回执. */
    acceptFile?(frame: Record<string, unknown>): void;
    /**
     * 清理定时器和等待表, 只结算一次, 不执行重试.
     * @param {Error | undefined} error 网络, 超时或生命周期异常.
     * @param {Receipt | undefined} receipt 服务端确认或错误回执.
     */
    finish(error?: Error, receipt?: Receipt): void;
}

/** 多份客户端模块共用同一页面状态, 防止 HMR 模块与业务模块彼此隔离. */
interface State {
    /** 按安装顺序保存的宿主配置, 后安装的已定义配置优先. */
    hosts: Host[];
    /** 所有通道共用的有界请求表, 上限为 128. */
    pending: Map<string, Pending>;
    /** 同一页面单调递增的关联编号. */
    sequence: number;
    /** 页面级随机前缀, 防止迟到回执与下一轮模块加载混淆. */
    nonce: string;
}

const key = Symbol.for('message-transfer.client.v1');
const root = globalThis as typeof globalThis & {
    /** 当前页面共用的发送状态, 不跨页面持久化令牌或消息. */
    [key]?: State;
};
const state = root[key] ??= {
    hosts: [],
    pending: new Map(),
    sequence: 0,
    nonce: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
};

/**
 * 收窄不可信事件或 JSON 值, 不接受数组或 null.
 * @param {unknown} value 来自宿主连接的未验证值.
 */
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 验证回执的实际字段, 不把任意业务消息视为保存确认.
 * @param {unknown} value 从共享帧或 HTTP 正文解析的 JSON 值.
 */
function validReceipt(value: unknown): value is Receipt {
    if (!record(value)) return false;
    if (value.ok === true) {
        if (value.kind !== undefined) return isFileSuccess(value);
        return value.code === ReceiptCode.SUCCESS && typeof value.group === 'string' && unicode(value.group)
            && validLocation(value) && typeof value.bytes === 'number'
            && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
    }
    return value.ok === false && value.code === ReceiptCode.FAILURE && record(value.error) && typeof value.error.code === 'string'
        && codes.has(value.error.code) && typeof value.error.message === 'string';
}

/**
 * 获取最近安装且定义了对应字段的配置, 同时追踪清理归属.
 * @param {K} name 需要解析的宿主配置键.
 * @param {Set<Host>} owners 本次消息实际依赖的宿主集合.
 */
function setting<K extends keyof InstallClientOptions>(name: K, owners: Set<Host>): InstallClientOptions[K] | undefined {
    for (let i = state.hosts.length - 1; i >= 0; i--) {
        const host = state.hosts[i]!;
        if (host.options[name] !== undefined) {
            owners.add(host);
            return host.options[name];
        }
    }
    return undefined;
}

/**
 * 只接收原通道中带匹配 id 的回执, 未知或错误形状不会完成请求.
 * @param {Host} host 本监听器所属的宿主安装.
 * @param {ClientSocket | ClientHot} channel 发出事件的已有资源对象.
 * @param {unknown} value 从通道解码的命名空间帧.
 */
function accept(host: Host, channel: ClientSocket | ClientHot, value: unknown): void {
    if (!record(value) || typeof value.id !== 'string') return;
    const pending = state.pending.get(value.id);
    if (pending?.host !== host || pending.channel !== channel) return;
    if (value.type === FILE_REPLY && pending.acceptFile) pending.acceptFile(value);
    else if (value.type === REPLY && !pending.acceptFile && validReceipt(value.receipt)) pending.finish(undefined, value.receipt);
}

/**
 * 中断该通道已经发出的等待, 结果未知, 不切换通道重发.
 * @param {Host} host 通道所属的安装记录.
 * @param {ClientSocket | ClientHot} channel 已明确断开或报错的共享资源.
 */
function disconnected(host: Host, channel: ClientSocket | ClientHot): void {
    for (const pending of state.pending.values()) {
        if (pending.host === host && pending.channel === channel) pending.finish(new Error('Shared channel disconnected; delivery is unknown.'));
    }
}

/**
 * 安装固定数量的监听器, 并发消息共用监听器而非逐条添加.
 * @param {InstallClientOptions} options 宿主环境配置, 不改变资源所有权.
 */
export function installContext(options: InstallClientOptions): () => void {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2147483647)) {
        throw new TypeError('timeoutMs must be a positive timer duration.');
    }
    if (options.endpoint !== undefined && (typeof options.endpoint !== 'string' || !options.endpoint)) throw new TypeError('endpoint must be non-empty.');
    const cleanups: (() => void)[] = [];
    let disposed = false;
    const host: Host = {
        options: { ...options },
        hotReady: true,
        socketFailed: false,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const cleanup of cleanups) cleanup();
            const index = state.hosts.indexOf(host);
            if (index >= 0) state.hosts.splice(index, 1);
            for (const pending of state.pending.values()) {
                if (pending.owners.has(host)) pending.finish(new Error('Client host disposed; delivery is unknown.'));
            }
        },
    };
    const { socket, hot } = options;
    try {
        if (socket) {
            const onMessage = (event: unknown) => {
                if (!record(event) || typeof event.data !== 'string' || event.data.length > 65536) return;
                try {
                    accept(host, socket, JSON.parse(event.data));
                }
                catch { /* 业务消息或错误 JSON 不进入回执通道. */ }
            };
            const onClose = () => {
                host.socketFailed = true;
                disconnected(host, socket);
            };
            cleanups.push(() => {
                socket.removeEventListener('message', onMessage);
                socket.removeEventListener('close', onClose);
                socket.removeEventListener('error', onClose);
            });
            socket.addEventListener('message', onMessage);
            socket.addEventListener('close', onClose);
            socket.addEventListener('error', onClose);
        }
        if (hot) {
            const onReceipt = (value: unknown) => accept(host, hot, value);
            const onConnect = () => {
                host.hotReady = true;
            };
            const onDisconnect = () => {
                host.hotReady = false;
                disconnected(host, hot);
            };
            cleanups.push(() => {
                hot.off(REPLY, onReceipt);
                hot.off(FILE_REPLY, onReceipt);
                hot.off('vite:ws:connect', onConnect);
                hot.off('vite:ws:disconnect', onDisconnect);
            });
            hot.on(REPLY, onReceipt);
            hot.on(FILE_REPLY, onReceipt);
            hot.on('vite:ws:connect', onConnect);
            hot.on('vite:ws:disconnect', onDisconnect);
        }
    }
    catch (error) {
        host.dispose();
        throw error;
    }
    state.hosts.push(host);
    return () => host.dispose();
}

/**
 * 有界读取 HTTP 回执, 避免代理错误页或异常服务产生无限响应缓冲.
 * @param {Response} response 已完成响应头读取的 HTTP 结果.
 * @param {AbortSignal} signal 回执超时或宿主清理时取消读取的信号.
 */
async function httpReceipt(response: Response, signal: AbortSignal): Promise<Receipt> {
    if (!response.body) throw new Error('Invalid receipt.');
    const reader = response.body.getReader();
    const cancel = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // 回执使用固定上限的自有缓冲区, 不保留任意数量的网络切片及其底层内存.
    const data = new Uint8Array(65536);
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > data.length) {
                await reader.cancel();
                throw new Error('Receipt too large.');
            }
            data.set(value, size);
            size += value.byteLength;
        }
    }
    finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size)));
    if (!validReceipt(value) || (value.ok && !response.ok)) throw new Error('Invalid receipt.');
    return value;
}

/**
 * 按入口策略选择一次发送路径, 所有网络和超时异常拒绝 Promise, 永不自动重试.
 * @param {SendInput} message 完整原文, 结构化分组消息或原始文件.
 * @param {'auto' | 'fetch' | 'socket'} transport 内部选择策略, 限制派发前可用的通道, 不允许失败后切换.
 */
export async function sendMessage(message: SendInput, transport: 'auto' | 'fetch' | 'socket' = 'auto'): Promise<Receipt> {
    const file = clientFile(message);
    let text = '';
    if (file) { /* 文件走独立协议, 不转换为文本或整文件 Base64. */ }
    else if (typeof message === 'string') {
        if (!unicode(message)) throw new TypeError('Invalid Unicode message.');
        text = message;
    }
    else {
        if (!record(message) || (message.group !== undefined && (typeof message.group !== 'string' || !unicode(message.group)))
            || (message.autoNewline !== undefined && typeof message.autoNewline !== 'boolean')) {
            throw new TypeError('Invalid message.');
        }
        const name = textName(message.name);
        const content = contentText(message.content);
        text = JSON.stringify({
            ...(message.group === undefined ? {} : { group: message.group }),
            ...(message.name === undefined ? {} : { name }),
            ...(message.autoNewline === undefined ? {} : { autoNewline: message.autoNewline }),
            content,
        });
    }
    if (state.pending.size >= 128) throw new Error('Too many pending messages.');
    const owners = new Set<Host>();
    const timeoutMs = setting('timeoutMs', owners) ?? (file ? 300000 : 30000);
    const tokenOption = setting('token', owners);
    const token = typeof tokenOption === 'function' ? tokenOption() : tokenOption;
    if (token !== undefined && (typeof token !== 'string' || !unicode(token))) throw new TypeError('Invalid token.');
    const hosts = transport === 'fetch' ? [] : [...state.hosts].reverse();
    const socketHost = hosts.find((host) => host.options.socket?.readyState === 1 && !host.socketFailed);
    const hotHost = socketHost ? undefined : hosts.find((host) => host.options.hot && host.hotReady);
    const host = socketHost ?? hotHost;
    if (transport === 'socket' && !host) throw new Error('No shared socket or HMR channel is available.');
    const channel = socketHost?.options.socket ?? hotHost?.options.hot;
    if (host) owners.add(host);
    const endpoint = host ? undefined : setting('endpoint', owners) ?? '/device-data';
    const request = host ? undefined : setting('request', owners) ?? globalThis.fetch;
    const id = `${state.nonce}_${++state.sequence}`;
    const controller = new AbortController();
    return new Promise<Receipt>((resolve, reject) => {
        let finished = false;
        let sequence = 0;
        let waiter: {
            /** 只接受本次在途阶段的回执, 迟到步骤不会推进状态. */
            seq: number;
            /** 阶段响应仍须由文件状态机验证. @param {unknown} value 未验证阶段回复. */
            resolve(value: unknown): void;
            /** 生命周期取消会结束当前 ACK 等待. @param {Error} error 本次传输错误. */
            reject(error: Error): void;
        } | undefined;
        const pending: Pending = {
            owners,
            ...(host ? { host } : {}),
            ...(channel ? { channel } : {}),
            finish(error, receipt) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                state.pending.delete(id);
                if (error) {
                    controller.abort();
                    waiter?.reject(error);
                    waiter = undefined;
                    reject(error);
                }
                else {
                    resolve(receipt!);
                }
            },
        };
        const timer = setTimeout(() => pending.finish(new Error('Message transfer timed out; delivery is unknown.')), timeoutMs);
        state.pending.set(id, pending);
        const dispatchFile = (payload: Record<string, unknown>, seq: number) => {
            const frame = { ...payload, type: FILE_REQUEST, id, seq, ...(token === undefined ? {} : { token }) };
            if (socketHost) socketHost.options.socket!.send(JSON.stringify(frame));
            else hotHost!.options.hot!.send(FILE_REQUEST, frame);
        };
        if (file && host) {
            pending.acceptFile = (frame) => {
                if (!waiter || frame.seq !== waiter.seq) return;
                const current = waiter;
                waiter = undefined;
                current.resolve(frame.receipt);
            };
            const rpc = (payload: Record<string, unknown>) => new Promise<unknown>((yes, no) => {
                if (finished || controller.signal.aborted) {
                    no(new Error('File transfer cancelled.'));
                    return;
                }
                const seq = sequence++;
                waiter = { seq, resolve: yes, reject: no };
                try {
                    dispatchFile(payload, seq);
                }
                catch (cause) { no(cause); }
            });
            const abort = (uploadId: string) => {
                try {
                    if ((socketHost && (socketHost.socketFailed || socketHost.options.socket!.readyState !== 1))
                        || (hotHost && !hotHost.hotReady)) {
                        return;
                    }
                    dispatchFile({ action: 'abort', uploadId }, sequence++);
                }
                catch { /* 不为清理请求重连或创建新的等待. */ }
            };
            void sendSharedFile(file, rpc, abort, controller.signal).then(
                (receipt) => pending.finish(undefined, receipt),
                (error: unknown) => pending.finish(error instanceof Error ? error : new Error('File transfer failed; delivery is unknown.')),
            );
            return;
        }
        const frame = { type: REQUEST, id, text, ...(token === undefined ? {} : { token }) };
        try {
            if (socketHost) {
                socketHost.options.socket!.send(JSON.stringify(frame));
            }
            else if (hotHost) {
                hotHost.options.hot!.send(REQUEST, frame);
            }
            else {
                if (!request) throw new Error('Fetch is unavailable.');
                const headers = new Headers({ 'Content-Type': file ? 'application/octet-stream' : 'text/plain;charset=UTF-8' });
                if (file) headers.set(FILE_HEADER, fileHeader(file.metadata));
                if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
                void request(endpoint!, {
                    method: 'POST',
                    body: file ? file.blob : text,
                    headers,
                    signal: controller.signal,
                    credentials: 'same-origin',
                    redirect: 'error',
                }).then((response) => httpReceipt(response, controller.signal)).then((receipt) => file ? fileResult(receipt, file) : receipt).then((receipt) => pending.finish(undefined, receipt), (error: unknown) => {
                    pending.finish(error instanceof Error ? error : new Error('HTTP request failed; delivery is unknown.'));
                });
            }
        }
        catch (error) { pending.finish(error instanceof Error ? error : new Error('Send failed; delivery is unknown.')); }
    });
}
