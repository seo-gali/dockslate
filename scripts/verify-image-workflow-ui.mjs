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
const report = {
  observedAt: new Date().toISOString(), target: 'real built Windows DockSlate WebView2 window with stopped independent runtime', mockData: false,
  changes: 'Menu navigation, search collapse/expansion, image build discovery and read-only built-in API VHDX prerequisites. No engine, image, container or disk mutations.',
  measurement: 'Actual IPC POST command names/timestamps and wsl_preview response bodies are observed through CDP. No requests, response values, backend functions or routing are replaced.',
  checks: [], selection: [], navigation: {}, preview: {}, retry: {}, elevation: {}, screenshots: [], completed: false, failure: null,
  untested: ['Approved elevated relaunch, UAC approval, elevated replacement window and original-window closure', 'Opening Windows Features or installing optional Windows components', 'Real VHDX compaction', 'Physical copying from a disabled search input while its engine is disconnected']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const evidenceDirectory = path.resolve('.analysis/image-workflow-ui');
requireFact(!path.relative(process.cwd(), evidenceDirectory).startsWith('..'), 'Evidence must remain in the workspace');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const screenshot = async name => { const capture = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(evidenceDirectory, `${name}.png`); fs.writeFileSync(file, Buffer.from(capture.data, 'base64')); report.screenshots.push(file); };
const drag = async (selector, expectedSelection) => {
  const region = await evaluate(`(() => { window.getSelection()?.removeAllRanges(); document.activeElement?.blur(); const item=document.querySelector(${JSON.stringify(selector)}); if(!item) throw new Error('Drag target unavailable: '+${JSON.stringify(selector)}); item.scrollIntoView({block:'center',inline:'nearest'}); const rect=item.getBoundingClientRect(); if(rect.width<12 || rect.height<8) throw new Error('Drag target not visible'); return {x:rect.left+4,y:rect.top+Math.min(rect.height/2,12),endX:Math.min(rect.right-4,rect.left+Math.min(rect.width-8,420)),text:item.textContent.trim(),userSelect:getComputedStyle(item).userSelect}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: region.x, y: region.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: region.x, y: region.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: region.x + (region.endX - region.x) * step / 8, y: region.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: region.endX, y: region.y, button: 'left', buttons: 0, clickCount: 1 });
  const selected = await evaluate('window.getSelection()?.toString() ?? ""');
  report.selection.push({ selector, ...region, selected });
  requireFact(expectedSelection ? selected.trim().length > 0 && region.text.includes(selected.trim()) : selected.length === 0, expectedSelection ? `Real pointer drag did not select copyable data: ${selector}` : `App chrome selected text during a real pointer drag: ${selector}`);
  await evaluate('window.getSelection()?.removeAllRanges()');
};
const getPreview = async start => {
  const call = await waitFor('actual wsl_preview completion', () => calls.slice(start).find(item => item.command === 'wsl_preview' && item.finishedAt));
  await call.bodyRead;
  if (call.preview) return call.preview;
  throw new Error(`Actual prerequisite response could not be read: ${call.responseReadError ?? 'missing response body'}`);
};
const checkRows = () => evaluate(`(() => { const panel=document.querySelector('${wslPanel}'); return [...(panel?.querySelectorAll('.prerequisite-list [data-check]')??[])].map(row=>({name:row.getAttribute('data-check'),status:row.querySelector('.status-badge')?.textContent.trim(),diagnostic:row.querySelector(':scope > div > details p')?.textContent.trim(),help:[...row.querySelectorAll(':scope > div > p')].map(item=>item.textContent.trim()).join(' '),actions:[...row.querySelectorAll('button')].map(button=>({text:button.textContent.trim(),disabled:button.disabled})),visibleText:row.innerText})); })()`);
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.reload', {ignoreCache:true});
  await waitFor('fresh stopped startup', () => evaluate("document.querySelectorAll('main [data-page]').length===5 && document.querySelector('main [data-page=Settings] .settings-properties .status-badge')?.textContent.trim()==='중지됨' && [...document.querySelectorAll('main .header-actions button:first-child')].every(button=>!button.disabled)"));
  const runtime = await evaluate("window.__TAURI_INTERNALS__.invoke('runtime_status')");
  requireFact(runtime.state === 'stopped' && runtime.distribution === 'DockSlate', 'This read-only test requires the already stopped owned runtime');
  report.initialRuntime = runtime;
  await waitFor('startup complete', () => evaluate("[...document.querySelectorAll('main .header-actions button:first-child')].every(button=>!button.disabled)"));
  await nav('Images');
  const images = activePage;
  const disconnected = await evaluate(`(() => { const panel=document.querySelector('.registry-search-panel'); return {text:panel.innerText,disabled:panel.querySelector('#registry-search').disabled,hasSettings:[...panel.querySelectorAll('button')].some(b=>b.textContent.trim()==='엔진 설정')}; })()`);
  requireFact(disconnected.text.includes('DockSlate 엔진을 통해 실행') && disconnected.text.includes('런타임을 시작') && disconnected.disabled && disconnected.hasSettings, 'Disconnected search needs a truthful explanation and a Settings action');
  report.disconnectedSearch=disconnected;
  await clickText('.registry-search-panel', '엔진 설정');
  await waitFor('Settings shortcut',()=>evaluate("document.querySelector('nav [aria-current]')?.textContent.trim()==='Settings'"));
  check('stopped runtime search explains its engine dependency and opens Settings');
  await nav('Images');
  const collapseStart=calls.length;
  await clickText('.registry-search-panel','접기');
  requireFact(await evaluate("document.querySelector('#registry-search-body').hidden && document.querySelector('.registry-search-panel [aria-expanded]').getAttribute('aria-expanded')==='false'"),'Search body did not collapse');
  await nav('Overview'); await nav('Images');
  requireFact(await evaluate("document.querySelector('#registry-search-body').hidden"),'Collapsed state was lost on navigation');
  await clickText('.registry-search-panel','펼치기');
  await pause(600);
  requireFact(calls.length===collapseStart,'Search collapse or navigation unexpectedly invoked the backend');
  check('search collapse and expansion preserve state across menus and perform zero backend reads');
  await clickText(images+' .header-actions','이미지 빌드');
  requireFact(await evaluate("!!document.querySelector('#build-context')"),'Header image build form is not discoverable when stopped');
  await clickText(images+' .header-actions','이미지 빌드');
  check('image build is available from the Images header while the runtime is stopped');
  await nav('Disk Manager');
  await evaluate(`(() => { const button=[...document.querySelectorAll('${activePage} [role=tab]')].find(item=>item.textContent.trim()==='WSL Disks'); if(!button||button.disabled) throw new Error('WSL tab unavailable'); button.click(); })()`);
  await waitFor('owned disk',()=>evaluate(`!!document.querySelector('${wslPanel} .disk-card')`));
  await clickText(wslPanel+' .disk-card','압축 준비 및 검사');
  requireFact(await evaluate(`!document.querySelector('${wslPanel} .backup-form input')`),'Backup input is still required');
  const diskPath=await evaluate(`document.querySelector('${wslPanel} .disk-path code').textContent.trim()`);
  const before=fs.statSync(diskPath);
  const previewStart=calls.length;
  await clickText(wslPanel+' .disk-inspection','사전 조건 검사');
  const preview=await getPreview(previewStart);
  await waitFor('inspection rendered',()=>evaluate(`document.querySelectorAll('${wslPanel} .prerequisite-list [data-check]').length===${preview.checks.length}`));
  requireFact(preview.method==='CompactVirtualDisk' && preview.diskTools.available && preview.diskTools.method==='CompactVirtualDisk','Built-in Windows API must avoid the unnecessary Hyper-V module requirement on this PC');
  requireFact(preview.checks.find(c=>c.name==='diskTools')?.status==='passed','Built-in disk API availability did not pass');
  const summary=await evaluate(`(() => {const list=document.querySelector('${wslPanel} .prerequisite-list');const details=list.closest('details');return {open:details.open,summary:details.querySelector('summary').textContent,text:document.querySelector('${wslPanel} .disk-card').innerText};})()`);
  requireFact(!summary.open && summary.summary.includes('검사 상세 보기'),'Safety diagnostics must be collapsed initially');
  requireFact(!summary.text.includes('Windows 기능 열기') && !summary.text.includes('Get-VHD') && !summary.text.includes('—'),'Normal compression view still demands Hyper-V tools or exposes filler');
  if(!preview.eligible) requireFact(!preview.token,'An unsupported prerequisite must not issue an approval token');
  await evaluate(`document.querySelector('${wslPanel} .prerequisite-list').closest('details').querySelector('summary').click()`);
  const rows=await checkRows();
  requireFact(rows.length===preview.checks.length && rows.every(row=>{const actual=preview.checks.find(c=>c.name===row.name);return actual && actual.detail===row.diagnostic && row.status===(actual.status==='passed'?'확인됨':'확인 필요');}),'Expanded diagnostics do not match the actual backend checks');
  const after=fs.statSync(diskPath);
  requireFact(before.size===after.size && before.mtimeMs===after.mtimeMs,'Read-only inspection modified the VHDX');
  report.preview={result:preview,summary,rows,fileUnchanged:{size:after.size,mtimeMs:after.mtimeMs}};
  await screenshot('builtin-api-inspection-details');
  check('real built-in Windows API preflight avoids Hyper-V modules, preserves file metadata and keeps all safety results in collapsed details');
  await nav('Settings');
  requireFact(await evaluate("document.querySelectorAll('main [data-page=Settings] .operation-banner.success').length===0 && document.querySelector('.engine-topline .status-badge').textContent.trim()==='Disconnected'"),'Stopped state retains a misleading success banner');
  requireFact(!calls.some(c=>forbiddenCommands.has(c.command)) && exceptions.length===0,'Read-only test mutated the engine or recorded renderer exceptions');
  report.completed=true;
} catch(error) {
  report.failure=error.stack??String(error); report.checks.push({name:'halt at real native UI failure',passed:false,error:error.message}); process.exitCode=1;
  try{await screenshot('failure');}catch{}
} finally {
  report.finishedAt=new Date().toISOString();report.exceptions=exceptions;report.observedCounts=counts(calls);
  fs.writeFileSync('docs/results/image-workflow-ui-e2e.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({completed:report.completed,checks:report.checks,failure:report.failure}));socket.close();
}
