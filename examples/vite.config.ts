import { messageTransferPlugin } from '@xiaohaih/message-transfer-plugin/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 环境变量只在服务端读取, 不使用会被注入客户端的 VITE_ 前缀.
const token = process.env.MESSAGE_TRANSFER_TOKEN;
const directory = process.env.MESSAGE_TRANSFER_DIRECTORY;

export default defineConfig({
    root: fileURLToPath(new URL('./', import.meta.url)),
    clearScreen: false,
    plugins: [
        messageTransferPlugin({
            // 省略 directory 时统一保存到启动命令所在目录的 received 文件夹.
            ...(directory === undefined ? {} : { directory }),
            ...(token === undefined ? {} : { token }),
        }),
        {
            name: 'message-transfer-demo-entry',
            configureServer(server) {
                // Vite 输出的是根地址, 但示例只有 sender.html. 仅 demo 重定向, 不侵入库插件的宿主路由.
                server.middlewares.use((request, response, next) => {
                    if ((request.method !== 'GET' && request.method !== 'HEAD')
                        || request.url?.split('?', 1)[0] !== server.config.base) {
                        next();
                        return;
                    }
                    response.writeHead(302, {
                        'Location': `${server.config.base}sender.html`,
                        'Cache-Control': 'no-store',
                    });
                    response.end();
                });
            },
        },
    ],
    server: {
        // 演示默认允许手机通过局域网访问, 只应在可信网络运行.
        host: '0.0.0.0',
        port: 5174,
        strictPort: true,
        open: false,
    },
});
