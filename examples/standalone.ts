import { createReceiver } from '@xiaohaih/message-transfer-plugin';
import type { Receiver } from '@xiaohaih/message-transfer-plugin';
import {
    closeDemoServer,
    createSenderServer,
    demoHosts,
    installShutdown,
    listenDemo,
    pageOrigin,
    printDemo,
    readDemoOptions,
} from './demo-utils.js';

/** 独立 WS 接收直接文本和二进制, 页面宿主另提供同源 POST 和业务 WS 复用, 使用精确来源白名单. */
async function main(): Promise<void> {
    const options = readDemoOptions('ws');
    if (!options) return;
    let receiver: Receiver | undefined;
    let websocketPort: number | undefined;
    const pageServer = await createSenderServer({
        wsPort: () => websocketPort,
        handleRequest: (request, response) => receiver?.handleRequest(request, response) ?? false,
        sharedReceiver: () => receiver,
    });
    /** 停止接收器并关闭页面服务. */
    const stop = async () => {
        await receiver?.stop();
        await closeDemoServer(pageServer);
    };
    try {
        const pagePort = await listenDemo(pageServer, options.pagePort, options.host);
        receiver = createReceiver({
            host: options.host,
            port: options.port,
            ...(options.directory === undefined ? {} : { directory: options.directory }),
            ...(options.token === undefined ? {} : { token: options.token }),
            allowedOrigins: demoHosts(options.host).map(
                (host) => pageOrigin(host, pagePort),
            ),
            onError: (error) => console.error(error.code, error.message),
        });
        await receiver.start();
        const address = receiver.address;
        if (!address || typeof address === 'string') throw new Error('Expected a TCP listening address.');
        websocketPort = address.port;
        installShutdown(stop);
        printDemo(options, receiver, pagePort);
    }
    catch (error) {
        await stop();
        throw error;
    }
}

// 示例启动失败时保留明确错误, 不遗留只启动了一半的页面监听.
await main().catch((error: unknown) => {
    console.error('demo:ws:', error);
    process.exitCode = 1;
});
