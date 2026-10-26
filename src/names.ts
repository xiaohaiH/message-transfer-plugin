import { ReceiverError, ReceiverErrorCode } from './errors.js';

/** 验证 Unicode 不含孤立代理项, 同时适用于浏览器和服务端. @param {string} value 原始名称或分组. */
export function validUnicode(value: string): boolean {
    // 按 UTF-16 码元检查配对, 避免旧 Safari 无法解析正则后行断言.
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
        }
        else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            return false;
        }
    }
    return true;
}

/** 编码名称组件中的所有非安全 ASCII 字符. @param {string} value 已校验的 Unicode 名称组件. */
export function encodeFilePart(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 校验完整文件名, 不允许调用者指定路径. @param {unknown} value 未验证的名称. */
export function validateName(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..'
        // eslint-disable-next-line no-control-regex -- 名称不能包含控制字符或路径.
        || /[\\/:\u0000-\u001F\u007F]/u.test(value) || /[. ]$/.test(value) || !validUnicode(value)
        || new TextEncoder().encode(value).length > 255) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_NAME, 'name must be a valid filename without a path, at most 255 UTF-8 bytes.');
    }
    const dot = value.lastIndexOf('.');
    if (dot > 0 && encodeFilePart(value.slice(dot)).length > 48) {
        throw new ReceiverError(ReceiverErrorCode.INVALID_NAME, 'File extension is too long.');
    }
    return value;
}

/** 文本缺省使用 default.txt, 显式名称是完整文件名而不是分组. @param {unknown} value 可省略的文件名. */
export function textName(value: unknown): string {
    return validateName(value === undefined ? 'default.txt' : value);
}

/** 回执中的目录组件或文件名只允许安全 basename. @param {unknown} value 未验证的路径组件. */
function safePart(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 255
        && value !== '.' && value !== '..' && !/[. ]$/.test(value) && validUnicode(value)
        // eslint-disable-next-line no-control-regex -- 回执不得注入路径或不安全文件名.
        && !/[\\/:<>"|?*\u0000-\u001F\u007F]/u.test(value) && new TextEncoder().encode(value).length <= 255;
}

/** 验证回执只提供本地日期和独立安全组件, 不接收绝对路径. @param {Record<string, unknown>} value 未验证的成功回执. */
export function validLocation(value: Record<string, unknown>): boolean {
    return typeof value.date === 'string' && /^\d{8}$/.test(value.date)
        && (value.groupDirectory === '' || safePart(value.groupDirectory)) && safePart(value.file);
}
