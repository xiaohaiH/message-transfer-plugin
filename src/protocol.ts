import { contentText } from './content.js';
import { ReceiverError, ReceiverErrorCode } from './errors.js';
import { textName } from './names.js';
import type { NormalizedMessage } from './types.js';

/**
 * 检查 Unicode 完整性, 防止孤立代理字符被 UTF-8 编码替换后产生数据歧义.
 * @param {string} value 待检查的正文或组名, 必须能通过 UTF-8 编解码无损往返.
 */
export function isUnicode(value: string): boolean {
    return Buffer.from(value, 'utf8').toString('utf8') === value;
}

/**
 * 优先解析 JSON 协议, 解析失败时将整条原文交给默认组保存.
 * @param {string} text 收到的完整文本, 回退时不修改空白或换行.
 * @param {number} maxGroupBytes group 的最大 UTF-8 字节数, 默认 256.
 */
export function parseMessage(text: string, maxGroupBytes = 256): NormalizedMessage {
    let value: unknown;
    try {
        value = JSON.parse(text);
    }
    catch {
        // 不 trim 或拼接换行, 保留发送者提供的完整文本.
        return { group: '', name: 'default.txt', content: text };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Expected a message object with content.');
    }
    const message = value as Record<string, unknown>;
    if (message.autoNewline !== undefined && typeof message.autoNewline !== 'boolean') {
        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'autoNewline must be a boolean.');
    }
    let content: string;
    try {
        content = contentText(message.content);
    }
    catch (cause) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'content must be a string or a JSON-serializable value.', { cause });
    }
    const group = message.group === undefined ? '' : message.group;
    if (typeof group !== 'string' || !isUnicode(group) || Buffer.byteLength(group) > maxGroupBytes) {
        throw new ReceiverError(
            ReceiverErrorCode.INVALID_GROUP,
            `group must be a Unicode string of at most ${maxGroupBytes} UTF-8 bytes.`,
        );
    }
    return { group, name: textName(message.name), content, ...(message.autoNewline === undefined ? {} : { autoNewline: message.autoNewline }) };
}
