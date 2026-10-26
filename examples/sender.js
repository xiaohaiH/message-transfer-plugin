import { send, sendByFetch, sendBySocket } from '@xiaohaih/message-transfer-plugin/client';
import { installClient } from '@xiaohaih/message-transfer-plugin/client-host';
import { createDemoSocket } from './sender-host.js';

// 页面测试公开发送方法, 连接生命周期由独立 demo 宿主管理, 不改变 SDK 的通道策略.
const element = (id) => document.getElementById(id);
const token = element('token');
const sendButton = element('send');
const method = element('method');
const format = element('format');
const group = element('group');
const filename = element('name');
const status = element('status');
const receipts = element('receipts');
const supported = ['http:', 'https:'].includes(location.protocol);
const hot = import.meta.hot;
const methods = new Map([['send', send], ['sendByFetch', sendByFetch], ['sendBySocket', sendBySocket]]);
const disposeToken = installClient({ token: () => token.value || undefined });
let demoSocket;
let waiting = false;
let disposed = false;
let history = [];

/** 阻止重复提交, 卸载后的迟到回执不会重新启用页面. */
function update() {
    const selected = format.querySelector('input[name="format"]:checked');
    const selectedFormat = selected && selected.value;
    sendButton.disabled = !supported || waiting || disposed;
    token.disabled = waiting || disposed;
    method.disabled = waiting || disposed;
    format.disabled = waiting || disposed;
    group.disabled = selectedFormat === 'raw' || waiting || disposed;
    filename.disabled = selectedFormat === 'raw' || waiting || disposed;
    element('content-label').hidden = selectedFormat === 'file';
    element('content').disabled = selectedFormat === 'file' || waiting || disposed;
    element('file-controls').hidden = selectedFormat !== 'file';
    element('file').disabled = selectedFormat !== 'file' || waiting || disposed;
    element('connect').disabled = disposed;
    element('disconnect').disabled = disposed;
}

const socketControls = element('socket-controls');
if (document.body.dataset.businessSocket === 'true' && supported) {
    socketControls.hidden = false;
    demoSocket = createDemoSocket((text) => {
        element('connection-status').textContent = text;
    });
}
else {
    element('connection-status').textContent = hot
        ? '业务连接未启用; Vite 插件自动提供 HMR, sendBySocket 可复用 HMR.'
        : '没有业务 WebSocket/HMR, sendBySocket 将报错且不会回退 HTTP.';
}
element('connect').addEventListener('click', () => {
    if (demoSocket) demoSocket.connect();
});
element('disconnect').addEventListener('click', () => {
    if (demoSocket) demoSocket.disconnect();
});
status.textContent = supported
    ? '已就绪, 请选择要测试的发送函数.'
    : '不能直接打开 file 页面. 请运行 pnpm demo:http / demo:ws / demo:https / demo:vite, 再访问终端中的 Page 地址.';
format.addEventListener('change', update);
element('message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!supported || waiting || disposed) return;
    const content = element('content').value;
    const selectedRadio = format.querySelector('input[name="format"]:checked');
    const selectedFormat = selectedRadio && selectedRadio.value;
    const isFile = selectedFormat === 'file';
    const files = element('file').files;
    const file = files && files[0];
    if (isFile && !file) {
        status.textContent = '请先选择要发送的文件, 未发送.';
        return;
    }
    // 原文保持全部空白和换行, 文件不转成文本或整文件 Base64.
    const options = { group: group.value, ...(filename.value === '' ? {} : { name: filename.value }) };
    const message = isFile ? { ...options, file } : selectedFormat === 'raw' ? content : { ...options, content };
    const name = method.value;
    const selected = methods.get(name);
    if (!selected) {
        status.textContent = '无效的发送函数, 未发送.';
        return;
    }
    waiting = true;
    status.textContent = `${name}: 等待保存回执...`;
    update();
    void selected(message).then((reply) => {
        if (disposed) return;
        const relativePath = reply.ok ? [reply.date, reply.groupDirectory, reply.file].filter(Boolean).join('/') : '';
        const text = reply.ok
            ? reply.kind === 'file'
                ? `已保存文件: ${relativePath}, 共 ${reply.bytes} 字节. 原名: ${reply.originalName}. SHA-256: ${reply.sha256}. 所在目录请查看终端 Directory.`
                : `已保存: ${relativePath}, 本次追加 ${reply.bytes} 字节. 所在目录请查看终端 Directory.`
            : `接收失败: code: ${reply.code}, ${reply.error.code}: ${reply.error.message}`;
        status.textContent = `${name}: ${text}`;
        history.push(`${name}: ${text}\n${JSON.stringify(reply)}`);
        history = history.slice(-30);
        // 回执只按纯文本显示, 不解析业务输入为 HTML, 也不声称自动模式已经使用某个具体通道.
        receipts.textContent = history.join('\n');
    }, (error) => {
        if (disposed) return;
        status.textContent = error && error.message === 'No shared socket or HMR channel is available.'
            ? `${name}: 未发送, 没有可用的业务 WebSocket/HMR, 不会回退到 HTTP. 请先连接或检查 HMR.`
            : `${name}: 发送未确认, ${isFile ? '文件' : '消息'}可能已保存, 不会自动重发. 请检查终端地址, Origin, 令牌, 证书和网络.`;
    }).finally(() => {
        waiting = false;
        update();
    });
});

/** 卸载时只清理页面注册和 demo 自己的连接, 不关闭 Vite HMR. */
function dispose() {
    if (disposed) return;
    disposed = true;
    disposeToken();
    if (demoSocket) demoSocket.dispose();
    window.removeEventListener('pagehide', dispose);
    status.textContent = '页面已卸载, 请刷新后重新测试.';
    update();
}
window.addEventListener('pagehide', dispose);
if (hot) hot.dispose(dispose);
update();
