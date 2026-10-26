import { ReceiptCode, ReceiverErrorCode } from './errors.js';
import { FILE_CHUNK_BYTES, fileMetadata, fileRecord, isFileSuccess } from './file-protocol.js';
import type { ErrorReceipt, NormalizedFileMetadata, Receipt } from './types.js';

/** 浏览器只持有用户明确提供的 Blob, 不依赖 Node 或文件路径. */
export interface ClientFile {
    /** 不可变原始文件, 每次只读取一个切片. */
    blob: Blob;
    /** 完整上传期间固定的名称, 分组和大小. */
    metadata: NormalizedFileMetadata;
}

/** 单步请求必须等待原通道 ACK, 不提供重发或切换. @param {Record<string, unknown>} payload 本阶段的有界元数据或分片. */
export type FileRpc = (payload: Record<string, unknown>) => Promise<unknown>;
/** 尽力清理已知会话, 不重发数据也不等待额外回执. @param {string} uploadId 服务端确认过的会话标识. */
export type FileAbort = (uploadId: string) => void;

/** 通过 Blob 内建品牌检查兼容同页及跨 realm 文件. @param {unknown} value 未验证的发送参数. */
function isBlob(value: unknown): value is Blob {
    if (typeof Blob === 'undefined' || value === null || typeof value !== 'object') return false;
    try {
        Blob.prototype.slice.call(value, 0, 0);
        return true;
    }
    catch { return false; }
}

/**
 * 识别独立文件输入; 显式含 content 的消息保持文本语义, 不按正文的类型改选文件通道.
 * @param {unknown} message File, Blob, FileOption 或原有文本输入.
 */
export function clientFile(message: unknown): ClientFile | undefined {
    let blob: Blob;
    let name: unknown;
    let group: unknown;
    if (isBlob(message)) {
        blob = message;
        name = 'name' in message ? message.name : 'default.bin';
    }
    else {
        if (!fileRecord(message) || 'content' in message || !('file' in message)) return undefined;
        if (!isBlob(message.file)) throw new TypeError('Invalid file.');
        blob = message.file;
        name = message.name === undefined ? ('name' in blob ? blob.name : 'default.bin') : message.name;
        group = message.group;
    }
    return { blob, metadata: fileMetadata({ name, size: blob.size, group }, Number.MAX_SAFE_INTEGER, 8192) };
}

/** 只接受稳定的服务端拒绝, 不能把任意对象当作回执. @param {unknown} value 未验证阶段回复. */
function rejection(value: unknown): value is ErrorReceipt {
    return fileRecord(value) && value.ok === false && value.code === ReceiptCode.FAILURE && fileRecord(value.error)
        && typeof value.error.code === 'string' && Object.values<string>(ReceiverErrorCode).includes(value.error.code)
        && typeof value.error.message === 'string';
}

/**
 * 验证最终回执与正在发送的文件匹配, 包含大小和名称, 不把文本回执当文件成功.
 * @param {unknown} value 未验证的最终回执.
 * @param {ClientFile} file 本次明确发送的文件.
 */
export function fileResult(value: unknown, file: ClientFile): Receipt {
    if (rejection(value)) return value;
    if (!isFileSuccess(value) || value.bytes !== file.metadata.size || value.group !== file.metadata.group
        || value.originalName !== file.metadata.name) {
        throw new Error('Invalid file receipt.');
    }
    return value;
}

/** 转换单个有界片段, 不依赖 Node Buffer 或巨大的函数参数展开. @param {Uint8Array} bytes 一个原始分片. */
function base64(bytes: Uint8Array): string {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
}

/** 使用基础取消状态, 不依赖较新的 AbortSignal 方法. @param {AbortSignal} signal 本次传输的取消信号. */
function checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('File transfer cancelled.');
}

/**
 * 只读取当前有界切片, 缺少 Blob.arrayBuffer 时局部使用 FileReader, 不修改全局原型.
 * @param {Blob} blob 最多 64 KiB 的原始文件切片.
 * @param {AbortSignal} signal 本次传输的取消信号, 可中止 FileReader.
 */
function readChunk(blob: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
    checkAbort(signal);
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    if (typeof FileReader === 'undefined') return Promise.reject(new Error('File reading is unavailable.'));
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        const cleanup = () => {
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
            signal.removeEventListener('abort', cancel);
        };
        const fail = (error: unknown) => {
            cleanup();
            reject(error);
        };
        const cancel = () => {
            cleanup();
            try {
                reader.abort();
            }
            finally { reject(new Error('File transfer cancelled.')); }
        };
        reader.onload = () => {
            const result = reader.result;
            cleanup();
            if (result === null || typeof result === 'string') reject(new Error('Could not read the file.'));
            else resolve(result);
        };
        reader.onerror = () => fail(reader.error || new Error('Could not read the file.'));
        reader.onabort = () => fail(new Error('File read cancelled.'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {
            cancel();
            return;
        }
        try {
            reader.readAsArrayBuffer(blob);
        }
        catch (error) { fail(error); }
    });
}

/**
 * 使用固定共享通道传输, 一片一确认, 取消后不再读取或派发数据.
 * @param {ClientFile} file 用户提供的文件及固定元数据.
 * @param {FileRpc} rpc 同一个逻辑请求的顺序阶段请求.
 * @param {FileAbort} abort 尽力取消服务端临时文件, 不涉及关闭连接.
 * @param {AbortSignal} signal 整次上传超时, 断线或宿主清理的取消信号.
 */
export async function sendSharedFile(file: ClientFile, rpc: FileRpc, abort: FileAbort, signal: AbortSignal): Promise<Receipt> {
    let uploadId: string | undefined;
    let completed = false;
    let aborted = false;
    const cancel = () => {
        if (uploadId && !completed && !aborted) {
            aborted = true;
            abort(uploadId);
        }
    };
    // 本地读取可能尚未完成, 已知会话仍须在取消时立即清理, 而非等待 Blob Promise.
    signal.addEventListener('abort', cancel, { once: true });
    try {
        checkAbort(signal);
        const ready = await rpc({ action: 'start', metadata: file.metadata });
        if (rejection(ready)) return ready;
        if (!fileRecord(ready) || ready.ok !== true || ready.code !== ReceiptCode.SUCCESS || ready.step !== 'ready' || ready.offset !== 0
            || typeof ready.uploadId !== 'string' || !/^[\w-]{1,128}$/.test(ready.uploadId)
            || ready.chunkBytes !== FILE_CHUNK_BYTES) {
            throw new Error('Invalid file receipt.');
        }
        uploadId = ready.uploadId;
        for (let offset = 0; offset < file.metadata.size;) {
            checkAbort(signal);
            const bytes = new Uint8Array(await readChunk(file.blob.slice(offset, offset + FILE_CHUNK_BYTES), signal));
            checkAbort(signal);
            if (bytes.length !== Math.min(FILE_CHUNK_BYTES, file.metadata.size - offset)) throw new Error('Could not read the file.');
            const reply = await rpc({ action: 'chunk', uploadId, offset, data: base64(bytes) });
            if (rejection(reply)) return reply;
            if (!fileRecord(reply) || reply.ok !== true || reply.code !== ReceiptCode.SUCCESS || reply.step !== 'chunk' || reply.uploadId !== uploadId
                || reply.offset !== offset + bytes.length) {
                throw new Error('Invalid file receipt.');
            }
            offset += bytes.length;
        }
        checkAbort(signal);
        const receipt = fileResult(await rpc({ action: 'finish', uploadId }), file);
        completed = receipt.ok;
        return receipt;
    }
    finally {
        signal.removeEventListener('abort', cancel);
        cancel();
    }
}
