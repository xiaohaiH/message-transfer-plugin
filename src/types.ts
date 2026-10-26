import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Http2SecureServer, Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { Server as HttpsServer } from 'node:https';
import type { WebSocket } from 'ws';
import type { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';

/** 手机发送的 JSON 消息. 无法解析为 JSON 的文本会作为默认组的原文保存. */
export interface MessageOption {
    /** 省略或空字符串表示默认组. */
    group?: string;
    /** 独立的完整文本文件名, 省略为 default.txt, 不包含目录. */
    name?: string;
    /** 字符串保持原样, 其他值通过 JSON.stringify 转换; 无法得到有效字符串时拒绝. */
    content: unknown;
    /** 文本是否自动补尾部 LF; 省略继承接收器, 显式 false 关闭, 已有 LF 不重复添加. */
    autoNewline?: boolean;
}

/** 原文件发送选项, 不把文件解析或追加为文本. */
export interface FileOption {
    /** 用户明确提供的 File 或 Blob, SDK 不读取任意本地路径. */
    file: Blob;
    /** 可选分组目录, 省略或空字符串直接保存到日期目录, 不作为文件名前缀. */
    group?: string;
    /** 优先使用此完整文件名; 省略则使用 File.name, 无名 Blob 默认 default.bin. */
    name?: string;
}

/** 三个发送函数共用的单参数输入, File 是 Blob 的子类型. */
export type SendInput = MessageOption | string | Blob | FileOption;

/** 文件会话的有界元数据, 类型和内容均不作为可执行指令. */
export interface FileMetadata {
    /** 安全原始文件名, 不接受目录, 控制字符或无效 Unicode. */
    name: string;
    /** 原始文件总字节数, 包含零字节文件. */
    size: number;
    /** 可选的单层分组目录, 省略或为空时直接使用日期目录. */
    group?: string;
}

/** 文件协议完成验证后的元数据, 默认组已补为空字符串. */
export interface NormalizedFileMetadata extends FileMetadata {
    /** 必填的规范化分组, 覆写输入元数据中的可选字段. */
    group: string;
}

/** 协议校验后的内部消息, 不再包含未定义的分组. */
export interface NormalizedMessage {
    /** 校验后的原始组名, 默认组统一表示为空字符串. */
    group: string;
    /** 已校验的独立完整名称, 缺省补为 default.txt. */
    name: string;
    /** 字符串或 JSON.stringify 转换后的正文, 也可以是 JSON 解析失败后的完整原文. */
    content: string;
    /** 已校验的消息级换行覆盖; 省略仍由接收器决定, 不能提前补为 false. */
    autoNewline?: boolean;
}

/** 保存前处理的上下文, 文件名在入队时按本地日期确定. */
export interface ProcessContext {
    /** 当前消息的规范化组名, 空字符串表示默认组. */
    readonly group: string;
    /** 已确定的安全文件名, 不包含日期或保存目录. */
    readonly file: string;
    /** 入队时固定的本地日期目录, YYYYMMDD. */
    readonly date: string;
    /** 编码后的单层分组目录, 空字符串表示没有分组子目录. */
    readonly groupDirectory: string;
    /** 消息进入写入队列的本地时间, 不随异步处理完成时间改变. */
    readonly receivedAt: Date;
}

/**
 * 内容处理钩子必须最终返回字符串, 抛错只影响当前消息.
 * @param {string} content 已序列化但尚未自动补换行的正文, 默认保持原样.
 * @param {ProcessContext} context 已确定的组名, 文件名和接收时间, 不用于改写保存路径.
 */
export type ProcessContent = (content: string, context: ProcessContext) => string | Promise<string>;

/** 文件追加完成后的回执, 不包含服务端绝对路径. */
export interface SuccessReceipt {
    /** 固定为 true, 供客户端区分成功回执与错误回执. */
    ok: true;
    /** 数字成功码, 与 ReceiptCode.SUCCESS 一致. */
    code: typeof ReceiptCode.SUCCESS;
    /** 入队或开始上传时固定的本地日期目录, YYYYMMDD. */
    date: string;
    /** 实际安全分组目录名, 无分组时为空字符串; 不含路径分隔符. */
    groupDirectory: string;
    /** 本条消息实际使用的组名, 默认组返回空字符串. */
    group: string;
    /** 服务端确定的独立安全 basename, 定位时组合 date/groupDirectory/file. */
    file: string;
    /** 本条文本处理后实际追加的 UTF-8 字节数, 包含自动补入的换行. */
    bytes: number;
}

/** 原始文件完整保存后的确认, 不代表 fsync 或恰好一次投递. */
export interface FileSuccessReceipt extends SuccessReceipt {
    /** 固定标记, 用来区别文件保存与文本追加. */
    kind: 'file';
    /** 实际安全文件名, 优先显式 name 再原名, 重名在扩展名前加 (N), 不含分组前缀. */
    file: string;
    /** 原始文件完整保存的字节数, 不是文本追加量. */
    bytes: number;
    /** 校验后的原始名称, 只供纯文本展示; 定位保存结果应使用 file 字段. */
    originalName: string;
    /** 完整原始字节的 SHA-256 小写十六进制摘要. */
    sha256: string;
}

/** 文件分片确认只是传输进度, 不是最终文件保存成功. */
export interface FileProgressReceipt {
    /** 此协议阶段成功, 文件可能仍未完成. */
    ok: true;
    /** 当前阶段的数字成功码, 仍需等待最终完整保存回执. */
    code: typeof ReceiptCode.SUCCESS;
    /** 服务端随机会话标识, 同时绑定真实请求或握手所有者. */
    uploadId: string;
    /** 已写入临时文件的字节偏移. */
    offset: number;
    /** ready 为开始, chunk 为分片, aborted 为主动清理确认. */
    step: 'ready' | 'chunk' | 'aborted';
    /** ready 阶段告知最大分片字节数, 其他阶段省略. */
    chunkBytes?: number;
}

/** 可安全返回客户端的错误摘要, 原始异常仅在本地诊断回调中提供. */
export interface ErrorReceipt {
    /** 固定为 false, 表示当前消息未得到成功保存确认. */
    ok: false;
    /** 数字失败码, 具体原因通过 error.code 和 error.message 返回. */
    code: typeof ReceiptCode.FAILURE;
    /** 可序列化的错误信息, 不包含 cause 或本地文件路径. */
    error: {
        /** 稳定错误类别, 供客户端决定如何展示或处理. */
        code: ReceiverErrorCode;
        /** 可向远端展示的错误摘要, 不暴露原始异常细节. */
        message: string;
    };
}

/** 成功和错误回执共用 ok 字段进行类型区分. */
export type Receipt =
    /** 文件追加完成后的成功确认. */
    | SuccessReceipt
    /** 原始文件独立完整保存后的成功确认. */
    | FileSuccessReceipt
    /** 当前消息校验, 转换或写入失败的安全摘要. */
    | ErrorReceipt;

/** 启停操作按调用顺序串行执行, 停止后可以重新启动. */
export type ReceiverState =
    /** 尚未启动或已完成停止清理, 可以调用 start. */
    | 'stopped'
    /** 正在准备目录及挂接传输, 暂不接受客户端. */
    | 'starting'
    /** 已完成启动, 可以验证连接和接收消息. */
    | 'running'
    /** 已停止接收新消息, 正在关闭连接和排空已接收任务. */
    | 'stopping';

/** HTTP/2 TLS 服务需要 allowHTTP1: true, 以支持 WebSocket 的 HTTP/1 升级. */
export type HttpService =
    /** 普通 HTTP 服务, 承载明文 WS 握手和升级. */
    | HttpServer
    /** HTTPS 服务, 承载经 TLS 加密的 WSS 连接. */
    | HttpsServer
    /** HTTP/2 TLS 服务, 通过 HTTP/1 兼容接口处理 WebSocket 升级. */
    | Http2SecureServer;

/** HTTP 接收入口支持普通请求及 HTTP/2 兼容请求, 元数据必须来自真实宿主. */
export type HttpRequest =
    /** HTTP/1 请求或原始 WebSocket 握手请求. */
    | IncomingMessage
    /** HTTP/2 请求, 使用 :authority 作为可信目标主机信息. */
    | Http2ServerRequest;

/** 与当前 HTTP 请求对应的响应, 不代表整个宿主或 HTTP/2 会话的所有权. */
export type HttpResponse =
    /** 普通 HTTP/1 响应. */
    | ServerResponse
    /** HTTP/2 兼容响应, 错误时仅结束当前流. */
    | Http2ServerResponse;

/** 完成 WebSocket 握手前返回的 HTTP 拒绝结果. */
export interface UpgradeRejection {
    /** HTTP 状态码: 400 请求错误, 401 鉴权失败, 403 来源拒绝, 503 服务不可用. */
    status: 400 | 401 | 403 | 503;
    /** 服务端生成的 HTTP 状态摘要, 不反射请求中的内容. */
    message: string;
}

/** 共享连接上的应用认证, 显式提供对象后不再读取握手中的其他服务令牌. */
export interface SubmitCredentials {
    /** 本条消息的应用令牌, 省略表示未提供, 不会回退到握手查询参数. */
    token?: string;
}

/** 共享连接的命名空间回执, id 仅用于关联当前连接上的请求, 不代表去重保证. */
export interface SharedReceipt {
    /** 与业务消息隔离的固定回执标记, HMR 中也用作自定义事件名. */
    type: 'message-transfer:receipt';
    /** 原请求的安全 ASCII 标识, 只返回原客户端, 不广播. */
    id: string;
    /** 文件追加完成后的确认或可安全展示的拒绝摘要. */
    receipt: Receipt;
}

/** 独立文件命名空间回执, 仅返回发起请求的共享连接. */
export interface SharedFileReceipt {
    /** 固定文件回执事件, 不与业务帧或文本回执混淆. */
    type: 'message-transfer:file-receipt';
    /** 整次文件发送的客户端关联标识, 不提供重试去重. */
    id: string;
    /** 当前请求步骤序号, 客户端不接受迟到的其他步骤回执. */
    seq: number;
    /** 分片进度, 最终成功或安全失败摘要. */
    receipt: FileProgressReceipt | FileSuccessReceipt | ErrorReceipt;
}

/** 外部 Socket 适配器必须先匹配路径和校验来源, 再接纳连接. */
export interface SocketAdapterContext {
    /** 核心接收路径, 适配器只接管与其精确匹配的升级请求. */
    readonly path: string;
    /** 直连 WS 完整文本/二进制消息字节上限, 应同步传给底层 WebSocket 解析器. */
    readonly maxPayloadBytes: number;
    /**
     * 精确匹配接收路径, 未匹配的请求继续交给宿主处理.
     * @param {IncomingMessage} request 待路由的 HTTP 升级请求, 查询参数不参与匹配.
     */
    matches(request: IncomingMessage): boolean;
    /**
     * 握手前校验, 返回 undefined 表示允许连接.
     * @param {IncomingMessage} request 携带来源和鉴权信息的 HTTP 升级请求.
     */
    verify(request: IncomingMessage): UpgradeRejection | undefined;
    /**
     * 接管已经建立的直连 ws 连接, 接收文本及二进制; 无关路径返回 false.
     * @param {WebSocket} socket 已完成升级并配置了负载上限的 WebSocket 连接.
     * @param {IncomingMessage} request 建立该连接时的原始 HTTP 请求, 用于再次验证来源和鉴权.
     */
    accept(socket: WebSocket, request: IncomingMessage): boolean;
    /**
     * 报告本地传输错误, 不向远端暴露原始异常.
     * @param {unknown} error 适配器捕获的原始传输或资源清理异常.
     */
    onError(error: unknown): void;
}

/** 适配器拥有的路由和监听器, 与调用方拥有的宿主服务分开清理. */
export interface SocketBinding {
    /** 只移除本接收器的资源, 不关闭调用方的 HTTP 或 Socket 服务. */
    dispose(): void | Promise<void>;
}

/** 挂接完成后返回清理句柄, 异步挂接期间尚不接收新消息. */
export interface SocketAdapter {
    /**
     * 把已有传输服务接入核心, 返回本次挂接的资源清理句柄.
     * @param {SocketAdapterContext} context 核心提供的路径, 容量限制以及验证和接纳连接的回调.
     */
    attach(context: SocketAdapterContext): SocketBinding | Promise<SocketBinding>;
}

/** 核心配置与 Vite 无关, 目录和所有连接限制都可以按需调整. */
export interface ReceiverOptions {
    /** 默认保存到当前工作目录下的 received 文件夹. */
    directory?: string;
    /** 接收路径, 默认 /device-data. */
    path?: string;
    /** 仅独立模式使用, 默认 127.0.0.1. */
    host?: string;
    /** 仅独立模式使用, 默认 8787, 0 表示分配空闲端口. */
    port?: number;
    /** 外部 HTTP 服务, 不能与 adapter 或 host/port 同时指定. */
    server?: HttpService;
    /** 外部 Socket 适配器, 生命周期由双方各自管理. */
    adapter?: SocketAdapter;
    /** 文本/直连 WS 完整消息与处理后正文的字节上限, 默认 10 MiB. */
    maxPayloadBytes?: number;
    /** 单个原始文件上限, 默认 100 MiB, 不改变文本消息大小限制. */
    maxFileBytes?: number;
    /** HTTP, 直连 WS 和共享 WS/HMR 合计活动文件会话上限, 默认 4; 直连二进制另占消息队列预算. */
    maxFileTransfers?: number;
    /** 未提交文件的总传输时限, 默认 300000 毫秒, 分片不会无限续期. */
    fileTransferTimeoutMs?: number;
    /** group 的 UTF-8 字节上限, 默认 256. */
    maxGroupBytes?: number;
    /** 所有连接共享的待处理消息数量上限, 默认 128. */
    maxPendingMessages?: number;
    /** 所有待处理消息的原始负载字节上限, 默认 32 MiB. */
    maxPendingBytes?: number;
    /** 本库接管的 WS 连接上限, 默认 32; HTTP 请求另有同值并发限制, 不控制共享宿主连接总数. */
    maxConnections?: number;
    /** 关闭连接的握手超时毫秒数, 默认 1000, 不用于中断处理钩子. */
    shutdownTimeoutMs?: number;
    /** 精确的 HTTP(S) 来源, 省略时只允许相同主机和端口的浏览器来源. */
    allowedOrigins?: readonly string[];
    /** 默认允许没有 Origin 的原生客户端, 不包括 Origin: null 的页面. */
    allowMissingOrigin?: boolean;
    /** 可选应用令牌, HTTP/直连 WS 使用 Bearer 或查询参数, 共享通道使用消息字段, 不可信网络需配合 TLS. */
    token?: string;
    /** 文本默认自动补尾部 LF, 已有 LF 不重复添加; 消息显式配置优先, 不影响原文件. */
    autoNewline?: boolean;
    /** 保存前的异步文本转换, 在自动补换行之前执行, 不允许改写分组或文件路径. */
    processContent?: ProcessContent;
    /**
     * 本地错误诊断, 回调抛错不会中断接收队列.
     * @param {ReceiverError} error 稳定错误码及本地 cause, 不应原样发送给远端客户端.
     */
    onError?: (error: ReceiverError) => void;
}
