import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { resolveOptions } from './config.js';
import type { ResolvedOptions } from './config.js';
import { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';
import { createFileHttpHandler } from './file-http.js';
import { FILE_CHUNK_BYTES, FILE_FRAME_BYTES, FILE_REPLY, FILE_REQUEST } from './file-protocol.js';
import { FileStore } from './file-store.js';
import { createHttpHandler } from './http.js';
import type { HttpHandler } from './http.js';
import { isUnicode, parseMessage } from './protocol.js';
import { GroupedStore } from './store.js';
import { attachHttp, listenStandalone } from './transport.js';
import type {
    ErrorReceipt,
    HttpRequest,
    HttpResponse,
    HttpService,
    Receipt,
    ReceiverOptions,
    ReceiverState,
    SharedFileReceipt,
    SharedReceipt,
    SocketAdapterContext,
    SocketBinding,
    SubmitCredentials,
    UpgradeRejection,
} from './types.js';

/**
 * 把不同长度的令牌转换成固定长度摘要, 再使用常量时间比较.
 * @param {string} value 客户端提交或服务端配置的令牌, 不记录到日志.
 */
function hash(value: string): Buffer {
    return createHash('sha256').update(value).digest();
}

// 同一业务连接上的默认命名空间只能由一个接收器处理, 防止重复追加.
const sharedOwners = new WeakMap<WebSocket, Receiver>();

/** 协调传输, 鉴权, 消息排队和落盘, 不直接依赖 Vite. */
export class Receiver {
    /** 已验证并补齐默认值的实例配置. */
    private readonly options: ResolvedOptions;
    /** 负责分组排队, 内容转换和安全文件追加的存储实例. */
    private readonly store: GroupedStore;
    /** 每次启动独立的有界原文件会话管理器, 不与文本追加混合. */
    private files: FileStore;
    /** 文件 HTTP 路由接收显式二进制类型, 元数据头省略时使用无分组默认名. */
    private fileHttpHandler: HttpHandler | undefined;
    /** 本接收器接管的连接及其关闭状态, 不包含其他宿主连接. */
    private readonly sockets = new Map<
        WebSocket,
        {
            /** 连接真正关闭后完成, stop 用它等待资源释放. */
            closed: Promise<void>;
            /** 关闭握手超时后强制断开的计时器, 正常关闭会清除. */
            timer?: NodeJS.Timeout;
        }
    >();

    /** 仅保存共享连接的解绑函数, 不拥有连接或宿主服务. */
    private readonly sharedSockets = new Map<WebSocket, () => void>();
    /** 启停任务共用的串行队尾, 防止重启与资源清理并发. */
    private lifecycle: Promise<void> = Promise.resolve();
    /** 当前传输挂接的清理句柄, 清理开始时立即摘除. */
    private binding: SocketBinding | undefined;
    /** 当前用于报告监听地址的 HTTP 宿主, 自定义适配器模式为空. */
    private httpServer: HttpService | undefined;
    /** 本次启动拥有的 HTTP 请求读取器, 不挂接外部宿主的 request 事件. */
    private httpHandler: HttpHandler | undefined;
    /** 当前启停阶段, 初始状态表示尚未启动. */
    private currentState: ReceiverState = 'stopped';
    /** 每次启动递增, 用于拒绝旧适配器和旧宿主遗留的回调. */
    private generation = 0;
    /** 已接收但尚未完成保存的消息总数量. */
    private pendingMessages = 0;
    /** 已接收但尚未处理完的原始负载总字节数. */
    private pendingBytes = 0;

    /**
     * 创建配置和存储实例, 不立即监听网络或创建输出目录.
     * @param {ReceiverOptions} options 接入方式, 存储和安全限制, 省略时使用默认配置.
     */
    constructor(options: ReceiverOptions = {}) {
        this.options = resolveOptions(options);
        this.files = new FileStore(this.options);
        this.store = new GroupedStore({
            directory: this.options.directory,
            maxContentBytes: this.options.maxPayloadBytes,
            autoNewline: this.options.autoNewline,
            ...(this.options.processContent ? { processContent: this.options.processContent } : {}),
        });
    }

    /** 暴露启停状态, 不把底层宿主服务的所有权交给调用者. */
    get state(): ReceiverState {
        return this.currentState;
    }

    /** 始终返回实际保存目录, 方便本地日志和调用方定位回执中的文件. */
    get directory(): string {
        return this.store.directory;
    }

    /** 停止或使用自定义适配器时为 null, 外部服务也可能尚未监听. */
    get address(): AddressInfo | string | null {
        return this.currentState === 'running' ? (this.httpServer?.address() ?? null) : null;
    }

    /**
     * 把宿主接收的文本交给同一写入队列, 不接管或关闭宿主连接.
     * @param {string} text 现有 JSON 协议或无法解析为 JSON 的原文, 按 UTF-8 字节限制.
     * @param {HttpRequest} request 宿主提供的真实请求或握手元数据, 不能来自消息自报来源.
     * @param {SubmitCredentials | undefined} credentials 共享通道的消息级应用令牌, 省略对象时读取 HTTP 认证头或查询参数.
     */
    submit(text: string, request: HttpRequest, credentials?: SubmitCredentials): Promise<Receipt> {
        const rejection = this.verify(request, this.generation, false, credentials);
        if (rejection) {
            const code = rejection.status === 401
                ? ReceiverErrorCode.UNAUTHORIZED
                : rejection.status === 403 ? ReceiverErrorCode.FORBIDDEN : ReceiverErrorCode.SHUTTING_DOWN;
            return Promise.resolve(this.errorReceipt(new ReceiverError(code, rejection.message)));
        }
        return this.persistText(text);
    }

    /**
     * 宿主路由中显式转交请求, 未匹配时返回 false, 不覆盖其他业务 HTTP 路由.
     * @param {HttpRequest} request 由宿主转交的真实请求, 默认只匹配 /device-data.
     * @param {HttpResponse} response 当前请求对应的 HTTP 响应, 保存后返回统一回执.
     */
    handleRequest(request: HttpRequest, response: HttpResponse): boolean {
        this.fileHttpHandler ??= createFileHttpHandler({
            options: this.options,
            files: this.files,
            authorize: (incoming) => this.verify(incoming, this.generation, false),
            report: (error) => this.report(error),
        });
        if (this.fileHttpHandler.handle(request, response)) return true;
        this.httpHandler ??= createHttpHandler({
            ...this.options,
            authorize: (incoming) => this.verify(incoming, this.generation, false),
            submit: (text) => this.persistText(text),
        });
        return this.httpHandler.handle(request, response);
    }

    /**
     * 分流已解码的命名空间消息, 非本库消息或无效关联标识不会进入原文回退.
     * @param {unknown} value 宿主解析后的事件负载, 其中的 Origin/Host 字段永不用于鉴权.
     * @param {IncomingMessage} request 对应连接建立时的真实请求, 应由宿主可靠保存.
     */
    async handleSharedMessage(value: unknown, request: IncomingMessage): Promise<SharedReceipt | SharedFileReceipt | undefined> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const message = value as Record<string, unknown>;
        if (message.type === FILE_REQUEST) return this.handleFileMessage(message, request);
        if (message.type !== 'message-transfer:request' || typeof message.id !== 'string'
            || !/^[\w-]{1,128}$/.test(message.id)) {
            return undefined;
        }
        let receipt: Receipt;
        if (typeof message.text !== 'string'
            || (message.token !== undefined && (typeof message.token !== 'string' || Buffer.byteLength(message.token) > 4096))) {
            receipt = this.errorReceipt(new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid message envelope.'));
        }
        else {
            receipt = await this.submit(message.text, request, typeof message.token === 'string' ? { token: message.token } : {});
        }
        return { type: 'message-transfer:receipt', id: message.id, receipt };
    }

    /**
     * 外部 HMR 或业务宿主解绑时通知文件会话清理, 不关闭宿主连接.
     * @param {IncomingMessage} request 对应连接建立时保存的真实握手对象.
     */
    releaseSharedFiles(request: IncomingMessage): Promise<void> {
        return this.files.release(request);
    }

    /**
     * 验证每个文件步骤的真实来源和独立应用令牌, 不接受任意二进制业务帧.
     * @param {Record<string, unknown>} message 文件命名空间中的有界阶段请求.
     * @param {IncomingMessage} request 实际共享连接的握手对象, 也是文件会话所有者.
     */
    private async handleFileMessage(message: Record<string, unknown>, request: IncomingMessage): Promise<SharedFileReceipt | undefined> {
        if (typeof message.id !== 'string' || !/^[\w-]{1,128}$/.test(message.id)
            || typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq) || message.seq < 0) {
            return undefined;
        }
        let receipt: SharedFileReceipt['receipt'];
        let authorized = false;
        try {
            if (message.token !== undefined && (typeof message.token !== 'string' || Buffer.byteLength(message.token) > 4096)) {
                throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file envelope.');
            }
            const rejected = this.verify(request, this.generation, false, typeof message.token === 'string' ? { token: message.token } : {});
            if (rejected) {
                const code = rejected.status === 401
                    ? ReceiverErrorCode.UNAUTHORIZED
                    : rejected.status === 403 ? ReceiverErrorCode.FORBIDDEN : ReceiverErrorCode.SHUTTING_DOWN;
                throw new ReceiverError(code, rejected.message);
            }
            authorized = true;
            if (message.action === 'start') {
                receipt = await this.files.begin(request, message.metadata);
            }
            else {
                if (typeof message.uploadId !== 'string' || !/^[\w-]{1,128}$/.test(message.uploadId)) {
                    throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file transfer identifier.');
                }
                if (message.action === 'chunk') {
                    if (typeof message.data !== 'string' || !message.data.length || message.data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) {
                        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file chunk.');
                    }
                    const bytes = Buffer.from(message.data, 'base64');
                    if (bytes.toString('base64') !== message.data || typeof message.offset !== 'number') {
                        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file chunk.');
                    }
                    receipt = await this.files.append(request, message.uploadId, message.offset, bytes);
                }
                else if (message.action === 'finish') {
                    receipt = await this.files.finish(request, message.uploadId);
                }
                else if (message.action === 'abort') {
                    await this.files.abort(request, message.uploadId);
                    receipt = { ok: true, code: ReceiptCode.SUCCESS, step: 'aborted', uploadId: message.uploadId, offset: 0 };
                }
                else {
                    throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file action.');
                }
            }
        }
        catch (cause) {
            const error = cause instanceof ReceiverError ? cause : new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not save the file.', { cause });
            if (authorized && error.code !== ReceiverErrorCode.SERVER_BUSY && typeof message.uploadId === 'string') {
                await this.files.abort(request, message.uploadId).catch(() => {});
            }
            receipt = this.errorReceipt(error);
        }
        return { type: FILE_REPLY, id: message.id, seq: message.seq, receipt };
    }

    /**
     * 一次性注册宿主已经建立的业务连接, 不覆盖业务处理器, 停止时也不关闭连接.
     * @param {WebSocket} socket 由宿主管理帧级限制, 心跳, 重连及连接数量的已有 ws 连接.
     * @param {IncomingMessage} request 宿主提供的原始握手请求, 不接受客户端自报来源.
     */
    attachSharedSocket(socket: WebSocket, request: IncomingMessage): () => void {
        if (this.currentState !== 'running') throw new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'Receiver is not running.');
        if (sharedOwners.has(socket) || this.sockets.has(socket)) {
            throw new ReceiverError(ReceiverErrorCode.INVALID_CONFIG, 'This Socket is already attached.');
        }
        const generation = this.generation;
        const onMessage = (raw: RawData, binary: boolean) => {
            if (binary || generation !== this.generation || this.currentState !== 'running') return;
            const size = Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.length, 0) : raw.byteLength;
            // JSON 转义最多扩展为六倍, 额外空间仅允许有界的令牌和关联信息.
            if (size > Math.max(this.options.maxPayloadBytes * 6 + 8192, FILE_FRAME_BYTES)) return;
            let value: unknown;
            try {
                const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                value = JSON.parse(data.toString('utf8'));
            }
            catch { return; }
            void this.handleSharedMessage(value, request).then((reply) => {
                if (!reply || generation !== this.generation || socket.readyState !== WebSocket.OPEN
                    || socket.bufferedAmount > this.options.maxPendingBytes || !this.sharedSockets.has(socket)) {
                    return;
                }
                socket.send(JSON.stringify(reply), (cause) => {
                    if (cause) this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'Could not send a shared receipt.', { cause }));
                });
            }).catch((cause: unknown) => {
                this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'Shared Socket transport error.', { cause }));
            });
        };
        const dispose = () => {
            if (this.sharedSockets.get(socket) !== dispose) return;
            socket.off('message', onMessage);
            socket.off('close', dispose);
            this.sharedSockets.delete(socket);
            sharedOwners.delete(socket);
            void this.releaseSharedFiles(request).catch((cause: unknown) => {
                this.report(new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not clean up shared file transfers.', { cause }));
            });
        };
        this.sharedSockets.set(socket, dispose);
        sharedOwners.set(socket, this);
        socket.on('message', onMessage);
        socket.once('close', dispose);
        return dispose;
    }

    /** 串行启动且重复调用安全, 若前一次正在停止则先等待资源清理. */
    start(): Promise<void> {
        return this.enqueue(async () => {
            if (this.currentState === 'running') return;
            this.currentState = 'starting';
            const generation = ++this.generation;
            this.fileHttpHandler?.dispose();
            this.fileHttpHandler = undefined;
            this.files = new FileStore(this.options);
            const context: SocketAdapterContext = {
                path: this.options.path,
                maxPayloadBytes: this.options.maxPayloadBytes,
                matches: (request) => request.url?.split('?', 1)[0] === this.options.path,
                verify: (request) => this.verify(request, generation),
                accept: (socket, request) => {
                    if (!context.matches(request)) return false;
                    this.accept(socket, request, generation);
                    return true;
                },
                onError: (cause) =>
                    this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'WebSocket transport error.', { cause })),
            };
            const onHostClose = () => {
                if (this.generation === generation) {
                    void this.stop().catch(
                        (error: unknown) => context.onError(error),
                    );
                }
            };
            try {
                await this.store.prepare();
                if (this.options.adapter) {
                    this.binding = await this.options.adapter.attach(context);
                    if (!this.binding || typeof this.binding.dispose !== 'function') {
                        this.binding = undefined;
                        throw new Error('adapter.attach() must return a binding with dispose().');
                    }
                }
                else if (this.options.server) {
                    this.httpServer = this.options.server;
                    this.binding = attachHttp(this.httpServer, context, onHostClose);
                }
                else {
                    const transport = await listenStandalone(this.options, context, onHostClose, (request, response) => this.handleRequest(request, response));
                    this.httpServer = transport.server;
                    this.binding = transport.binding;
                }
                this.currentState = 'running';
            }
            catch (cause) {
                await this.cleanup();
                const error =
                    cause instanceof ReceiverError
                        ? cause
                        : new ReceiverError(ReceiverErrorCode.START_FAILED, 'Could not start the message receiver.', { cause });
                this.report(error);
                throw error;
            }
        });
    }

    /** 拒绝新消息, 关闭本接收器拥有的连接, 等待已接收消息完成保存. */
    stop(): Promise<void> {
        return this.enqueue(async () => {
            if (this.currentState === 'stopped') return;
            await this.cleanup();
        });
    }

    /**
     * 生命周期任务失败后仍允许后续 start/stop 执行, 原异常返回当前调用者.
     * @param {() => Promise<void>} operation 需要串行执行的生命周期操作.
     */
    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.lifecycle.then(operation);
        this.lifecycle = result.catch(() => {});
        return result;
    }

    /** 同时摘除路由, 关闭连接和排空写入, 避免适配器清理与连接关闭互相等待. */
    private async cleanup(): Promise<void> {
        this.currentState = 'stopping';
        const binding = this.binding;
        this.binding = undefined;
        this.httpHandler?.dispose();
        this.httpHandler = undefined;
        this.fileHttpHandler?.dispose();
        this.fileHttpHandler = undefined;
        for (const dispose of this.sharedSockets.values()) dispose();
        const closing: Promise<unknown>[] = [Promise.resolve().then(() => binding?.dispose()), this.store.drain(), this.files.dispose()];
        for (const [socket, state] of this.sockets) {
            this.closeSocket(socket, 1001, 'Receiver stopping');
            closing.push(state.closed);
        }
        const results = await Promise.allSettled(closing);
        this.httpServer = undefined;
        this.currentState = 'stopped';
        for (const result of results) {
            if (result.status === 'rejected') {
                this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'Receiver cleanup failed.', { cause: result.reason }));
            }
        }
    }

    /**
     * 握手前验证启动代次, 容量, 来源和令牌, 拒绝尚未就绪或过期的适配器请求.
     * @param {HttpRequest} request 包含 Origin, Host 或 HTTP/2 :authority 以及可选令牌的真实请求.
     * @param {number} generation 发起回调时捕获的启动代次, 必须与当前代次相同.
     * @param {boolean} checkConnections 是否校验本库拥有的 WS 连接数量, 共享通道不占有连接.
     * @param {SubmitCredentials | undefined} credentials 消息级认证信息, 显式对象会覆盖握手中的其他令牌.
     */
    private verify(
        request: HttpRequest,
        generation: number,
        checkConnections = true,
        credentials?: SubmitCredentials,
    ): UpgradeRejection | undefined {
        if (generation !== this.generation || this.currentState !== 'running') {
            return { status: 503, message: 'Service Unavailable' };
        }
        if (checkConnections && this.sockets.size >= this.options.maxConnections) return { status: 503, message: 'Service Unavailable' };
        const origin = request.headers.origin;
        if (!origin) {
            if (!this.options.allowMissingOrigin) return { status: 403, message: 'Forbidden' };
        }
        else {
            let allowed = false;
            try {
                const parsed = new URL(origin);
                const canonical = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin;
                allowed =
                    canonical
                    && (this.options.allowedOrigins
                        ? this.options.allowedOrigins.includes(origin)
                        : parsed.host === (request.headers.host ?? (request.httpVersionMajor === 2 ? request.headers[':authority'] : undefined)));
            }
            catch {
                /* 无效来源和 file 页面的不透明来源都不允许接入. */
            }
            if (!allowed) return { status: 403, message: 'Forbidden' };
        }
        if (this.options.token !== undefined) {
            const header = request.headers.authorization;
            let provided: string | undefined;
            if (credentials !== undefined) {
                provided = credentials.token;
            }
            else if (header !== undefined) {
                if (/^Bearer /i.test(header)) provided = header.slice(7);
            }
            else {
                const tokens = new URL(request.url ?? '/', 'http://localhost').searchParams.getAll('token');
                if (tokens.length === 1) provided = tokens[0];
            }
            if (typeof provided !== 'string' || !timingSafeEqual(hash(provided), hash(this.options.token))) {
                return { status: 401, message: 'Unauthorized' };
            }
        }
        return undefined;
    }

    /**
     * 核心再次验证连接, 避免自定义适配器漏掉握手校验时绕过鉴权.
     * @param {WebSocket} socket 已建立且即将由核心管理的连接.
     * @param {IncomingMessage} request 用于补查路径和安全策略的原始升级请求.
     * @param {number} generation 适配器所属的启动代次, 防止旧回调接入新服务.
     */
    private accept(socket: WebSocket, request: IncomingMessage, generation: number): void {
        if (this.sockets.has(socket)) return;
        const rejection = this.verify(request, generation);
        let resolveClosed!: () => void;
        const state: {
            /** 关闭事件触发后完成的 Promise, 生命周期清理会等待它. */
            closed: Promise<void>;
            /** 可选的强制断开计时器, 正常关闭后清除. */
            timer?: NodeJS.Timeout;
        } = {
            closed: new Promise<void>(
                (resolve) => {
                    resolveClosed = resolve;
                },
            ),
        };
        this.sockets.set(socket, state);
        const onMessage = (data: RawData, isBinary: boolean) => this.receive(socket, request, data, isBinary);
        const onError = (cause: Error) =>
            this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'WebSocket connection error.', { cause }));
        socket.on('error', onError);
        socket.once('close', () => {
            clearTimeout(state.timer);
            this.sockets.delete(socket);
            socket.off('message', onMessage);
            socket.off('error', onError);
            resolveClosed();
        });
        if (rejection) {
            this.closeSocket(socket, rejection.status === 503 ? 1013 : 1008, rejection.message);
            return;
        }
        socket.on('message', onMessage);
    }

    /**
     * 直连入口先限制完整消息大小和队列, 文本追加, 二进制作为无分组文件保存.
     * @param {WebSocket} socket 发来当前消息的连接, 同时用作回执返回通道.
     * @param {IncomingMessage} request 已验证的真实握手, 绑定二进制临时资源.
     * @param {RawData} raw 底层解析器提供的完整原始负载, 在解码前计入容量限制.
     * @param {boolean} isBinary 是否为二进制消息, true 时保留原始字节且不解析文本.
     */
    private receive(socket: WebSocket, request: IncomingMessage, raw: RawData, isBinary: boolean): void {
        if (this.currentState !== 'running' || socket.readyState !== WebSocket.OPEN) return;
        const size = Array.isArray(raw)
            ? raw.reduce(
                    (sum, part) => sum + part.length,
                    0,
                )
            : raw.byteLength;
        if (size > this.options.maxPayloadBytes) {
            this.closeSocket(socket, 1009, 'Message too large');
            return;
        }
        if (
            this.pendingMessages >= this.options.maxPendingMessages
            || this.pendingBytes + size > this.options.maxPendingBytes
        ) {
            this.closeSocket(socket, 1013, 'Receiver busy');
            return;
        }
        if (isBinary) {
            this.pendingMessages++;
            this.pendingBytes += size;
            const buffers = Array.isArray(raw) ? raw : [Buffer.isBuffer(raw) ? raw : Buffer.from(raw)];
            void this.files.saveMessage(request, buffers).then(
                (receipt) => this.reply(socket, receipt),
                (cause: unknown) => this.replyError(socket, cause instanceof ReceiverError
                    ? cause
                    : new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not save the file.', { cause })),
            ).finally(() => {
                this.pendingMessages--;
                this.pendingBytes -= size;
            });
            return;
        }
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        void this.persistText(data.toString('utf8')).then((receipt) => this.reply(socket, receipt));
    }

    /**
     * 所有通道在这里同步完成准入及入队, 先固定文件日期再等待异步处理.
     * @param {string} text 完整原始文本, 不 trim, 不自动追加换行.
     */
    private persistText(text: string): Promise<Receipt> {
        let message;
        let size;
        try {
            if (this.currentState !== 'running') {
                throw new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'Service Unavailable');
            }
            if (typeof text !== 'string') {
                throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Message must be valid Unicode text.');
            }
            size = Buffer.byteLength(text, 'utf8');
            if (size > this.options.maxPayloadBytes) {
                throw new ReceiverError(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'Message too large.');
            }
            if (this.pendingMessages >= this.options.maxPendingMessages || this.pendingBytes + size > this.options.maxPendingBytes) {
                throw new ReceiverError(ReceiverErrorCode.SERVER_BUSY, 'Receiver busy.');
            }
            if (!isUnicode(text)) throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Message must be valid Unicode text.');
            message = parseMessage(text, this.options.maxGroupBytes);
        }
        catch (error) {
            return Promise.resolve(this.errorReceipt(error as ReceiverError));
        }
        this.pendingMessages++;
        this.pendingBytes += size;
        return this.store.append(message)
            .then((receipt) => receipt, (error: ReceiverError) => this.errorReceipt(error))
            .finally(() => {
                this.pendingMessages--;
                this.pendingBytes -= size;
            });
    }

    /**
     * 本地保留原始原因, 客户端只收到可以安全展示的错误摘要.
     * @param {WebSocket} socket 收到失败消息的客户端连接.
     * @param {ReceiverError} error 带稳定错误码的校验, 处理或写入异常.
     */
    private replyError(socket: WebSocket, error: ReceiverError): void {
        this.reply(socket, this.errorReceipt(error));
    }

    /**
     * 在本地报告原因并生成可跨通道传输的安全回执.
     * @param {ReceiverError} error 已经移除远端敏感信息的领域错误, cause 仅保留在本地.
     */
    private errorReceipt(error: ReceiverError): ErrorReceipt {
        this.report(error);
        return { ok: false, code: ReceiptCode.FAILURE, error: { code: error.code, message: error.message } };
    }

    /**
     * 不向已断开的连接发送数据, 慢客户端积压过多时主动断开.
     * @param {WebSocket} socket 接收回执的客户端连接, 发送前再次检查状态与积压.
     * @param {Receipt} receipt 已完成业务处理的成功回执或安全错误摘要.
     */
    private reply(socket: WebSocket, receipt: Receipt): void {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > this.options.maxPendingBytes) {
            this.closeSocket(socket, 1013, 'Receiver busy');
            return;
        }
        socket.send(
            JSON.stringify(receipt),
            (cause) => {
                if (cause) this.report(new ReceiverError(ReceiverErrorCode.TRANSPORT_ERROR, 'Could not send a receipt.', { cause }));
            },
        );
    }

    /**
     * 先尝试标准关闭握手, 超时后强制释放连接, 不影响已接收文件任务.
     * @param {WebSocket} socket 需要关闭的已接管连接.
     * @param {number} code 发给客户端的 WebSocket 关闭状态码.
     * @param {string} reason 服务端生成的简短关闭原因, 不包含用户输入.
     */
    private closeSocket(socket: WebSocket, code: number, reason: string): void {
        const state = this.sockets.get(socket);
        if (!state || socket.readyState === WebSocket.CLOSED) return;
        socket.close(code, reason);
        if (!state.timer) {
            state.timer = setTimeout(() => socket.terminate(), this.options.shutdownTimeoutMs);
            state.timer.unref();
        }
    }

    /**
     * 隔离错误观察回调自身的异常, 避免破坏队列或产生未处理拒绝.
     * @param {ReceiverError} error 需要交给本地 onError 观察者的接收器异常.
     */
    private report(error: ReceiverError): void {
        // 错误观察回调不能破坏消息队列, 同步异常和异步拒绝都在这里隔离.
        try {
            void Promise.resolve(this.options.onError?.(error)).catch(() => {});
        }
        catch {
            /* 忽略诊断回调自身的异常, 不递归调用 onError. */
        }
    }
}

/**
 * 创建接收器但不立即监听, 省略配置时使用默认目录和监听地址.
 * @param {ReceiverOptions} options 接入, 存储和安全选项, 省略时使用核心默认值.
 */
export function createReceiver(options: ReceiverOptions = {}): Receiver {
    return new Receiver(options);
}
