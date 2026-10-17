import fs from 'node:fs';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-native-ipc.mjs WEBVIEW_DEVTOOLS_ACTIVE_PORT');
const port = Number(fs.readFileSync(process.argv[2], 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && item.url === 'http://tauri.localhost/');
if (!target) throw new Error('Native DockSlate window not found');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Only local WebView debugging is permitted');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const pending = new Map();
let counter = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
});
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native IPC diagnostic timed out')); }, 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const denied = async (command, args) => {
        try { return { allowed: true, result: await invoke(command, args) }; }
        catch (error) { return { allowed: false, message: String(error) }; }
      };
      return {
        engine: await invoke('engine_status'),
        overview: await invoke('overview'),
        delete: await denied('destructive_execute', { token: 'invalid-verification-token', approved: false }),
        compact: await denied('wsl_compact', { token: 'invalid-verification-token', approved: false }),
        pull: await denied('image_pull', { reference: '--invalid-reference' })
      };
    })()`,
    awaitPromise: true, returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  const observation = result.result.value;
  const checks = {
    uninstalledRuntimeUnavailable: observation.engine.state === 'unavailable',
    unknownUsageNotNumeric: ['containersRunning', 'containersStopped', 'images', 'dockerBytes', 'reclaimableBytes'].every(key => observation.overview[key] === null),
    deleteWithoutApprovalDenied: observation.delete.allowed === false,
    compactWithoutApprovalDenied: observation.compact.allowed === false,
    invalidPullDenied: observation.pull.allowed === false
  };
  fs.writeFileSync('docs/results/native-ipc-verification.json', JSON.stringify({ observedAt: new Date().toISOString(), target: 'built Windows Tauri IPC; no approved mutation', observation, checks }, null, 2));
  console.log(JSON.stringify({ observation, checks }));
  if (Object.values(checks).some(passed => !passed)) process.exitCode = 1;
} finally { socket.close(); }
