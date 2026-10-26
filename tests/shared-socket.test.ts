import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { installClient } from '../src/client-host.js';
import * as sdk from '../src/client.js';
import { send as clientSend } from '../src/client.js';
import { closeServer, connect, fixture, listen, receiptPath } from './helpers.js';

const requestType = 'message-transfer:request';
const receiptType = 'message-transfer:receipt';

test('an existing business WebSocket keeps its protocol, receives correlated replies and is never closed by receiver', async (t) => {
    const { receiver, directory } = await fixture(t);
    assert.equal(typeof Reflect.get(receiver, 'attachSharedSocket'), 'function');
    const host = createServer();
    const ws = new WebSocketServer({ server: host });
    let peer!: WebSocket;
    let detach!: () => void;
    ws.on('connection', (socket, request) => {
        peer = socket;
        socket.on('message', (data) => {
            if (data.toString() === 'business-ping') socket.send('business-pong');
        });
        detach = receiver.attachSharedSocket(socket, request);
    });
    const port = await listen(host);
    const client = await connect(`ws://127.0.0.1:${port}/business`);
    t.after(async () => {
        client.terminate();
        peer.terminate();
        ws.close();
        await closeServer(host);
    });
    let next = once(client, 'message');
    client.send('business-ping');
    assert.equal(String((await next)[0]), 'business-pong');
    assert.deepEqual(await readdir(directory), []);
    next = once(client, 'message');
    client.send(JSON.stringify({ type: requestType, id: 'a', text: '{"group":"reuse","content":"stored"}' }));
    const reply = JSON.parse(String((await next)[0]));
    assert.equal(reply.type, receiptType);
    assert.equal(reply.id, 'a');
    assert.equal(reply.receipt.ok, true);
    assert.equal(await readFile(receiptPath(directory, reply.receipt), 'utf8'), 'stored\n');
    const disposeClient = installClient({ socket: client });
    try {
        const viaSdk = await clientSend({ group: 'reuse', content: ' + SDK' });
        assert.equal(viaSdk.ok, true);
        assert.equal(ws.clients.size, 1);
        assert.equal(await readFile(receiptPath(directory, reply.receipt), 'utf8'), 'stored\n + SDK\n');
        assert.equal(typeof sdk.sendBySocket, 'function');
        assert.equal((await sdk.sendBySocket({ group: 'reuse', content: ' + socket' })).ok, true);
        assert.equal(ws.clients.size, 1);
        assert.equal(await readFile(receiptPath(directory, reply.receipt), 'utf8'), 'stored\n + SDK\n + socket\n');
    }
    finally { disposeClient(); }
    detach();
    detach();
    assert.equal(peer.listenerCount('message'), 1);
    receiver.attachSharedSocket(peer, { headers: {}, url: '/business' } as never);
    await receiver.stop();
    assert.equal(peer.readyState, WebSocket.OPEN);
    assert.equal(peer.listenerCount('message'), 1);
    next = once(client, 'message');
    client.send('business-ping');
    assert.equal(String((await next)[0]), 'business-pong');
    assert.equal(host.listening, true);
});

test('shared messages enforce namespace, IDs, application credentials, origin and limits', async (t) => {
    const { receiver, directory } = await fixture(t, { token: 'secret', allowMissingOrigin: false, maxPayloadBytes: 8 });
    assert.equal(typeof Reflect.get(receiver, 'handleSharedMessage'), 'function');
    const host = createServer();
    const ws = new WebSocketServer({ server: host });
    const peers: WebSocket[] = [];
    ws.on('connection', (socket, request) => {
        peers.push(socket);
        receiver.attachSharedSocket(socket, request);
    });
    const port = await listen(host);
    const client = await connect(`ws://127.0.0.1:${port}/business?token=secret`, { origin: `http://127.0.0.1:${port}` });
    t.after(async () => {
        client.terminate();
        for (const peer of peers) peer.terminate();
        ws.close();
        await closeServer(host);
    });
    for (const [text, token, code] of [['hello', undefined, 'UNAUTHORIZED'], ['123456789', 'secret', 'MESSAGE_TOO_LARGE']] as const) {
        const next = once(client, 'message');
        client.send(JSON.stringify({ type: requestType, id: 'checked', text, token }));
        const reply = JSON.parse(String((await next)[0]));
        assert.equal(reply.receipt.error.code, code);
    }
    assert.deepEqual(await readdir(directory), []);
    assert.equal(client.readyState, WebSocket.OPEN);
    const actual = { headers: { origin: 'http://evil.test', host: `127.0.0.1:${port}` }, url: '/business' } as never;
    const rejected = await receiver.handleSharedMessage({ type: requestType, id: 'origin', text: 'hello', token: 'secret', origin: `http://127.0.0.1:${port}` }, actual);
    assert.equal(rejected?.receipt.ok, false);
    if (rejected && !rejected.receipt.ok) assert.equal(rejected.receipt.error.code, 'FORBIDDEN');
    assert.equal(await receiver.handleSharedMessage({ type: 'business', text: 'not ours' }, actual), undefined);
    assert.equal(await receiver.handleSharedMessage({ type: requestType, id: '../bad', text: 'no' }, actual), undefined);
});
