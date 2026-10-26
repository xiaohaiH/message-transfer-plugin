import { sendMessage } from './client-runtime.js';
import type { Receipt, SendInput } from './types.js';

export { ReceiptCode, ReceiverErrorCode } from './errors.js';

/** 自动选择已有业务 WS, HMR 或 HTTP 发送文本或文件. @param {SendInput} message 原文, 结构化消息, File/Blob 或分组文件. */
export function send(message: SendInput): Promise<Receipt> {
    return sendMessage(message);
}

/**
 * 只通过 HTTP(S) 发送一次, 文件流式上传, 不使用 Socket 或 HMR.
 * @param {SendInput} message 原文, 结构化消息, File/Blob 或分组文件.
 */
export function sendByFetch(message: SendInput): Promise<Receipt> {
    return sendMessage(message, 'fetch');
}

/**
 * 只复用已注册的业务 WebSocket 或 Vite HMR, 文件分片确认, 绝不回退 HTTP.
 * @param {SendInput} message 原文, 结构化消息, File/Blob 或分组文件.
 */
export function sendBySocket(message: SendInput): Promise<Receipt> {
    return sendMessage(message, 'socket');
}
