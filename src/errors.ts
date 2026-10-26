/** 所有回执共用的数字结果码, 具体失败原因仍使用 ReceiverErrorCode. */
export const ReceiptCode = {
    /** 当前协议步骤或完整保存成功. */
    SUCCESS: 0,
    /** 当前请求未得到成功保存确认. */
    FAILURE: 1,
} as const;

/** 数字结果码的字面量联合类型. */
// eslint-disable-next-line ts/no-redeclare -- 值与类型共用名称.
export type ReceiptCode = typeof ReceiptCode[keyof typeof ReceiptCode];

/** 稳定错误码常量, 供内部构造异常和调用方判断失败类别, 不依赖底层异常字符串. */
export const ReceiverErrorCode = {
    /** 配置类型, 数值范围或接入方式组合不合法. */
    INVALID_CONFIG: 'INVALID_CONFIG',
    /** 消息不是支持的文本格式, 或 JSON 中的 content 不合法. */
    INVALID_MESSAGE: 'INVALID_MESSAGE',
    /** group 类型, Unicode 完整性或字节长度不符合协议. */
    INVALID_GROUP: 'INVALID_GROUP',
    /** 独立文件名不合法, 包含路径, 控制字符或超过名称限制. */
    INVALID_NAME: 'INVALID_NAME',
    /** 文本目标名称被原文件或无法确认归属的既有文件占用, 拒绝追加和自动编号. */
    FILE_NAME_CONFLICT: 'FILE_NAME_CONFLICT',
    /** 原始消息或处理后正文超过允许的大小. */
    MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
    /** 应用令牌缺失或不匹配, 不包含 Vite 自身的 HMR 令牌. */
    UNAUTHORIZED: 'UNAUTHORIZED',
    /** 请求来源不符合接收器的 Origin 安全策略. */
    FORBIDDEN: 'FORBIDDEN',
    /** 内容处理钩子抛错, 或返回了不能保存的内容. */
    PROCESSING_FAILED: 'PROCESSING_FAILED',
    /** 文件追加失败, 包括磁盘错误以及不安全的目标文件. */
    WRITE_FAILED: 'WRITE_FAILED',
    /** 输出目录无法创建, 不可写或不是可用目录. */
    DIRECTORY_UNAVAILABLE: 'DIRECTORY_UNAVAILABLE',
    /** 监听端口或适配器挂接失败, 接收器未能启动. */
    START_FAILED: 'START_FAILED',
    /** WebSocket 传输, 回执发送或资源清理失败. */
    TRANSPORT_ERROR: 'TRANSPORT_ERROR',
    /** 请求或消息队列过载, 直连 WS 的消息队列过载通过关闭码 1013 表示. */
    SERVER_BUSY: 'SERVER_BUSY',
    /** 接收器尚未就绪或已停止接收, 直连 WS 停止时使用关闭码 1001. */
    SHUTTING_DOWN: 'SHUTTING_DOWN',
} as const;

/** 从常量值派生的错误码联合类型, 与运行时常量保持同步. */
// eslint-disable-next-line ts/no-redeclare -- 按约定使用同名常量和类型, 分别位于值与类型命名空间.
export type ReceiverErrorCode = typeof ReceiverErrorCode[keyof typeof ReceiverErrorCode];

/** code/message 可返回客户端, cause 只保留在本地用于诊断原始错误. */
export class ReceiverError extends Error {
    /**
     * 创建带稳定业务错误码和可选本地原因的异常.
     * @param {ReceiverErrorCode} code 供调用方识别失败类别的稳定错误码.
     * @param {string} message 不包含令牌或本地路径的安全错误摘要.
     * @param {ErrorOptions} [options] 可选的 Error 配置, cause 保存原始诊断原因.
     */
    constructor(
        public readonly code: ReceiverErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'ReceiverError';
    }
}
