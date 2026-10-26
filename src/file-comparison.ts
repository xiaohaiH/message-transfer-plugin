import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FILE_CHUNK_BYTES } from './file-protocol.js';
import { originalFileProof } from './storage-path.js';

/** 仅普通且无额外硬链接的文件可参与去重. @param {BigIntStats} stat 路径或句柄的当前身份. */
function regular(stat: BigIntStats): boolean {
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
}

/**
 * 比较期间身份和内容元数据必须保持不变, 不以摘要猜测文件归属.
 * @param {BigIntStats} before 比较前的文件状态.
 * @param {BigIntStats} after 比较中的或结束时的文件状态.
 */
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
    return regular(after) && before.dev === after.dev && before.ino === after.ino
        && before.birthtimeNs === after.birthtimeNs && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/**
 * 完整读取单个有界分片, 短读继续, 提前 EOF 不视为相同内容.
 * @param {FileHandle} handle 已验证身份的只读或读写句柄.
 * @param {Buffer} buffer 可复用的固定大小缓冲区.
 * @param {number} length 当前片的有效长度.
 * @param {number} position 当前片在文件中的偏移.
 */
async function readChunk(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<boolean> {
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) return false;
        offset += bytesRead;
    }
    return true;
}

/**
 * 仅比较具有持久原文件证明的占用候选, 两个 64 KiB 缓冲区, 不扫描目录或推断文本归属.
 * @param {FileHandle} source 本次完整上传仍持有的独占临时句柄.
 * @param {string} target 已验证日期/分组目录内的候选路径.
 */
export async function sameFileContents(source: FileHandle, target: string): Promise<boolean> {
    let candidate: FileHandle | undefined;
    try {
        const before = await lstat(target, { bigint: true });
        if (!regular(before)) return false;
        const proof = await originalFileProof(dirname(target), before);
        if (!proof) return false;
        const original = await source.stat({ bigint: true });
        if (!regular(original)) throw new Error('Temporary file must remain non-linked.');
        if (before.size !== original.size) return false;
        // NOFOLLOW 拒绝末级符号链接, NONBLOCK 防止路径被替换成 FIFO 后阻塞打开.
        candidate = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        if (!unchanged(before, await candidate.stat({ bigint: true }))
            || !unchanged(before, await lstat(target, { bigint: true }))) {
            return false;
        }
        const left = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        const right = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        const size = Number(original.size);
        for (let position = 0; position < size; position += FILE_CHUNK_BYTES) {
            const length = Math.min(FILE_CHUNK_BYTES, size - position);
            if (!await readChunk(source, left, length, position) || !await readChunk(candidate, right, length, position)
                || !left.subarray(0, length).equals(right.subarray(0, length))) {
                return false;
            }
        }
        return unchanged(original, await source.stat({ bigint: true }))
            && unchanged(before, await candidate.stat({ bigint: true }))
            && unchanged(before, await lstat(target, { bigint: true }))
            && proof === await originalFileProof(dirname(target), before);
    }
    catch (error) {
        // 候选被并发删除或换成链接不能复用, 其余 I/O 错误仍由上传流程安全报错.
        if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
    }
    finally { await candidate?.close(); }
}
