import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { ReceiverError, ReceiverErrorCode } from './errors.js';

/** 只创建一层服务端决定的目录, 既有目录不能是符号链接或 Windows junction. @param {string} directory 当前安全父目录下的一层绝对路径. */
async function ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
    });
    await directoryIdentity(directory);
}

/** 校验普通目录并返回持久身份, 不跟随符号链接或 junction. @param {string} directory 已确定的单层目录路径. */
export async function directoryIdentity(directory: string): Promise<string> {
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output directory must not be a link or file.');
    return fileIdentity(stat);
}

/** 文件或目录的持久身份不依赖逻辑名称, 不把别名猜测当作归属证明. @param {BigIntStats} stat 已读取的文件系统身份. */
export function fileIdentity(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/**
 * 逐级准备日期和可选分组目录, 不从远端接受路径或扫描历史内容.
 * @param {string} root 接收器已准备的根目录.
 * @param {string} date 服务端按本地日历产生的日期目录名.
 * @param {string} group 服务端编码后的单层分组目录, 空字符串表示省略.
 * @param {boolean} create 是否创建尚不存在的目录, 清理和发布时仅校验既有目录.
 */
export async function storageDirectory(root: string, date: string, group: string, create = true): Promise<string> {
    if (!/^\d{8}$/.test(date) || /[\\/]/.test(group) || group === '.' || group === '..') throw new Error('Invalid storage location.');
    const daily = join(root, date);
    if (create) await ensureDirectory(daily);
    else await directoryIdentity(daily);
    if (!group) return daily;
    const directory = join(daily, group);
    if (create) await ensureDirectory(directory);
    else await directoryIdentity(directory);
    return directory;
}

/** 校验文件身份, 硬链接或符号链接均不允许追加. @param {BigIntStats} stat 已打开或待校验的目标文件身份. */
function regular(stat: BigIntStats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Output must be a regular, non-linked file.');
}

/**
 * 原文件标记仅绑定实际文件身份, 与文本的逻辑名称标记完全分离, 不扫描或迁移旧文件.
 * @param {string} directory 已校验的日期/分组目录.
 * @param {BigIntStats} stat 原文件句柄或候选的实际身份.
 */
function originalMarker(directory: string, stat: BigIntStats): string {
    const identity = createHash('sha256').update(`original-file:${fileIdentity(stat)}`).digest('hex');
    return join(directory, '.message-transfer-files', identity);
}

/**
 * 验证原文件的空归属标记并返回本次证明快照, 缺失证明不认领未知候选.
 * @param {string} directory 已校验的日期/分组目录.
 * @param {BigIntStats} stat 候选的实际文件身份, 不使用上传的逻辑名称.
 */
export async function originalFileProof(directory: string, stat: BigIntStats): Promise<string | undefined> {
    const markers = join(directory, '.message-transfer-files');
    try {
        const parent = await directoryIdentity(directory);
        const identity = await directoryIdentity(markers);
        const proof = await lstat(originalMarker(directory, stat), { bigint: true });
        regular(proof);
        if (proof.size !== 0n) throw new Error('Invalid original-file ownership marker.');
        if (await directoryIdentity(directory) !== parent || await directoryIdentity(markers) !== identity) {
            throw new Error('Original-file ownership directory identity changed.');
        }
        // 比较前后连同标记自身身份和修改状态一起验证, 不接受中途替换的空标记.
        return `${parent}/${identity}/${fileIdentity(proof)}/${proof.mtimeNs}/${proof.ctimeNs}`;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/**
 * 只为排他发布的新原文件记录证明, 失败不删除或覆盖既有标记, 也不回滚未知目标.
 * @param {string} directory 已校验且由发布锁保护的日期/分组目录.
 * @param {BigIntStats} stat 仍绑定本次上传句柄的身份, 此时只有临时路径和新目标两个硬链接.
 */
export async function markOriginalFile(directory: string, stat: BigIntStats): Promise<void> {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2n) throw new Error('Invalid newly published original file.');
    const parent = await directoryIdentity(directory);
    const markers = join(directory, '.message-transfer-files');
    await ensureDirectory(markers);
    const identity = await directoryIdentity(markers);
    const marker = originalMarker(directory, stat);
    const handle = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const opened = await handle.stat({ bigint: true });
        const current = await lstat(marker, { bigint: true });
        regular(opened);
        regular(current);
        if (opened.size !== 0n || current.size !== 0n || fileIdentity(opened) !== fileIdentity(current)) {
            throw new Error('Original-file ownership marker identity changed.');
        }
        if (await directoryIdentity(directory) !== parent || await directoryIdentity(markers) !== identity) {
            throw new Error('Original-file ownership directory identity changed.');
        }
    }
    finally { await handle.close(); }
}

/**
 * 只允许追加本库创建且拥有持久身份标记的文本文件. 原文件或未知既有文件始终拒绝.
 * @param {string} directory 已校验的日期/分组目录.
 * @param {string} file 安全的目标 basename.
 * @param {string} name 文本的完整逻辑名称, 防止转义或截短碰撞被误认为同一文本.
 */
export async function openText(directory: string, file: string, name: string): Promise<FileHandle> {
    const target = join(directory, file);
    const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    let created = false;
    let handle: FileHandle;
    try {
        handle = await open(target, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
        created = true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        regular(await lstat(target, { bigint: true }));
        handle = await open(target, flags);
    }
    try {
        const stat = await handle.stat({ bigint: true });
        regular(stat);
        const current = await lstat(target, { bigint: true });
        regular(current);
        if (stat.ino !== current.ino || stat.dev !== current.dev || stat.birthtimeNs !== current.birthtimeNs) {
            throw new Error('Output identity changed.');
        }
        // 空标记绑定名称与文件身份, 重启可验证且不读取文件内容. 用户文件不能占用此命名空间.
        const identity = createHash('sha256').update(JSON.stringify([file, name, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])).digest('hex');
        const markers = join(directory, '.message-transfer-text');
        if (created) {
            await ensureDirectory(markers);
        }
        else {
            const markerDirectory = await lstat(markers).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
                return undefined;
            });
            if (!markerDirectory) throw conflict();
            if (!markerDirectory.isDirectory() || markerDirectory.isSymbolicLink()) throw new Error('Invalid text ownership directory.');
        }
        const marker = join(markers, identity);
        if (created) {
            const proof = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
            await proof.close();
        }
        const proof = await lstat(marker, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
        });
        if (!proof) throw conflict();
        regular(proof);
        if (proof.size !== 0n) throw new Error('Invalid text ownership marker.');
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}

/** 固定冲突原因不包含本地绝对目录或底层异常. */
function conflict(): ReceiverError {
    return new ReceiverError(ReceiverErrorCode.FILE_NAME_CONFLICT, 'The filename is already occupied by a file not owned as text; appending and automatic renaming are refused.');
}
