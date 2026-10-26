import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import type { ClientOptions } from 'ws';
import { createReceiver } from '../src/index.js';
import type { Receipt, ReceiverOptions, SuccessReceipt } from '../src/index.js';

/** 每个集成测试使用独立临时目录, 不接触用户已有接收文件. */
export async function tempDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'message-transfer-test-'));
}

/** 从回执的安全位置组件定位测试文件. @param {string} directory 测试拥有的接收根目录. @param {SuccessReceipt} receipt 实际成功回执. */
export function receiptPath(directory: string, receipt: SuccessReceipt): string {
    assert.equal(receipt.code, 0);
    assert.match(receipt.date, /^\d{8}$/);
    assert.equal(typeof receipt.groupDirectory, 'string');
    return join(directory, receipt.date, receipt.groupDirectory, receipt.file);
}

/**
 * 启动真实接收器并注册清理, 返回会自动跟踪客户端的测试接口.
 * @param {TestContext} t 注册连接, 接收器和临时目录清理的测试上下文.
 * @param {Partial<ReceiverOptions>} options 覆盖测试默认接收配置的选项, 用于验证指定边界.
 */
export async function fixture(t: TestContext, options: Partial<ReceiverOptions> = {}) {
    const directory = await tempDirectory();
    const receiver = createReceiver({ directory, port: 0, ...options });
    const sockets: WebSocket[] = [];
    t.after(async () => {
        for (const socket of sockets) socket.terminate();
        await receiver.stop();
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });
    await receiver.start();
    assert.ok(receiver.address && typeof receiver.address !== 'string');
    const url = `ws://127.0.0.1:${receiver.address.port}${options.path ?? '/device-data'}`;
    return {
        receiver,
        directory,
        url,
        async connect(suffix = '', clientOptions?: ClientOptions) {
            const socket = await connect(url + suffix, clientOptions);
            sockets.push(socket);
            return socket;
        },
    };
}

/**
 * 等待实际 open 事件, 握手失败时把异常交给当前测试断言.
 * @param {string} url 待连接的完整 ws 或 wss 地址.
 * @param {ClientOptions | undefined} options 握手请求头, 超时和 TLS 校验等测试选项.
 */
export async function connect(url: string, options?: ClientOptions): Promise<WebSocket> {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, ...options });
    socket.on('error', () => {}); // 具体的等待 Promise 会断言预期错误, 不让事件导致进程崩溃.
    await once(socket, 'open');
    return socket;
}

/**
 * 必须在 send 前注册等待, 避免极快回执造成事件丢失.
 * @param {WebSocket} socket 等待下一条服务端回执的已连接客户端.
 */
export function nextReceipt(socket: WebSocket): Promise<Receipt> {
    return once(socket, 'message').then(
        ([data]) => JSON.parse(String(data)) as Receipt,
    );
}

/**
 * 发送协议对象, 原文回退测试则直接调用 socket.send.
 * @param {WebSocket} socket 发送测试消息并等待回执的客户端连接.
 * @param {unknown} message 要序列化为 JSON 的测试输入, 可以故意不符合协议.
 */
export function send(socket: WebSocket, message: unknown): Promise<Receipt> {
    const receipt = nextReceipt(socket);
    socket.send(JSON.stringify(message));
    return receipt;
}

/**
 * 失败时输出完整回执, 成功后为 TypeScript 收窄类型.
 * @param {Receipt} receipt 期望为成功结果的实际服务端回执.
 */
export function success(receipt: Receipt): SuccessReceipt {
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    return receipt;
}

/**
 * 使用系统分配的空闲端口, 测试不占用用户正在运行的 demo 端口.
 * @param {Server} server 由测试创建且尚未监听的 HTTP 或兼容宿主.
 */
export async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
}

/**
 * 由宿主测试关闭自己的服务, 便于检查核心没有越权关闭外部资源.
 * @param {Server} server 需要由测试主动关闭的宿主, 已停止时直接返回.
 */
export async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>(
        (resolve, reject) =>
            server.close(
                (error) => (error ? reject(error) : resolve()),
            ),
    );
}
