import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { encodeFilePart } from './names.js';

/** 本地日历日期独立作为目录名, 不用 UTC 或完成写入的时间. @param {Date} receivedAt 入队或开始上传时的时间. */
export function localDate(receivedAt: Date): string {
    const year = String(receivedAt.getFullYear()).padStart(4, '0');
    const month = String(receivedAt.getMonth() + 1).padStart(2, '0');
    const day = String(receivedAt.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/** 识别跨平台设备别名, 包括带扩展名的别名. @param {string} value 安全编码前后的名称. */
function reservedDevice(value: string): boolean {
    return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/i.test(value);
}

/** 转义首个 ASCII 字符以避让内部或设备命名空间. @param {string} value 已识别的保留名称. */
function escapeFirst(value: string): string {
    return `%${value.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}${value.slice(1)}`;
}

/**
 * 分组仅作为一层目录, 保留常用可读字符, 避免 Windows 大小写及路径别名.
 * @param {string} group 已验证的分组, 空字符串表示直接使用日期目录.
 */
export function groupDirectory(group: string): string {
    const parts = Array.from(group, (character) => {
        if (/^[a-z0-9_\-\u4E00-\u9FFF]$/u.test(character)) return character;
        return Array.from(Buffer.from(character), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    });
    let encoded = parts.join('');
    if (reservedDevice(encoded)) encoded = escapeFirst(encoded);
    if (Buffer.byteLength(encoded) <= 180) return encoded;
    let prefix = '';
    for (const part of parts) {
        if (Buffer.byteLength(prefix + part) > 100) break;
        prefix += part;
    }
    return `${prefix}~${createHash('sha256').update(group).digest('hex')}`;
}

/**
 * 生成独立安全文件名, 文件冲突在扩展名前编号, 不再混入日期或分组.
 * @param {string} name 已校验的完整原名或显式 name.
 * @param {number} index 零表示原名, 正整数表示重名编号.
 */
export function storedFilename(name: string, index = 0): string {
    let safe = name.replace(/[<>"|?*]/g, (character) => encodeFilePart(character));
    if (reservedDevice(safe) || /^\.message-transfer-/i.test(safe)) safe = escapeFirst(safe);
    const extension = extname(safe);
    const stem = safe.slice(0, safe.length - extension.length);
    const suffix = `${index === 0 ? '' : `(${index})`}${extension}`;
    const budget = 255 - Buffer.byteLength(suffix);
    let prefix = '';
    let bytes = 0;
    for (const part of stem.match(/%[\dA-F]{2}|./gsu) ?? []) {
        bytes += Buffer.byteLength(part);
        if (bytes > budget) break;
        prefix += part;
    }
    if (bytes > budget) prefix = prefix.replace(/[. ]+$/, '') || 'file';
    return `${prefix}${suffix}`;
}
