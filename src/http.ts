import { TextDecoder } from 'node:util';
import { ReceiptCode, ReceiverErrorCode } from './errors.js';
import type { HttpRequest, HttpResponse, Receipt, UpgradeRejection } from './types.js';

/** HTTP 接收上下文, 不负责创建或关闭宿主服务器. */
export interface HttpHandlerContext {
    /** 精确匹配的接收路径, 查询参数不参与比较. */
    path: string;
    /** 单次原始请求体上限, 单位为字节. */
    maxPayloadBytes: number;
    /** 尚未读完的所有上传共用的额外缓冲预算, 单位为字节. */
    maxPendingBytes: number;
    /** 尚未响应完成的 HTTP 请求上限, 与宿主其他路由无关. */
    maxConnections: number;
    /** 宿主关闭等待时间, 不用于取消已经提交的内容处理任务. */
    shutdownTimeoutMs: number;
    /**
     * 读取正文前进行来源和令牌校验.
     * @param {HttpRequest} request 真实的 HTTP 请求, 不使用正文自报元数据.
     */
    authorize(request: HttpRequest): UpgradeRejection | undefined;
    /**
     * 交给所有通道共用的协议和写入队列, 不提前提取 JSON 字段.
     * @param {string} text 完整且无损解码的原始文本, 包括空字符串和 BOM.
     */
    submit(text: string): Promise<Receipt>;
}

/** 一条 HTTP 路由的独立生命周期, 清理不影响宿主其他请求. */
export interface HttpHandler {
    /**
     * 同步声明路由所有权, 正文读取和回执发送在内部完成.
     * @param {HttpRequest} request 待匹配并读取的真实请求.
     * @param {HttpResponse} response 属于该请求的响应对象.
     */
    handle(request: HttpRequest, response: HttpResponse): boolean;
    /** 拒绝仍在读取的请求, 已提交的写入继续完成. */
    dispose(): void;
}

/**
 * 把领域结果转换为 HTTP 状态, 错误正文仍使用统一 Receipt.
 * @param {Receipt} receipt 核心已经生成的成功确认或安全错误摘要.
 */
export function receiptStatus(receipt: Receipt): number {
    if (receipt.ok) return 200;
    switch (receipt.error.code) {
        case ReceiverErrorCode.UNAUTHORIZED: return 401;
        case ReceiverErrorCode.FORBIDDEN: return 403;
        case ReceiverErrorCode.MESSAGE_TOO_LARGE: return 413;
        case ReceiverErrorCode.SERVER_BUSY:
        case ReceiverErrorCode.SHUTTING_DOWN: return 503;
        case ReceiverErrorCode.FILE_NAME_CONFLICT: return 409;
        case ReceiverErrorCode.INVALID_MESSAGE:
        case ReceiverErrorCode.INVALID_NAME:
        case ReceiverErrorCode.INVALID_GROUP: return 400;
        case ReceiverErrorCode.INVALID_CONFIG:
        case ReceiverErrorCode.PROCESSING_FAILED:
        case ReceiverErrorCode.WRITE_FAILED:
        case ReceiverErrorCode.DIRECTORY_UNAVAILABLE:
        case ReceiverErrorCode.START_FAILED:
        case ReceiverErrorCode.TRANSPORT_ERROR:
            return 500;
    }
}

/**
 * 创建有界 HTTP 接收路由, 每次读取最多等待 30 秒, 不限制已接受的存储任务.
 * @param {HttpHandlerContext} context 核心提供的路由, 容量, 鉴权和提交回调.
 */
export function createHttpHandler(context: HttpHandlerContext): HttpHandler {
    const active = new Set<() => void>();
    let bufferedBytes = 0;
    let disposed = false;
    return {
        handle(request, response) {
            if (request.url?.split('?', 1)[0] !== context.path) return false;
            let reading = true;
            let released = false;
            let bytes = 0;
            const chunks: Buffer[] = [];
            let blockUsed = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const detachReader = () => {
                clearTimeout(timer);
                request.off('data', onData);
                request.off('end', onEnd);
                request.off('aborted', release);
                request.off('error', onError);
                bufferedBytes -= bytes;
                bytes = 0;
                chunks.length = 0;
                blockUsed = 0;
            };
            const release = () => {
                if (released) return;
                released = true;
                detachReader();
                response.off('finish', release);
                response.off('close', release);
                active.delete(cancelRead);
            };
            const reply = (receipt: Receipt, status = receiptStatus(receipt)) => {
                if (response.destroyed || response.writableEnded) {
                    release();
                    return;
                }
                if (reading) {
                    // 未读取的请求不能保持复用, 仅结束当前请求的连接, 不销毁宿主服务.
                    if ('stream' in request) {
                        // HTTP/2 禁止 Connection 头, 只关闭当前流, 不影响同一会话里的其他业务请求.
                        response.once('finish', () => request.stream.close());
                    }
                    else {
                        response.setHeader('Connection', 'close');
                    }
                    request.pause();
                }
                response.statusCode = status;
                response.setHeader('Content-Type', 'application/json; charset=utf-8');
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.end(JSON.stringify(receipt));
            };
            const fail = (code: ReceiverErrorCode, message: string, status?: number) => {
                detachReader();
                reply({ ok: false, code: ReceiptCode.FAILURE, error: { code, message } }, status);
            };
            const cancelRead = () => {
                if (reading && !released) fail(ReceiverErrorCode.SHUTTING_DOWN, 'Service Unavailable');
            };
            const onError = () => {
                release();
                response.destroy();
            };
            const onData = (chunk: Buffer) => {
                if (released || !reading) return;
                if (!Buffer.isBuffer(chunk)) {
                    fail(ReceiverErrorCode.INVALID_MESSAGE, 'An unmodified request body is required.');
                    return;
                }
                if (bytes + chunk.length > context.maxPayloadBytes) {
                    fail(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'Message too large.');
                    return;
                }
                if (bufferedBytes + chunk.length > context.maxPendingBytes) {
                    fail(ReceiverErrorCode.SERVER_BUSY, 'Receiver busy.');
                    return;
                }
                // 合并碎片, 避免一字节上传长期保留大量底层 TCP 缓冲区和数组条目.
                let offset = 0;
                while (offset < chunk.length) {
                    let block = chunks.at(-1);
                    if (!block || blockUsed === block.length) {
                        block = Buffer.alloc(Math.min(65536, context.maxPayloadBytes - bytes - offset));
                        chunks.push(block);
                        blockUsed = 0;
                    }
                    const copied = chunk.copy(block, blockUsed, offset);
                    blockUsed += copied;
                    offset += copied;
                }
                bytes += chunk.length;
                bufferedBytes += chunk.length;
            };
            const onEnd = () => {
                if (released || !reading) return;
                let text: string;
                try {
                    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes));
                }
                catch {
                    fail(ReceiverErrorCode.INVALID_MESSAGE, 'Message must be valid UTF-8 text.');
                    return;
                }
                reading = false;
                detachReader();
                // 准入回调同步开始, 防止停机在正文接收和队列入队之间插入新任务.
                try {
                    void context.submit(text).then((receipt) => reply(receipt), () => {
                        fail(ReceiverErrorCode.WRITE_FAILED, 'Could not save the message.');
                    });
                }
                catch {
                    fail(ReceiverErrorCode.WRITE_FAILED, 'Could not save the message.');
                }
            };
            response.once('finish', release);
            response.once('close', release);
            if (request.method !== 'POST') {
                response.setHeader('Allow', 'POST');
                fail(ReceiverErrorCode.INVALID_MESSAGE, 'Method not allowed.', 405);
                return true;
            }
            if (disposed) {
                cancelRead();
                return true;
            }
            let rejection: UpgradeRejection | undefined;
            try {
                rejection = context.authorize(request);
            }
            catch {
                fail(ReceiverErrorCode.SHUTTING_DOWN, 'Service Unavailable');
                return true;
            }
            if (rejection) {
                const code = rejection.status === 401
                    ? ReceiverErrorCode.UNAUTHORIZED
                    : rejection.status === 403 ? ReceiverErrorCode.FORBIDDEN : ReceiverErrorCode.SHUTTING_DOWN;
                fail(code, rejection.status === 401 ? 'Unauthorized' : rejection.status === 403 ? 'Forbidden' : 'Service Unavailable', rejection.status);
                return true;
            }
            if (request.readableEnded || request.readableDidRead || request.readableEncoding !== null) {
                fail(ReceiverErrorCode.INVALID_MESSAGE, 'An unmodified request body is required.');
                return true;
            }
            if (active.size >= context.maxConnections) {
                fail(ReceiverErrorCode.SERVER_BUSY, 'Receiver busy.');
                return true;
            }
            const encoding = request.headers['content-encoding'];
            if (encoding && encoding.toLowerCase() !== 'identity') {
                fail(ReceiverErrorCode.INVALID_MESSAGE, 'Content encoding is not supported.', 415);
                return true;
            }
            const length = Number(request.headers['content-length']);
            if (Number.isFinite(length) && length > context.maxPayloadBytes) {
                fail(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'Message too large.');
                return true;
            }
            active.add(cancelRead);
            timer = setTimeout(fail, 30000, ReceiverErrorCode.INVALID_MESSAGE, 'Request body timed out.', 408);
            timer.unref();
            request.on('data', onData);
            request.once('end', onEnd);
            request.once('aborted', release);
            request.once('error', onError);
            return true;
        },
        dispose() {
            disposed = true;
            for (const cancel of active) cancel();
        },
    };
}
