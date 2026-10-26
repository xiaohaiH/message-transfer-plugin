import { createReceiver } from '@xiaohaih/message-transfer-plugin';
import { readFile } from 'node:fs/promises';
import {
    closeDemoServer,
    createSenderServer,
    installShutdown,
    listenDemo,
    printDemo,
    readDemoOptions,
} from './demo-utils.js';

/** 同一 TLS 监听提供页面, HTTPS POST, 业务 WSS 和直连 WSS, 证书由运行示例的宿主提供. */
async function main(): Promise<void> {
    const options = readDemoOptions('https');
    if (!options) return;
    // 参数解析已经要求同时提供证书和私钥, 仅在服务端读取, 不把测试私钥打包为默认凭据.
    const [cert, key] = await Promise.all([readFile(options.cert!), readFile(options.key!)]);
    const server = await createSenderServer({
        tls: { cert, key },
        handleRequest: (request, response) => receiver.handleRequest(request, response),
        sharedReceiver: () => receiver,
    });
    const receiver = createReceiver({
        server,
        ...(options.directory === undefined ? {} : { directory: options.directory }),
        ...(options.token === undefined ? {} : { token: options.token }),
        onError: (error) => console.error(error.code, error.message),
    });
    /** 排空已接受写入后, 由 demo 关闭自己拥有的业务连接和 TLS 服务. */
    const stop = async () => {
        await receiver.stop();
        await closeDemoServer(server);
    };
    try {
        await receiver.start();
        const port = await listenDemo(server, options.port, options.host);
        installShutdown(stop);
        printDemo(options, receiver, port);
    }
    catch (error) {
        await stop();
        throw error;
    }
}

await main().catch((error: unknown) => {
    // 只显示启动异常, 不记录证书或私钥的原始 Buffer.
    console.error('demo:https:', error instanceof Error ? error.message : 'Could not start HTTPS demo.');
    process.exitCode = 1;
});
