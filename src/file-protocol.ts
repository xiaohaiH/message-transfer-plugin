import { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';
import { validateName, validLocation, validUnicode } from './names.js';
import type { FileMetadata, FileSuccessReceipt, NormalizedFileMetadata } from './types.js';

/** 共享文件请求独立于共享文本命名空间, 不接收未分流的业务二进制帧. */
export const FILE_REQUEST = 'message-transfer:file-request';
/** 每个阶段只向原始共享连接返回文件回执. */
export const FILE_REPLY = 'message-transfer:file-receipt';
/** 共享通道每个原始分片最多 64 KiB, 不把整个文件编码进 JSON. */
export const FILE_CHUNK_BYTES = 65536;
/** 含 Base64, 元数据和令牌的文件帧最多 96 KiB. */
export const FILE_FRAME_BYTES = 98304;
/** HTTP 文件名, 分组和长度的可选有界元数据头, SDK 总是提供, 不使用 URL 传递文件名. */
export const FILE_HEADER = 'x-message-transfer-file';

/** 检查非空且非数组的对象. @param {unknown} value 待验证的输入. */
export function fileRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 两端都验证元数据, 文件名不能包含路径, 且与文件正文不混合.
 * @param {unknown} value 未验证的文件元数据.
 * @param {number} maxBytes 服务端允许的单文件原始字节数.
 * @param {number} maxGroupBytes 服务端分组的 UTF-8 字节上限.
 */
export function fileMetadata(value: unknown, maxBytes: number, maxGroupBytes: number): NormalizedFileMetadata {
    if (!fileRecord(value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file metadata.');
    }
    const name = validateName(value.name);
    if (value.size > maxBytes) throw new ReceiverError(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'File exceeds the size limit.');
    const group = value.group === undefined ? '' : value.group;
    if (typeof group !== 'string' || group.length > Math.min(maxGroupBytes, 8192) || !validUnicode(group)
        || new TextEncoder().encode(group).length > maxGroupBytes) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_GROUP, 'Invalid file group.');
    }
    const metadata = { name, size: value.size, group };
    fileHeader(metadata);
    return metadata;
}

/**
 * 非 ASCII 名称通过有界百分号编码传入请求头, 不涉及正文或令牌.
 * @param {FileMetadata} metadata 已校验的文件名, 字节数和分组.
 */
export function fileHeader(metadata: FileMetadata): string {
    const header = encodeURIComponent(JSON.stringify(metadata));
    if (header.length > 8192) throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'File metadata too large.');
    return header;
}

/** 验证最终文件成功, 不把分片 ACK 视作保存成功. @param {unknown} value 不可信回执. */
export function isFileSuccess(value: unknown): value is FileSuccessReceipt {
    return fileRecord(value) && value.ok === true && value.code === ReceiptCode.SUCCESS && value.kind === 'file'
        && typeof value.group === 'string' && validUnicode(value.group) && validLocation(value)
        && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
        && typeof value.originalName === 'string' && value.originalName.length > 0 && value.originalName.length <= 255 && validUnicode(value.originalName)
        && typeof value.sha256 === 'string' && /^[a-f\d]{64}$/.test(value.sha256);
}
