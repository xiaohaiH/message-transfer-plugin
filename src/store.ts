import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReceiptCode, ReceiverError, ReceiverErrorCode } from './errors.js';
import { groupDirectory, localDate, storedFilename } from './filenames.js';
import { textName } from './names.js';
import { isUnicode } from './protocol.js';
import { openText, storageDirectory } from './storage-path.js';
import type { NormalizedMessage, ProcessContent, SuccessReceipt } from './types.js';

/** 存储层只处理目录和正文, 不依赖传输服务或 Vite. */
interface StoreOptions {
    /** 接收器指定的输出目录, 存储实例会将其解析为绝对路径. */
    directory: string;
    /** 处理后正文允许追加的最大 UTF-8 字节数. */
    maxContentBytes: number;
    /** 文本默认自动补 LF, 消息显式配置覆盖此值, 已有 LF 不重复添加. */
    autoNewline?: boolean;
    /** 可选正文转换钩子, 在自动补换行之前执行. */
    processContent?: ProcessContent;
}

/** 每个组有独立串行队列, 写入失败不会污染后续消息. */
export class GroupedStore {
    /** 已解析的绝对保存目录, 所有组文件都限制在该目录下. */
    readonly directory: string;
    /** 按原始组名记录队尾 Promise, 同组串行且不同组可并行. */
    private readonly queues = new Map<string, Promise<void>>();

    /**
     * 创建不依赖网络传输的分组存储实例.
     * @param {StoreOptions} options 保存目录, 正文大小上限以及可选内容转换钩子.
     */
    constructor(private readonly options: StoreOptions) {
        this.directory = resolve(options.directory);
    }

    /** 启动时创建目录并做权限预检查, 实际写入仍需要独立处理磁盘错误. */
    async prepare(): Promise<void> {
        try {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            await access(this.directory, constants.W_OK);
        }
        catch (cause) {
            throw new ReceiverError(ReceiverErrorCode.DIRECTORY_UNAVAILABLE, 'The output directory is not writable.', { cause });
        }
    }

    /**
     * 在入队时确定日期文件名, 避免异步钩子跨午夜后把旧消息写到次日文件.
     * @param {NormalizedMessage} message 已完成协议校验的组名和正文.
     * @param {Date} receivedAt 消息入队时间, 默认取当前本地时间.
     */
    append(message: NormalizedMessage, receivedAt = new Date()): Promise<SuccessReceipt> {
        const { group, content } = message;
        const autoNewline = message.autoNewline ?? this.options.autoNewline ?? true;
        const name = textName(message.name);
        const file = storedFilename(name);
        const location = { date: localDate(receivedAt), groupDirectory: groupDirectory(group), file };
        // 在执行用户钩子前排队, 即使钩子异步也能保持同组的接收顺序.
        const previous = this.queues.get(group) ?? Promise.resolve();
        const result = previous.then(async (): Promise<SuccessReceipt> => {
            let processed: string;
            try {
                processed = this.options.processContent
                    ? await this.options.processContent(content, { group, ...location, receivedAt })
                    : content;
                if (typeof processed !== 'string' || !isUnicode(processed)) {
                    throw new TypeError('processContent must return a valid Unicode string.');
                }
            }
            catch (cause) {
                throw new ReceiverError(ReceiverErrorCode.PROCESSING_FAILED, 'Content processing failed.', { cause });
            }
            if (autoNewline && !processed.endsWith('\n')) processed += '\n';
            const bytes = Buffer.byteLength(processed, 'utf8');
            if (bytes > this.options.maxContentBytes) {
                throw new ReceiverError(ReceiverErrorCode.MESSAGE_TOO_LARGE, 'Processed content exceeds the size limit.');
            }
            await this.write(location, name, processed);
            return { ok: true, code: ReceiptCode.SUCCESS, group, ...location, bytes };
        });
        // 失败结果单独返回调用方, 后续队列始终接在已收敛的 Promise 后面.
        const settled = result.then(
            () => {},
            () => {},
        );
        this.queues.set(group, settled);
        void settled.then(() => {
            if (this.queues.get(group) === settled) this.queues.delete(group);
        });
        return result;
    }

    /** 停止接收新消息后, 等待所有已接收任务完成. */
    async drain(): Promise<void> {
        await Promise.all(this.queues.values());
    }

    /**
     * 仅追加普通且未被链接的文件, 消息不能控制保存目录.
     * @param {Pick<SuccessReceipt, 'date' | 'groupDirectory' | 'file'>} location 入队时确定的安全目录组件及文件名.
     * @param {string} name 独立的逻辑文件名, 用于验证文本归属.
     * @param {string} content 已处理和校验的正文, 使用 UTF-8 原样追加.
     */
    private async write(location: Pick<SuccessReceipt, 'date' | 'groupDirectory' | 'file'>, name: string, content: string): Promise<void> {
        try {
            const directory = await storageDirectory(this.directory, location.date, location.groupDirectory);
            const handle = await openText(directory, location.file, name);
            try {
                await handle.writeFile(content, 'utf8');
            }
            finally {
                await handle.close();
            }
        }
        catch (cause) {
            throw cause instanceof ReceiverError ? cause : new ReceiverError(ReceiverErrorCode.WRITE_FAILED, 'Could not append to the text file.', { cause });
        }
    }
}
