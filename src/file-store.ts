import { createHash, randomUUID } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedOptions } from './config.js';
import { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';
import { sameFileContents } from './file-comparison.js';
import { FILE_CHUNK_BYTES, fileMetadata } from './file-protocol.js';
import { groupDirectory, localDate, storedFilename } from './filenames.js';
import { directoryIdentity, fileIdentity, markOriginalFile, storageDirectory } from './storage-path.js';
import type { FileProgressReceipt, FileSuccessReceipt, NormalizedFileMetadata } from './types.js';

/** 每次文件发布最多尝试原名及 9999 个编号, 不无限探测已占用名称. */
const NAME_ATTEMPTS = 10000;

/** 进程内跨实例按真实目录身份串行发布, 覆盖 link 到自有临时硬链接清理的窗口. */
const publications = new Map<string, Promise<void>>();

/**
 * 仅完整上传进入队列, 不串行接收分片; 队列随最后一个任务结束释放.
 * @param {string} identity 已验证目录的设备/inode/创建时间身份, 避免路径别名绕过同步.
 * @param {() => Promise<T>} operation 比较, 发布和自有临时资源清理操作.
 */
async function publishSerially<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const previous = publications.get(identity) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    publications.set(identity, current);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (publications.get(identity) === current) publications.delete(identity);
    }
}

/** 活动上传只持有文件句柄和摘要, 不保存整个原始文件或无限待写队列. */
interface Upload {
    /** 随机会话标识, 不与客户端关联编号混用. */
    id: string;
    /** 真实 HTTP 请求或共享握手对象, 不能来自客户端字段. */
    owner: object;
    /** 开始时固定的完整元数据. */
    metadata: NormalizedFileMetadata;
    /** 有声明长度时必须完全匹配; 无长度 HTTP 流以 metadata.size 作为容量上限. */
    exactSize: boolean;
    /** 接收开始的本地日期, 不随上传跨午夜改变. */
    date: string;
    /** 编码后的可选分组目录, 不参与文件名生成. */
    groupDirectory: string;
    /** 本次上传使用的日期/分组目录, 创建后固定. */
    directory?: string;
    /** 上传开始时绑定输出目录身份, 发布和清理不能接受路径替换. */
    directoryIdentity?: string;
    /** 测试或实例创建的独占临时目录, 尚在打开时可能为空. */
    temporary?: string;
    /** 独占临时目录的身份, 发布及清理均拒绝替换后的目录. */
    temporaryIdentity?: string;
    /** 排他打开的文件句柄, 关闭后清空. */
    handle?: FileHandle;
    /** 排他创建的数据文件身份, 关闭句柄后仍用于自有资源清理. */
    fileIdentity?: string;
    /** 已经完整写入的字节数. */
    offset: number;
    /** 增量摘要, 不重新读取或缓存完整文件. */
    hash: Hash;
    /** 同一会话只允许一个操作在途, 不建立无限 Promise 队列. */
    busy: boolean;
    /** 取消立即拒绝后续操作, 等待在途磁盘操作完成再清理. */
    cancelled: boolean;
    /** 完整数据已提交后不因断线撤销, 最终结果可能仍未知. */
    committing: boolean;
    /** 当前磁盘操作, 取消不能在它结束前删除临时文件. */
    task: Promise<unknown>;
    /** 总时限定时器, 分片到达不会刷新. */
    timer?: NodeJS.Timeout;
    /** 幂等清理 Promise, 多个取消来源不能重复关闭句柄. */
    cleanup?: Promise<void>;
}

/** 所有文件通道共用的有界临时文件管理器, 与文本追加队列独立. */
export class FileStore {
    /** 只记录本实例创建的活动会话, 不扫描历史目录或残留文件. */
    private readonly uploads = new Map<string, Upload>();
    /** 已完整接收的有界 WS 消息, 停止时等待保存, 不当作未完成上传取消. */
    private readonly messages = new Set<Promise<FileSuccessReceipt>>();
    /** 停止后不能重新使用此管理器, 接收器重启时创建新实例. */
    private disposed = false;

    /** 创建管理器不触碰文件系统. @param {ResolvedOptions} options 已校验的目录和上传限制. */
    constructor(private readonly options: ResolvedOptions) {}

    /**
     * 在任何异步文件操作前预占会话名额, 验证失败不会创建目录.
     * @param {object} owner 真实宿主请求或握手的所有者.
     * @param {unknown} value 文件名, 分组和声明字节数.
     */
    begin(owner: object, value: unknown): Promise<FileProgressReceipt> {
        return this.create(owner, value, true);
    }

    /**
     * 直接二进制不含分组或名称, 未声明长度的 HTTP 流仍受单文件上限约束.
     * @param {object} owner 真实 HTTP 请求或直连 WS 握手对象.
     * @param {number | undefined} size 声明长度, 省略时在流结束后使用实际字节数.
     */
    beginRaw(owner: object, size?: number): Promise<FileProgressReceipt> {
        return this.create(owner, { name: 'default.bin', size: size ?? this.options.maxFileBytes }, size !== undefined);
    }

    /**
     * 保存 ws 已交付的完整有界消息, 只创建分片视图, 不复制或拼接完整二进制.
     * @param {object} owner 消息所属连接的真实握手对象.
     * @param {readonly Buffer[]} buffers 底层交付的原始字节, 调用完成前不能修改.
     */
    saveMessage(owner: object, buffers: readonly Buffer[]): Promise<FileSuccessReceipt> {
        const task = (async () => {
            const size = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
            const ready = await this.beginRaw(owner, size);
            try {
                let offset = 0;
                for (const buffer of buffers) {
                    for (let start = 0; start < buffer.length; start += FILE_CHUNK_BYTES) {
                        const part = buffer.subarray(start, start + FILE_CHUNK_BYTES);
                        await this.append(owner, ready.uploadId, offset, part);
                        offset += part.length;
                    }
                }
                return await this.finish(owner, ready.uploadId);
            }
            catch (cause) {
                await this.abort(owner, ready.uploadId).catch(() => {});
                throw cause;
            }
        })().finally(() => this.messages.delete(task));
        this.messages.add(task);
        return task;
    }

    /**
     * 共用文件准入和临时资源创建, 原始流不能自行指定宽松校验的元数据.
     * @param {object} owner 真实请求或握手所有者.
     * @param {unknown} value 待验证的完整文件元数据.
     * @param {boolean} exactSize 是否要求最终字节数与声明完全相同.
     */
    private async create(owner: object, value: unknown, exactSize: boolean): Promise<FileProgressReceipt> {
        if (this.disposed) throw new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'Service Unavailable');
        const metadata = fileMetadata(value, this.options.maxFileBytes, this.options.maxGroupBytes);
        if (this.uploads.size >= this.options.maxFileTransfers) throw new ReceiverError(ReceiverErrorCode.SERVER_BUSY, 'Too many file transfers.');
        const upload: Upload = {
            id: randomUUID(),
            owner,
            metadata,
            exactSize,
            date: localDate(new Date()),
            groupDirectory: groupDirectory(metadata.group),
            offset: 0,
            hash: createHash('sha256'),
            busy: false,
            cancelled: false,
            committing: false,
            task: Promise.resolve(),
        };
        this.uploads.set(upload.id, upload);
        upload.timer = setTimeout(() => {
            void this.cancel(upload).catch(() => {});
        }, this.options.fileTransferTimeoutMs);
        upload.timer.unref();
        return this.operate(upload, async () => {
            upload.directory = await storageDirectory(this.options.directory, upload.date, upload.groupDirectory);
            upload.directoryIdentity = await directoryIdentity(upload.directory);
            upload.temporary = await mkdtemp(join(upload.directory, '.message-transfer-upload-'));
            upload.temporaryIdentity = await directoryIdentity(upload.temporary);
            upload.handle = await open(join(upload.temporary, 'data'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
            upload.fileIdentity = fileIdentity(await upload.handle.stat({ bigint: true }));
            return { ok: true, code: ReceiptCode.SUCCESS, step: 'ready', uploadId: upload.id, offset: 0, chunkBytes: FILE_CHUNK_BYTES };
        });
    }

    /**
     * 顺序写入一个有界分片, 不接受乱序, 重复片或声明长度之外的数据.
     * @param {object} owner 真实连接所有者.
     * @param {string} id 服务端创建的会话标识.
     * @param {number} offset 客户端认为的已写入位置.
     * @param {Buffer} data 单片原始字节, 调用完成前不能修改.
     */
    async append(owner: object, id: string, offset: number, data: Buffer): Promise<FileProgressReceipt> {
        const upload = this.get(owner, id);
        return this.operate(upload, async () => {
            if (!Number.isSafeInteger(offset) || offset !== upload.offset || !Buffer.isBuffer(data)
                || !data.length || data.length > FILE_CHUNK_BYTES || upload.offset + data.length > upload.metadata.size) {
                if (!upload.exactSize && Buffer.isBuffer(data) && upload.offset + data.length > upload.metadata.size) {
                    throw new ReceiverError(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'File exceeds the size limit.');
                }
                throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Invalid file chunk or offset.');
            }
            let written = 0;
            while (written < data.length) {
                if (upload.cancelled) throw new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'File transfer cancelled.');
                const result = await upload.handle!.write(data, written, data.length - written);
                if (!result.bytesWritten) throw new Error('File write made no progress.');
                written += result.bytesWritten;
            }
            upload.hash.update(data);
            upload.offset += data.length;
            return { ok: true, code: ReceiptCode.SUCCESS, step: 'chunk', uploadId: upload.id, offset: upload.offset };
        });
    }

    /**
     * 只发布完整文件, 使用排他硬链接而不是会覆盖既有文件的 rename.
     * @param {object} owner 真实连接所有者.
     * @param {string} id 服务端会话标识.
     */
    async finish(owner: object, id: string): Promise<FileSuccessReceipt> {
        const upload = this.get(owner, id);
        return this.operate(upload, async () => {
            if (upload.exactSize && upload.offset !== upload.metadata.size) throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Incomplete file.');
            upload.committing = true;
            clearTimeout(upload.timer);
            const directory = await storageDirectory(this.options.directory, upload.date, upload.groupDirectory, false);
            const identity = await directoryIdentity(directory);
            return publishSerially(identity, async (): Promise<FileSuccessReceipt> => {
                try {
                    const source = join(upload.temporary!, 'data');
                    const validate = async (links = 1n, target?: string) => {
                        await storageDirectory(this.options.directory, upload.date, upload.groupDirectory, false);
                        if (identity !== upload.directoryIdentity || await directoryIdentity(directory) !== identity) throw new Error('Output directory identity changed.');
                        if (await directoryIdentity(upload.temporary!) !== upload.temporaryIdentity) throw new Error('Temporary directory identity changed.');
                        const opened = await upload.handle!.stat({ bigint: true });
                        const current = await lstat(source, { bigint: true });
                        if (!opened.isFile() || opened.nlink !== links || !current.isFile() || current.isSymbolicLink()
                            || current.nlink !== links || fileIdentity(current) !== upload.fileIdentity
                            || fileIdentity(opened) !== upload.fileIdentity || opened.size !== BigInt(upload.offset)) {
                            throw new Error('Output must remain the owned regular file.');
                        }
                        if (target) {
                            const published = await lstat(target, { bigint: true });
                            if (!published.isFile() || published.isSymbolicLink() || published.nlink !== links
                                || fileIdentity(published) !== upload.fileIdentity) {
                                throw new Error('Published file identity changed.');
                            }
                        }
                        return opened;
                    };
                    let file = '';
                    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
                        await validate();
                        file = storedFilename(upload.metadata.name, attempt);
                        const target = join(directory, file);
                        try {
                            await link(source, target);
                        }
                        catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                            if (await sameFileContents(upload.handle!, target)) {
                                await validate();
                                break;
                            }
                            if (attempt === NAME_ATTEMPTS - 1) throw error;
                            continue;
                        }
                        // 仅排他发布的新文件可获得原文件证明, 不能把占用候选或替换后的文本认领为原文件.
                        const published = await validate(2n, target);
                        await markOriginalFile(directory, published);
                        await validate(2n, target);
                        break;
                    }
                    return { ok: true, code: ReceiptCode.SUCCESS, kind: 'file', date: upload.date, groupDirectory: upload.groupDirectory, group: upload.metadata.group, file, bytes: upload.offset, originalName: upload.metadata.name, sha256: upload.hash.digest('hex') };
                }
                finally {
                    // 必须先去掉本上传的临时硬链接再放行其他实例, 不能把短暂 nlink=2 当成不安全候选.
                    await this.remove(upload);
                }
            });
        });
    }

    /** 主动取消只影响指定所有者的会话. @param {object} owner 真实所有者. @param {string} id 服务端会话标识. */
    async abort(owner: object, id: string): Promise<void> {
        await this.cancel(this.get(owner, id));
    }

    /** 解绑或断线时清理该请求拥有的未完成文件. @param {object} owner 真实请求或握手对象. */
    async release(owner: object): Promise<void> {
        await this.cancelUploads([...this.uploads.values()].filter((upload) => upload.owner === owner));
    }

    /** 禁止新上传, 等待完整 WS 消息, 再取消未提交的上传并等待完整文件操作. */
    async dispose(): Promise<void> {
        this.disposed = true;
        await Promise.allSettled([...this.messages]);
        await this.cancelUploads([...this.uploads.values()]);
    }

    /** 等待全部会话收敛后才报告失败, 单个清理错误不能提前结束停止流程. @param {readonly Upload[]} uploads 本次需要取消或排空的会话快照. */
    private async cancelUploads(uploads: readonly Upload[]): Promise<void> {
        const results = await Promise.allSettled(uploads.map((upload) => this.cancel(upload)));
        for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
        }
    }

    /** 找到仍然有效且属于该连接的会话. @param {object} owner 真实所有者. @param {string} id 服务端会话标识. */
    private get(owner: object, id: string): Upload {
        const upload = this.uploads.get(id);
        if (!upload || upload.owner !== owner || upload.cancelled || upload.committing) {
            throw new ReceiverError(ReceiverErrorCode.INVALID_MESSAGE, 'Unknown or inactive file transfer.');
        }
        return upload;
    }

    /**
     * 每个会话仅一个磁盘操作在途, 出错后清理自己拥有的临时资源.
     * @param {Upload} upload 本实例创建的会话.
     * @param {() => Promise<T>} operation 单个有界文件操作.
     */
    private async operate<T>(upload: Upload, operation: () => Promise<T>): Promise<T> {
        if (upload.busy) throw new ReceiverError(ReceiverErrorCode.SERVER_BUSY, 'File transfer is busy.');
        upload.busy = true;
        const task = operation();
        upload.task = task;
        try {
            const value = await task;
            if (upload.cancelled) throw new ReceiverError(ReceiverErrorCode.SHUTTING_DOWN, 'File transfer cancelled.');
            return value;
        }
        catch (cause) {
            upload.cancelled = true;
            await this.remove(upload);
            throw cause instanceof ReceiverError ? cause : new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not save the file.', { cause });
        }
        finally { upload.busy = false; }
    }

    /** 取消标志同步生效, 文件清理等当前操作完成. @param {Upload} upload 本实例创建的会话. */
    private async cancel(upload: Upload): Promise<void> {
        if (!upload.committing) upload.cancelled = true;
        clearTimeout(upload.timer);
        await upload.task.catch(() => {});
        await this.remove(upload);
    }

    /** 幂等清理只涉及本次创建的路径, 不遍历接收目录. @param {Upload} upload 待移除的自有会话. */
    private remove(upload: Upload): Promise<void> {
        upload.cleanup ??= (async () => {
            clearTimeout(upload.timer);
            try {
                await upload.handle?.close();
                delete upload.handle;
                if (upload.temporary) {
                    await storageDirectory(this.options.directory, upload.date, upload.groupDirectory, false);
                    if (await directoryIdentity(upload.directory!) !== upload.directoryIdentity) throw new Error('Output directory identity changed.');
                    if (await directoryIdentity(upload.temporary) !== upload.temporaryIdentity) throw new Error('Temporary directory identity changed.');
                    const source = join(upload.temporary, 'data');
                    const current = await lstat(source, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
                        if (error.code !== 'ENOENT') throw error;
                        return undefined;
                    });
                    if (current) {
                        if (!current.isFile() || current.isSymbolicLink() || fileIdentity(current) !== upload.fileIdentity) {
                            throw new Error('Temporary file identity changed.');
                        }
                        await unlink(source);
                    }
                    await rmdir(upload.temporary);
                }
            }
            finally { this.uploads.delete(upload.id); }
        })().catch((cause: unknown) => {
            const error = new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not clean up the file transfer.', { cause });
            try {
                void Promise.resolve(this.options.onError?.(error)).catch(() => {});
            }
            catch { /* 本地诊断回调不能打断资源释放或产生未处理异常. */ }
            throw error;
        });
        return upload.cleanup;
    }
}
