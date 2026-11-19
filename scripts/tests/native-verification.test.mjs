import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDebugger } from '../native-verification.mjs';

class DebuggerSocket extends EventTarget {
  static OPEN = 1;
  static current;
  readyState = 0;
  constructor() {
    super(); DebuggerSocket.current = this;
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(value) {
    const request = JSON.parse(value);
    if (request.method.endsWith('.enable')) queueMicrotask(() => this.receive({ id: request.id, result: {} }));
    this.last = request;
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('debugger rejects remote sockets before connecting', async () => {
  await assert.rejects(connectDebugger('ws://example.com/devtools'), /local debugger/);
  await assert.rejects(connectDebugger('http://localhost/devtools'), /local debugger/);
  await assert.rejects(connectDebugger('ws://name:password@localhost/devtools'), /local debugger/);
});

test('protocol responses, IPC timing and pending requests are handled on close', async t => {
  const original = globalThis.WebSocket; globalThis.WebSocket = DebuggerSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const connection = await connectDebugger('ws://127.0.0.1/devtools');
  t.after(() => connection.close());
  const socket = DebuggerSocket.current;
  const evaluated = connection.evaluate('1');
  socket.receive({ id: socket.last.id, result: { result: { value: 1 } } });
  assert.equal(await evaluated, 1);
  const rejected = connection.send('Fail');
  socket.receive({ id: socket.last.id, error: { message: 'denied' } });
  await assert.rejects(rejected, /denied/);
  const event = (method, params) => socket.receive({ method, params });
  event('Network.requestWillBeSent', { requestId: 'one', request: { method: 'POST', url: 'http://ipc.localhost/dashboard_snapshot' } });
  event('Network.loadingFinished', { requestId: 'one' });
  assert.equal(connection.calls[0].command, 'dashboard_snapshot');
  assert.ok(connection.calls[0].durationMs >= 0);
  assert.ok(connection.calls[0].finishedAt >= connection.calls[0].observedAt);
  const pending = connection.send('NoResponse');
  socket.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(connection.send('AfterClose'), /closed/);
});

test('explicit cleanup rejects unfinished requests instead of leaving promises pending', async t => {
  const original = globalThis.WebSocket; globalThis.WebSocket = DebuggerSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const connection = await connectDebugger('ws://localhost/devtools');
  const pending = connection.send('NoResponse');
  connection.close();
  await assert.rejects(pending, /Verification ended/);
});
