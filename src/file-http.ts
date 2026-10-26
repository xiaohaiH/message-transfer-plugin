import type { ResolvedOptions } from './config.js';
import { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';
import { FILE_CHUNK_BYTES, FILE_HEADER, fileMetadata } from './file-protocol.js';
import type { FileStore } from './file-store.js';
import { receiptStatus } from './http.js';
import type { HttpHandler } from './http.js';
import type { HttpRequest, HttpResponse, NormalizedFileMetadata, Receipt, UpgradeRejection } from './types.js';

/** 文件路由由宿主显式转交, 不拥有 HTTP 服务或 HTTP/2 会话. */
interface FileHttpContext {
    /** 已解析的精确路径, 上限和总时限. */
    options: ResolvedOptions;
    /** 与共享连接相同的文件会话管理器. */
    files: FileStore;
    /** 读取文件或创建临时目录前验证真实元数据. @param {HttpRequest} request 原始 HTTP 请求. */
    authorize(request: HttpRequest): UpgradeRejection | undefined;
    /** 仅本地报告真实异常原因. @param {ReceiverError} error 安全错误和本地 cause. */
    report(error: ReceiverError): void;
}

/**
 * 以暂停/恢复和逐片磁盘写入提供背压, 不缓存完整文件.
 * @param {FileHttpContext} context 核心持有的配置, 鉴权和文件服务.
 */
export function createFileHttpHandler(context: FileHttpContext): HttpHandler {
    const active = new Set<() => void>();
    let disposed = false;
    return {
        handle(request: HttpRequest, response: HttpResponse) {
            const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
            if (request.url?.split('?', 1)[0] !== context.options.path
                || (request.headers[FILE_HEADER] === undefined && contentType !== 'application/octet-stream')) {
                return false;
            }
            let done = false;
            let ended = false;
            let uploadId: string | undefined;
            let offset = 0;
            let timer: NodeJS.Timeout | undefined;
            let work: Promise<void> = Promise.resolve();
            const releaseFile = () => {
                void context.files.release(request).catch((cause: unknown) => {
                    context.report(new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not clean up the file transfer.', { cause }));
                });
            };
            const detach = () => {
                clearTimeout(timer);
                request.off('data', onData);
                request.off('end', onEnd);
                request.off('aborted', release);
                request.off('error', onError);
            };
            const release = () => {
                done = true;
                detach();
                response.off('finish', release);
                response.off('close', release);
                active.delete(cancel);
                releaseFile();
            };
            const reply = (receipt: Receipt, status = receiptStatus(receipt)) => {
                if (done) return;
                done = true;
                detach();
                if (response.destroyed || response.writableEnded) {
                    release();
                    return;
                }
                if (!ended) {
                    request.pause();
                    if ('stream' in request) response.once('finish', () => request.stream.close());
                    else response.setHeader('Connection', 'close');
                }
                response.statusCode = status;
                response.setHeader('Content-Type', 'application/json; charset=utf-8');
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.end(JSON.stringify(receipt));
            };
            const fail = (cause: unknown, status?: number) => {
                if (done) return;
                const error = cause instanceof ReceiverError ? cause : new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not save the file.', { cause });
                context.report(error);
                releaseFile();
                reply({ ok: false, code: ReceiptCode.FAILURE, error: { code: error.code, message: error.message } }, status);
            };
            const cancel = () => {
                if (!ended) fail(new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'Service Unavailable'));
            };
            const onError = () => {
                release();
                response.destroy();
            };
            const onData = (chunk: Buffer) => {
                request.pause();
                if (done) return;
                if (!Buffer.isBuffer(chunk) || chunk.length > 1024 * 1024) {
                    fail(new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'An unmodified bounded request body is required.'));
                    return;
                }
                work = (async () => {
                    for (let start = 0; start < chunk.length; start += FILE_CHUNK_BYTES) {
                        if (done) return;
                        const part = chunk.subarray(start, start + FILE_CHUNK_BYTES);
                        await context.files.append(request, uploadId!, offset, part);
                        offset += part.length;
                    }
                    if (!done && !ended) request.resume();
                })();
                void work.catch(fail);
            };
            const onEnd = () => {
                ended = true;
                clearTimeout(timer);
                void work.then(async () => {
                    if (!done) reply(await context.files.finish(request, uploadId!));
                }).catch(fail);
            };
            response.once('finish', release);
            response.once('close', release);
            if (request.method !== 'POST') {
                response.setHeader('Allow', 'POST');
                fail(new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Method not allowed.'), 405);
                return true;
            }
            if (disposed) {
                cancel();
                return true;
            }
            try {
                const rejected = context.authorize(request);
                if (rejected) {
                    const code = rejected.status === 401
                        ? ReceiverErrorCode.UNAUTHORIZED
                        : rejected.status === 403 ? ReceiverErrorCode.FORBIDDEN : ReceiverErrorCode.SHUTTING_DOWN;
                    fail(new ReceiverError(code, rejected.message), rejected.status);
                    return true;
                }
                if (request.readableEnded || request.readableDidRead || request.readableEncoding !== null) {
                    throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'An unmodified request body is required.');
                }
                if (active.size >= context.options.maxConnections) {
                    throw new ReceiverError(ReceiverErrorCode.SERVER_BUSY, 'Receiver busy.');
                }
                const encoding = request.headers['content-encoding'];
                if (contentType !== 'application/octet-stream'
                    || (encoding && encoding.toLowerCase() !== 'identity')) {
                    fail(new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'File content type or encoding is not supported.'), 415);
                    return true;
                }
                const header = request.headers[FILE_HEADER];
                let metadata: NormalizedFileMetadata | undefined;
                if (header !== undefined) {
                    let decoded: unknown;
                    try {
                        if (typeof header !== 'string' || header.length > 8192) throw new Error('Invalid header.');
                        decoded = JSON.parse(decodeURIComponent(header));
                    }
                    catch { throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file metadata.'); }
                    metadata = fileMetadata(decoded, context.options.maxFileBytes, context.options.maxGroupBytes);
                }
                const length = request.headers['content-length'];
                if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))
                    || (metadata && Number(length) !== metadata.size))) {
                    throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file length or metadata mismatch.');
                }
                request.pause();
                active.add(cancel);
                request.once('aborted', release);
                request.once('error', onError);
                timer = setTimeout(() => fail(new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'File upload timed out.'), 408), context.options.fileTransferTimeoutMs);
                timer.unref();
                const starting = metadata
                    ? context.files.begin(request, metadata)
                    : context.files.beginRaw(request, length === undefined ? undefined : Number(length));
                void starting.then((ready) => {
                    uploadId = ready.uploadId;
                    if (done) {
                        releaseFile();
                        return;
                    }
                    request.on('data', onData);
                    request.once('end', onEnd);
                    request.resume();
                }).catch(fail);
            }
            catch (cause) { fail(cause); }
            return true;
        },
        dispose() {
            disposed = true;
            for (const cancel of active) cancel();
        },
    };
}
