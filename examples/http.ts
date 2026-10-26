import { createReceiver } from '@xiaohaih/message-transfer-plugin';
import {
    closeDemoServer,
    createSenderServer,
    installShutdown,
    listenDemo,
    printDemo,
    readDemoOptions,
} from './demo-utils.js';

/** 普通 Node HTTP 服务提供页面并转交 POST 请求, 同时提供直连 WebSocket 路径. */
async function main(): Promise<void> {
    const options = readDemoOptions('http');
    if (!options) return;
    const server = await createSenderServer({ handleRequest: (request, response) => receiver.handleRequest(request, response) });
    const receiver = createReceiver({
        server,
        ...(options.directory === undefined ? {} : { directory: options.directory }),
        ...(options.token === undefined ? {} : { token: options.token }),
        onError: (error) => console.error(error.code, error.message),
    });
    /** 停止接收器并关闭示例拥有的 HTTP 服务. */
    const stop = async () => {
        // 先关闭本接收器的连接, 再由示例关闭自己拥有的宿主服务.
        await receiver.stop();
        await closeDemoServer(server);
    };
    try {
        await receiver.start();
        const port = await listenDemo(server, options.port, options.host);
        installShutdown(stop);
        printDemo(options, receiver, port);
    }
    catch (/** @type {unknown} */ error) {
        await stop();
        throw error;
    }
}

// 错误不会暴露到页面, 终端保留启动诊断并使用非零退出码.
await main().catch(
    (error: unknown) => {
        console.error('demo:http:', error);
        process.exitCode = 1;
    },
);
