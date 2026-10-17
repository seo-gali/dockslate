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
  changes: 'Renderer reload, menu/tab navigation, real CDP pointer drags, read-only VHDX prerequisites and a canceled elevation confirmation. One explicit unapproved elevation request verifies rejection. No engine/data/disk changes or operating-system windows are requested.',
  measurement: 'Actual IPC POST command names/timestamps and wsl_preview response bodies are observed through CDP. No requests, response values, backend functions or routing are replaced. Text selection uses actual Input.dispatchMouseEvent drags.',
  checks: [], selection: [], navigation: {}, preview: {}, retry: {}, elevation: {}, screenshots: [], completed: false, failure: null,
  untested: ['Approved elevated relaunch, UAC approval, elevated replacement window and original-window closure', 'Opening Windows Features or installing optional Windows components', 'Real VHDX compaction', 'Physical copying from a disabled search input while its engine is disconnected']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const evidenceDirectory = path.resolve('.analysis/ui-prerequisites');
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
  const runtime = await evaluate("window.__TAURI_INTERNALS__.invoke('runtime_status')");
  requireFact(runtime.state === 'stopped' && runtime.distribution === 'DockSlate' && runtime.installPath, 'This test requires the already stopped verified DockSlate runtime; it will not change engine state');
  report.initialRuntime = runtime;
  await nav('Settings');
  report.settingsBeforeReload = await evaluate(`(() => { const page=document.querySelector('${activePage}'); return {badge:page.querySelector('.settings-properties .status-badge')?.textContent.trim(),header:document.querySelector('.engine-topline .status-badge')?.textContent.trim(),successBanners:page.querySelectorAll('.operation-banner.success').length}; })()`);
  requireFact(report.settingsBeforeReload.badge==='중지됨' && report.settingsBeforeReload.header==='Disconnected' && report.settingsBeforeReload.successBanners===0, 'The current stopped session retains a misleading green completion banner before any renderer reload');
  calls.length = 0;
  await send('Page.reload', { ignoreCache: true });
  await waitFor('stopped runtime startup snapshot', () => evaluate("document.querySelectorAll('main [data-page]').length===5 && document.querySelector('main [data-page=\"Settings\"] .settings-properties .status-badge')?.textContent.trim()==='중지됨' && [...document.querySelectorAll('main [data-page] .header-actions button:first-child')].every(button=>!button.disabled) && !!document.querySelector('main [data-page=\"Disk Manager\"] .disk-card')"));
  report.startup = { calls: serialCalls(calls), counts: counts(calls) };
  requireFact(report.startup.counts.dashboard_snapshot === 1 && dataCommands.filter(command=>command!=='dashboard_snapshot').every(command=>report.startup.counts[command]===0), 'Fresh renderer startup must use one global snapshot without individual or registry reads');
  check('the real stopped independent runtime loads through one global snapshot');

  await nav('Overview');
  await drag(`${activePage} .page-header h1`, false);
  await drag(`${activePage} .page-header p`, false);
  await drag('nav button[aria-current="page"]', false);
  check('actual mouse drags across the title, subtitle and active navigation select no app-chrome text');

  const navigationStart = calls.length;
  for (const name of ['Images', 'Containers', 'Overview', 'Settings', 'Disk Manager', 'Images']) await nav(name);
  const registry = await evaluate(`(() => { const page=document.querySelector('${activePage}'); const input=page?.querySelector('#registry-search'); const rect=input?.getBoundingClientRect(); return {present:!!input,visible:!!rect && rect.width>0 && rect.height>0,disabled:input?.disabled,userSelect:input?getComputedStyle(input).userSelect:null,pullForms:page?.querySelectorAll('.pull-form').length,header:document.querySelector('.engine-topline .status-badge')?.textContent.trim()}; })()`);
  requireFact(registry.present && registry.visible && registry.disabled && registry.userSelect === 'text' && registry.pullForms === 0 && registry.header === 'Disconnected', 'Docker Hub search must be immediately visible, copy-selectable by CSS and disabled while disconnected, with no hidden Pull form opened');
  await pause(6000);
  report.navigation = { registry, idleMs: 6000, calls: serialCalls(calls.slice(navigationStart)), counts: counts(calls.slice(navigationStart)) };
  requireFact(dataCommands.every(command=>report.navigation.counts[command]===0), 'Navigation or idle time automatically queried backend data or Docker Hub');
  check('Docker Hub search is visible without opening Pull, remains disabled while disconnected and navigation performs no automatic reads');

  await nav('Disk Manager');
  await evaluate(`(() => { const button=[...document.querySelectorAll('${activePage} [role=tab]')].find(item=>item.textContent.trim()==='WSL Disks'); if(!button || button.disabled) throw new Error('WSL tab unavailable'); button.click(); })()`);
  await waitFor('visible WSL inventory', () => evaluate(`!!document.querySelector('${wslPanel} .disk-card')`));
  const ownDisk = await evaluate(`(() => { const card=[...document.querySelectorAll('${wslPanel} .disk-card')].find(item=>item.querySelector('h2')?.textContent.trim()==='DockSlate'); return card?{path:card.querySelector('.disk-path code')?.textContent.trim(),state:[...card.querySelectorAll('.disk-properties strong')][1]?.textContent.trim()}:null; })()`);
  requireFact(ownDisk?.path && ownDisk.state === '중지됨', 'The actual owned stopped DockSlate VHDX is required');
  await drag(`${wslPanel} .disk-card .disk-path code`, true);
  await clickText(`${wslPanel} .disk-card`, '압축 준비 및 검사');
  requireFact(await evaluate(`document.querySelectorAll('${wslPanel} .backup-form input').length===0`), 'Prerequisite inspection must not require a backup path');
  const previewStart = calls.length;
  await clickText(`${wslPanel} .disk-inspection`, '사전 조건 검사');
  const preview = await getPreview(previewStart);
  await waitFor('actual prerequisite rows', async () => { const rows=await checkRows(); return rows.length===preview.checks.length && rows.every(row=>row.actions.every(action=>!action.disabled)); });
  await evaluate(`document.querySelector('${wslPanel} .prerequisite-list').closest('details').querySelector('summary').click()`);
  const rows = await checkRows();
  requireFact(preview.path && preview.path.toLowerCase() === ownDisk.path.toLowerCase() && preview.diskId && Array.isArray(preview.checks), 'Inspected target does not match the actual owned VHDX');
  requireFact(rows.length === preview.checks.length && rows.every(row=>{const actual=preview.checks.find(item=>item.name===row.name);return actual && row.status===(actual.status==='passed'?'확인됨':'확인 필요') && row.diagnostic===actual.detail;}), 'Displayed prerequisite states or diagnostics differ from the actual live backend result');
  const blocked = rows.filter(row=>row.status!=='확인됨');
  requireFact(blocked.length>0 && blocked.every(row=>row.help.length>0 && row.actions.some(action=>!action.disabled) && !row.visibleText.includes('—')), 'Every blocked prerequisite needs visible help and an enabled action, without em-dash filler');
  const tools = rows.find(row=>row.name==='diskTools');
  const actualTools = preview.checks.find(item=>item.name==='diskTools');
  requireFact(tools && actualTools, 'The combined live diskTools capability check must be present');
  if (actualTools.status === 'passed') requireFact(['CompactVirtualDisk', 'Optimize-VHD'].includes(preview.method), 'Passed disk tools must expose the actual supported Windows method');
  report.preview = { ownDisk, result: preview, rows, calls: serialCalls(calls.slice(previewStart)), counts: counts(calls.slice(previewStart)) };
  requireFact(calls.slice(previewStart).filter(call=>call.command==='wsl_preview').length===1 && !calls.slice(previewStart).some(call=>dataCommands.includes(call.command)), 'Inspection must use one read-only wsl_preview without refreshing the whole application');
  check('real prerequisite rows match live ownership, stopped state, permission and disk-tool diagnostics and provide enabled remedies');

  const diagnosticCheck = rows.find(row=>row.diagnostic)?.name;
  requireFact(diagnosticCheck, 'A real copyable check diagnostic is required');
  await evaluate(`(() => { const details=document.querySelector('${wslPanel} [data-check="${diagnosticCheck}"] details'); if(!details) throw new Error('Real diagnostic missing'); if(!details.open) details.querySelector('summary').click(); })()`);
  await drag(`${wslPanel} [data-check="${diagnosticCheck}"] details p`, true);
  check('actual VHDX paths and real prerequisite diagnostics remain selectable with a mouse drag');

  const retryCheck = rows.find(row=>row.status!=='확인됨' && row.actions.some(action=>action.text==='다시 검사' && !action.disabled));
  const retryStart = calls.length;
  if (retryCheck) await clickText(`${wslPanel} [data-check="${retryCheck.name}"]`, '다시 검사');
  else await clickText(`${wslPanel} .disk-inspection`, '사전 조건 검사');
  const retried = await getPreview(retryStart);
  await waitFor('retry controls enabled again', async () => { const current=await checkRows(); return current.length===retried.checks.length && current.every(row=>row.actions.every(action=>!action.disabled)); });
  await evaluate(`(() => {const details=document.querySelector('${wslPanel} .prerequisite-list').closest('details');if(!details.open)details.querySelector('summary').click();})()`);
  await pause(200);
  const retryCalls = calls.slice(retryStart);
  requireFact(retryCalls.length===1 && retryCalls[0].command==='wsl_preview' && !retryCalls[0].failed, 'A row retry must issue only one wsl_preview');
  report.retry = { check:retryCheck?.name ?? 'inspection',result:retried,calls:serialCalls(retryCalls),counts:counts(retryCalls) };
  check('inspection retry performs only one actual read-only wsl_preview');

  const elevationStart = calls.length;
  const timeOrigin = await evaluate('performance.timeOrigin');
  await clickText(`${wslPanel} [data-check="administrator"]`, '관리자 권한으로 다시 실행');
  await waitFor('elevation confirmation', () => evaluate("document.querySelector('[role=dialog] h2')?.textContent.trim()==='관리자 권한으로 다시 실행'"));
  const confirmation = await evaluate("(() => { const dialog=document.querySelector('[role=dialog]'); return { text:dialog.innerText,acknowledged:dialog.querySelector('input[type=checkbox]')?.checked,confirmDisabled:dialog.querySelector('footer .danger-button')?.disabled,cancelEnabled:!dialog.querySelector('footer button')?.disabled }; })()");
  requireFact(confirmation.confirmDisabled && !confirmation.acknowledged && confirmation.cancelEnabled && confirmation.text.includes('Windows 권한 요청') && confirmation.text.includes('현재 창을 닫습니다') && confirmation.text.includes('엔진 상태와 저장된 데이터는 유지'), 'Elevation confirmation must disclose impact and require acknowledgement');
  await screenshot('elevation-confirmation-unapproved');
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()");
  requireFact(await evaluate("!document.querySelector('[role=dialog] footer .danger-button').disabled"), 'Acknowledgement must enable the confirmation control');
  await evaluate("document.querySelector('[role=dialog] footer button').click()");
  requireFact(await evaluate("!document.querySelector('[role=dialog]')"), 'Cancel must close elevation confirmation');
  requireFact(calls.slice(elevationStart).length===0, 'Opening, acknowledging and canceling elevation must never launch or call a backend command');
  const rejection = await evaluate("window.__TAURI_INTERNALS__.invoke('desktop_restart_elevated',{approved:false}).then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}))");
  requireFact(rejection.rejected && rejection.error.includes('승인'), 'The backend must reject explicitly unapproved elevation');
  requireFact(await evaluate(`performance.timeOrigin===${timeOrigin} && !!document.querySelector('${wslPanel} .disk-card') && !document.querySelector('[role=dialog]')`), 'Unapproved elevation must preserve the original UI window');
  report.elevation = { confirmation,rejection,originalUiPreserved:true,calls:serialCalls(calls.slice(elevationStart)),counts:counts(calls.slice(elevationStart)),approvedRelaunchExecuted:false,windowsFeaturesOpened:false };
  check('elevation confirmation describes impact, requires acknowledgement and cancels without launch; backend rejects approved:false and preserves the original UI');

  await nav('Settings');
  const stopped = await evaluate(`(() => { const page=document.querySelector('${activePage}'); return {runtimeBadge:page.querySelector('.settings-properties .status-badge')?.textContent.trim(),header:document.querySelector('.engine-topline .status-badge')?.textContent.trim(),persistentSuccess:page.querySelectorAll('.operation-banner.success').length,neutralMessage:page.innerText.includes('DockSlate 엔진이 중지되었습니다.'),rawDiagnostics:!!page.querySelector('.runtime-diagnostics')}; })()`);
  requireFact(stopped.runtimeBadge==='중지됨' && stopped.header==='Disconnected' && stopped.persistentSuccess===0 && stopped.neutralMessage && stopped.rawDiagnostics, 'Stopped runtime must use neutral current-state text without a persistent green completion banner and retain raw diagnostics');
  requireFact(!calls.some(call=>forbiddenCommands.has(call.command)) && calls.filter(call=>call.command==='desktop_restart_elevated').length===1, 'Read-only verification attempted a forbidden engine/data/disk/window action');
  requireFact(exceptions.length===0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  report.stoppedSettings = stopped;
  await screenshot('stopped-settings-neutral-state');
  check('stopped Settings has neutral state, a Disconnected header, retained diagnostics and no stale success banner or actual system changes');
  report.completed=true;
} catch(error) {
  report.failure=error.stack??String(error);report.checks.push({name:'halt at first actual UI/prerequisite failure',passed:false,error:error.message});
  try{await screenshot('failure');}catch{}
  process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();report.exceptions=exceptions;report.observedCounts=counts(calls);
  fs.writeFileSync('docs/results/ui-prerequisites-e2e.json',JSON.stringify(report,null,2));
  try{await send('Network.disable');}catch{}
  console.log(JSON.stringify({completed:report.completed,checks:report.checks,failure:report.failure,report:'docs/results/ui-prerequisites-e2e.json'}));
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Verification ended'));}
  socket.close();
}
