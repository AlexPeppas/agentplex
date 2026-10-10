const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { WebSocket } = require('ws');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');

test('real local WS closes a slow subscriber with 1013, never resumes stale output and isolates healthy subscribers', async t => {
  const manager = { events: new EventEmitter() };
  const { WsServer } = loadSource('src/main/remote/ws-server.ts', {
    './auth': { extractQueryToken: () => 'synthetic', validateToken: () => true },
  });
  const server = http.createServer();
  const wsServer = new WsServer(server, manager);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/ws?token=synthetic`;
  const slow = new WebSocket(url), healthy = new WebSocket(url);
  const messages = [];
  healthy.on('message', raw => messages.push(JSON.parse(raw)));
  t.after(async () => {
    slow.terminate(); healthy.terminate(); wsServer.stop();
    await new Promise(resolve => server.close(resolve));
  });
  await Promise.all([once(slow, 'open'), once(healthy, 'open')]);
  slow.send(JSON.stringify({ type: 'subscribe', sessions: '*' }));
  healthy.send(JSON.stringify({ type: 'subscribe', sessions: '*' }));
  const sockets = [...wsServer.clients.keys()];
  await Promise.all(sockets.map(socket => once(socket, 'message')));
  const slowSocket = sockets.find(socket => socket._socket.remotePort === slow._socket.localPort);
  assert.ok(slowSocket);
  let buffered = 1_048_576;
  Object.defineProperty(slowSocket, 'bufferedAmount', { get: () => buffered });
  manager.events.emit(IPC.SESSION_DATA, { id: 'session', data: 'boundary' });
  await once(slow, 'message');
  const closed = once(slow, 'close');
  buffered++;
  manager.events.emit(IPC.SESSION_STATUS, { id: 'session', status: 'killed' });
  manager.events.emit(IPC.SESSION_EXIT, { id: 'session', exitCode: 0 });
  const [code, reason] = await closed;
  assert.equal(code, 1013);
  assert.match(String(reason), /resync/);
  buffered = 0;
  const finalMessage = once(healthy, 'message');
  manager.events.emit(IPC.SESSION_DATA, { id: 'session', data: 'after drain' });
  await finalMessage;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages.map(e => e.type), ['session:data', 'session:status', 'session:exit', 'session:data']);
  assert.equal(slow.readyState, WebSocket.CLOSED);
  assert.equal(wsServer.clients.size, 1);
});

test('a slow client that ignores the close handshake is terminated on a bounded timer', { timeout: 5000 }, async t => {
  const { WsServer } = loadSource('src/main/remote/ws-server.ts');
  const instance = new WsServer(http.createServer(), { events: new EventEmitter() });
  t.after(() => instance.stop());
  const state = { id: 'owned-slow' };
  let terminated;
  const done = new Promise(resolve => { terminated = resolve; });
  const keepAlive = setTimeout(() => {}, 4000);
  t.after(() => { clearTimeout(state.backpressureTimer); clearTimeout(keepAlive); });
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 1_048_577, closes: [], kills: 0,
    close(...args) { this.closes.push(args); }, terminate() { this.kills++; terminated(); } };
  assert.equal(instance.canSend(socket, state), false);
  socket.bufferedAmount = 0;
  assert.equal(instance.canSend(socket, state), false);
  assert.equal(socket.closes.length, 1);
  assert.equal(socket.kills, 0);
  await done;
  assert.equal(socket.kills, 1);
});
