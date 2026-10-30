import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const { port } = probe.address();
await new Promise(resolve => probe.close(resolve));

const app = spawn(process.execPath, [process.argv[2] ?? 'downloads/server.mjs'], {
  env: { ...process.env, PORT: String(port), APP_NAME: 'Node example check' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const exited = once(app, 'exit');
try {
  await once(app.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  for (const [route, status, expected] of [
    ['/', 200, { app: 'Node example check', node: process.version }],
    ['/health', 200, { status: 'ok' }],
    ['/missing', 404, { error: 'Not found' }],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), expected);
  }
  console.log('Node example: root, health and 404 HTTP checks passed; no containers started.');
} finally {
  app.kill();
  await exited;
}
