import { validUnicode } from './names.js';

/**
 * 字符串保持原样, 其他正文按标准 JSON 规则转换一次, 不隐式丢弃无法序列化的顶层值.
 * @param {unknown} value 调用方提供的任意正文, 不处理独立 File/Blob 上传.
 */
export function contentText(value: unknown): string {
    let text: unknown;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    }
    catch {
        throw new TypeError('content must be a string or a JSON-serializable value.');
    }
    if (typeof text !== 'string' || !validUnicode(text)) {
        throw new TypeError('content must produce a valid Unicode string.');
    }
    return text;
}
