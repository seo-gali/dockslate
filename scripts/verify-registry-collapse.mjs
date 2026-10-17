import fs from 'node:fs';
import path from 'node:path';

const [portFile] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile) throw new Error('Provide the real Windows DockSlate WebView2 port file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('A real local DockSlate window is required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const requests = new Map();
const calls = [];
const exceptions = [];
const dataCommands = ['dashboard_snapshot', 'engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory', 'image_search'];
const forbiddenCommands = new Set(['container_run', 'network_create', 'image_build_start', 'image_pull', 'container_action', 'destructive_execute', 'runtime_install', 'runtime_start', 'runtime_stop', 'wsl_compact', 'desktop_open_windows_features']);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const parseCommand = url => { try { const value = new URL(url); return value.hostname === 'ipc.localhost' ? decodeURIComponent(value.pathname.slice(1)) : null; } catch { return null; } };
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent') {
    const command = message.params.request.method === 'POST' ? parseCommand(message.params.request.url) : null;
    if (command) { const call = { command, requestId: message.params.requestId, observedAt: Date.now() }; calls.push(call); requests.set(call.requestId, call); }
  }
  if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
    const call = requests.get(message.params.requestId);
    if (call) {
      call.finishedAt = Date.now(); call.durationMs = call.finishedAt - call.observedAt;
      if (message.method === 'Network.loadingFailed') call.failed = true;
      if (call.command === 'wsl_preview' && !call.failed) call.bodyRead = send('Network.getResponseBody', { requestId: call.requestId }).then(response => {
        let value = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        for (let count = 0; count < 2 && typeof value === 'string'; count += 1) value = JSON.parse(value);
        if (!Array.isArray(value?.checks)) throw new Error('Actual wsl_preview response has no checks');
        call.preview = value;
      }).catch(error => { call.responseReadError = error.message; });
      requests.delete(call.requestId);
    }
  }
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.value ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result.value;
};
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (description, query, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await query(); if (value) return value; await pause(100); }
  throw new Error(`Timed out: ${description}`);
};
const activePage = 'main [data-page]:not([hidden])';
const wslPanel = `${activePage} [data-tab="wsl"]:not([hidden])`;
const serialCalls = values => values.map(({ command, observedAt, finishedAt, durationMs, failed, responseReadError }) => ({ command, observedAt, finishedAt, durationMs, failed, responseReadError }));
const counts = values => Object.fromEntries([...new Set([...dataCommands, 'wsl_preview', 'desktop_restart_elevated', ...forbiddenCommands])].map(command => [command, values.filter(call => call.command === command).length]));
const nav = async name => {
  await evaluate(`(() => { window.getSelection()?.removeAllRanges(); const button=[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim()===${JSON.stringify(name)}); if(!button || button.disabled) throw new Error('Navigation unavailable'); button.click(); })()`);
  await waitFor(`active ${name}`, () => evaluate(`document.querySelector('${activePage}')?.getAttribute('data-page')===${JSON.stringify(name)}`));
};
const clickText = async (scope, text) => {
  await evaluate(`(() => { const button=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(item=>item.textContent.trim()===${JSON.stringify(text)}); if(!button || button.disabled) throw new Error('Control unavailable: '+${JSON.stringify(text)}); button.click(); })()`);
};

try {
 await send('Runtime.enable'); await send('Network.enable');
 await nav('Images');
 if(await evaluate("document.querySelector('#registry-search-body').hidden")) await clickText('.registry-search-panel','펼치기');
 const before=await evaluate("({term:document.querySelector('#registry-search').value,rows:[...document.querySelectorAll('.registry-search-panel tbody tr')].map(r=>r.textContent),height:document.querySelector('.registry-search-panel').getBoundingClientRect().height})");
 requireFact(before.rows.length>0,'Actual Hub results required');const start=calls.length;
 await clickText('.registry-search-panel','접기');
 const collapsed=await evaluate("({hidden:document.querySelector('#registry-search-body').hidden,height:document.querySelector('.registry-search-panel').getBoundingClientRect().height})");
 await nav('Overview');await nav('Images');await clickText('.registry-search-panel','펼치기');
 const after=await evaluate("({term:document.querySelector('#registry-search').value,rows:[...document.querySelectorAll('.registry-search-panel tbody tr')].map(r=>r.textContent)})");
 requireFact(collapsed.hidden && collapsed.height<before.height && before.term===after.term && JSON.stringify(before.rows)===JSON.stringify(after.rows) && calls.length===start,'Collapse did not preserve actual results or caused a backend read');
 fs.writeFileSync('docs/results/registry-collapse-e2e.json',JSON.stringify({completed:true,before,collapsed,after,backendCalls:serialCalls(calls.slice(start)),mockData:false,observedAt:new Date().toISOString()},null,2));
 console.log('Actual populated Hub search collapses, preserves results and does not read the backend.');
}finally{socket.close();}
