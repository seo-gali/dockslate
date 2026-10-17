import fs from 'node:fs';

const [portFile, approval] = process.argv.slice(2);
if (!portFile || approval !== '--approved-install-and-start') throw new Error('Explicit session approval is required: PORT_FILE --approved-install-and-start');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(item => item.type === 'page' && item.url === 'http://tauri.localhost/');
if (!page || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(page.webSocketDebuggerUrl).hostname)) throw new Error('The actual local DockSlate window is required');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const observations = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitUntil = async expression => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(200); }
  throw new Error('The approved runtime UI did not become ready');
};
const invoke = command => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})`);
const observe = status => {
  observations.push({ observedAt: new Date().toISOString(), status });
  console.log(JSON.stringify({ state: status.state, message: status.operation?.message ?? status.message }));
};
const waitOperation = async expected => {
  const deadline = Date.now() + 3600000;
  let previous = '';
  while (Date.now() < deadline) {
    const status = await invoke('runtime_status');
    const progress = `${status.state}|${status.operation?.message ?? status.message}`;
    if (progress !== previous) { observe(status); previous = progress; }
    if (status.state === expected) return status;
    if (['failed', 'unsupported'].includes(status.state)) throw new Error(status.message);
    await pause(3000);
  }
  throw new Error('Runtime operation exceeded verification time; the operation was not terminated');
};
const approveDialog = async action => {
  await waitUntil("!!document.querySelector('[role=dialog] input[type=checkbox]')");
  const text = await evaluate("document.querySelector('[role=dialog]').innerText");
  if (!text.includes('DockSlate')) throw new Error('The approval dialog identifies another runtime');
  if (action === 'install' && (!text.includes('D:\\Program Files\\DockSlate\\runtime\\wsl') || !text.includes('29.8.2') || !text.includes('ext4.vhdx'))) throw new Error('The installation preview differs from the approved target');
  observations.push({ observedAt: new Date().toISOString(), approvedAction: action, dialog: text });
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()");
  const label = action === 'install' ? '설치 승인 및 실행' : '시작 승인 및 실행';
  await waitUntil(`Array.from(document.querySelectorAll('[role=dialog] button')).some(button => button.textContent.includes(${JSON.stringify(label)}) && !button.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent.includes(${JSON.stringify(label)})).click()`);
  await waitUntil("(() => { const error = document.querySelector('[role=dialog] .dialog-error'); if (error) throw new Error(error.textContent); return !document.querySelector('[role=dialog]'); })()");
};
let succeeded = false;
try {
  await send('Runtime.enable');
  await evaluate("Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === 'Settings').click()");
  let status = await invoke('runtime_status'); observe(status);
  if (status.distribution !== 'DockSlate' || status.installPath !== 'D:\\Program Files\\DockSlate\\runtime\\wsl') throw new Error('The application is not configured for the approved separate runtime');
  if (status.state === 'not_installed') {
    await waitUntil("Array.from(document.querySelectorAll('main button')).some(button => button.textContent.includes('런타임 설치') && !button.disabled)");
    await evaluate("Array.from(document.querySelectorAll('main button')).find(button => button.textContent.includes('런타임 설치')).click()");
    await approveDialog('install');
    status = await waitOperation('stopped');
  }
  if (status.state === 'stopped') {
    await waitUntil("Array.from(document.querySelectorAll('main button')).some(button => button.textContent.includes('런타임 시작') && !button.disabled)");
    await evaluate("Array.from(document.querySelectorAll('main button')).find(button => button.textContent.includes('런타임 시작')).click()");
    await approveDialog('start');
    status = await waitOperation('running');
  }
  if (status.state !== 'running' || !status.keeperVerified) throw new Error('The owned runtime did not reach its verified running state');
  const engine = await invoke('engine_status');
  observations.push({ observedAt: new Date().toISOString(), engine });
  if (engine.state !== 'connected' || engine.provider !== 'DockSlate' || engine.endpoint !== 'wsl://DockSlate/var/run/docker.sock') throw new Error('The actual independent Engine API did not connect');
  succeeded = true; console.log(JSON.stringify({ succeeded, engine }));
} catch (error) {
  observations.push({ observedAt: new Date().toISOString(), failure: String(error) });
  throw error;
} finally {
  fs.writeFileSync('docs/results/independent-runtime-provisioning.json', JSON.stringify({ observedAt: new Date().toISOString(), approved: true, target: 'D:\\Program Files\\DockSlate\\runtime\\wsl', succeeded, observations }, null, 2));
  socket.close();
}
