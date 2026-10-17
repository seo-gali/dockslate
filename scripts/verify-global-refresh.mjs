import fs from 'node:fs';
import path from 'node:path';

const [portFile] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile) throw new Error('Provide the actual Windows DockSlate WebView2 port file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Actual local DockSlate window required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });

const pending = new Map();
const requests = new Map();
const calls = [];
const exceptions = [];
let sequence = 0;
const commands = ['dashboard_snapshot', 'engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory'];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const decodeCommand = url => { try { const value = new URL(url); return value.hostname === 'ipc.localhost' ? decodeURIComponent(value.pathname.slice(1)) : null; } catch { return null; } };
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent') {
    const command = message.params.request.method === 'POST' ? decodeCommand(message.params.request.url) : null;
    if (command) { const call = { command, observedAt: Date.now(), requestId: message.params.requestId }; calls.push(call); requests.set(call.requestId, call); }
  }
  if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
    const call = requests.get(message.params.requestId);
    if (call) {
      call.finishedAt = Date.now(); call.durationMs = call.finishedAt - call.observedAt;
      if (message.method === 'Network.loadingFailed') call.failed = true;
      if (call.command === 'dashboard_snapshot' && !call.failed) {
        call.bodyRead = send('Network.getResponseBody', { requestId: call.requestId }).then(result => {
          let value = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          for (let count = 0; count < 2 && typeof value === 'string'; count += 1) value = JSON.parse(value);
          if (!value?.engine_status || !value?.wsl_inventory) throw new Error('Actual response does not contain the seven-key dashboard contract');
          call.snapshot = value;
        }).catch(error => { call.responseReadError = error.message; });
      }
      requests.delete(message.params.requestId);
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
const dockerPanel = `${activePage} [data-tab="docker"]:not([hidden])`;
const counts = values => Object.fromEntries(commands.map(command => [command, values.filter(item => item.command === command).length]));
const serialCalls = values => values.map(({ command, observedAt, finishedAt, durationMs, failed, responseReadError }) => ({ command, observedAt, finishedAt, durationMs, failed, responseReadError }));
const snapshotScript = `() => {
  const pages = [...document.querySelectorAll('main [data-page]')];
  const page = document.querySelector('main [data-page]:not([hidden])');
  const get = name => document.querySelector('main [data-page="' + name + '"]');
  const metrics = root => [...(root?.querySelectorAll('.metric-value') ?? [])].map(item => item.textContent.trim());
  const imageRows = [...(get('Images')?.querySelectorAll('tbody tr') ?? [])];
  const imageEmpty = [...(get('Images')?.querySelectorAll('.state-panel h2') ?? [])].some(item => ['이미지가 없습니다','검색 결과가 없습니다'].includes(item.textContent.trim()));
  const containerRows = [...(get('Containers')?.querySelectorAll('tbody tr:not(.group-row)') ?? [])];
  const containerEmpty = [...(get('Containers')?.querySelectorAll('.state-panel h2') ?? [])].some(item => ['컨테이너가 없습니다','검색 결과가 없습니다'].includes(item.textContent.trim()));
  return {
    page: page?.getAttribute('data-page'), tab: page?.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? null,
    header: document.querySelector('.engine-topline .status-badge')?.textContent.trim(),
    refreshButtons: pages.map(root => { const button = root.querySelector('.header-actions button'); return { page: root.getAttribute('data-page'), disabled: button?.disabled, text: button?.textContent.trim() }; }),
    overview: metrics(get('Overview')), docker: metrics(get('Disk Manager')?.querySelector('[data-tab="docker"]')),
    imageIds: imageRows.map(row => row.querySelector('.cell-subtext')?.getAttribute('title') ?? ''), imageCount: imageRows.length, imageReady: imageRows.length > 0 || imageEmpty,
    containerIds: containerRows.map(row => row.querySelector('.cell-subtext')?.getAttribute('title') ?? ''), containerCount: containerRows.length, containerReady: containerRows.length > 0 || containerEmpty,
    disks: [...(get('Disk Manager')?.querySelectorAll('.disk-card') ?? [])].map(card => ({ path: card.querySelector('.disk-path code')?.textContent.trim(), size: card.querySelector('.disk-properties > div:first-child strong')?.textContent.trim() })),
    filters: Object.fromEntries(['Containers','Images'].map(name => [name, get(name)?.querySelector('input[type=search]')?.value ?? ''])),
    dockerFilter: get('Disk Manager')?.querySelector('[data-tab="docker"] input[type=search]')?.value ?? '',
    containerFilter: get('Containers')?.querySelector('.segmented button[aria-pressed=true]')?.textContent.trim(),
    busyPanels: [...document.querySelectorAll('main .state-panel[aria-busy=true]')].map(item => item.innerText),
    errors: [...document.querySelectorAll('main .notice.error')].map(item => item.innerText),
    preparationInputs: document.querySelectorAll('main .backup-form input').length,
    settingsLoaded: !!get('Settings')?.querySelector('.settings-properties dd'),
    pageCount: pages.length
  };
}`;
const ui = () => evaluate(`(${snapshotScript})()`);
const firstFrame = expression => evaluate(`new Promise((resolve,reject) => { try { const started = performance.now(); ${expression}; requestAnimationFrame(() => resolve({ ...(${snapshotScript})(), firstAnimationFrameDelayMs: performance.now() - started })); } catch(error) { reject(error); } })`);
const nav = async name => {
  const frame = await firstFrame(`const button = [...document.querySelectorAll('nav button')].find(item => item.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Navigation unavailable'); button.click()`);
  requireFact(frame.page === name, `Menu did not switch by the first animation frame: ${name}`); return frame;
};
const tab = async name => {
  const frame = await firstFrame(`const button = [...document.querySelectorAll('${activePage} [role=tab]')].find(item => item.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Tab unavailable'); button.click()`);
  requireFact(frame.tab === name, `Tab did not switch by the first animation frame: ${name}`); return frame;
};
const setInput = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input || input.disabled) throw new Error('Input unavailable'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles:true })); })()`);
const stableData = value => JSON.stringify({ overview: value.overview, docker: value.docker, imageIds: value.imageIds, imageCount: value.imageCount, imageReady: value.imageReady, containerIds: value.containerIds, containerCount: value.containerCount, containerReady: value.containerReady, disks: value.disks });
const assertReady = value => requireFact(value.pageCount === 5 && value.header === 'Connected' && value.overview.length === 4 && value.docker.length === 4 && value.imageReady && value.containerReady && value.disks.length > 0 && value.settingsLoaded && value.busyPanels.length === 0 && value.errors.length === 0 && value.refreshButtons.every(button => button.disabled === false), 'All five menus and both disk panels must contain real loaded data without errors');
const report = {
  observedAt: new Date().toISOString(), target: 'actual built Windows DockSlate WebView2 window', mockData: false,
  measurement: 'Actual IPC POST command names, completion timestamps and dashboard response bodies are observed with CDP Network. OPTIONS requests are excluded. Requests, responses, backend functions and request routing are never modified. First animation frame delay includes event scheduling and is not a paint/render benchmark.',
  changes: 'Renderer reload, local filters, navigation, four full refresh clicks, one read-only cleanup preview canceled before completion. No Docker/runtime/disk mutations.',
  checks: [], startup: {}, navigation: {}, refreshes: [], cleanupPreview: {}, screenshots: [], completed: false, failure: null,
  untested: ['Native renderer paint timing', 'Docker mutation and VHDX compaction']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const outputDirectory = path.resolve('.analysis/global-refresh');
requireFact(!path.relative(process.cwd(), outputDirectory).startsWith('..'), 'Evidence path must remain inside the workspace');
fs.mkdirSync(outputDirectory, { recursive: true });
const screenshot = async name => { const capture = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(outputDirectory, `${name}.png`); fs.writeFileSync(file, Buffer.from(capture.data, 'base64')); report.screenshots.push(file); };
let finalSnapshot;
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const calibrationStart = calls.length;
  const calibration = await evaluate("window.__TAURI_INTERNALS__.invoke('engine_status')");
  requireFact(calibration.state === 'connected' && calibration.engine === 'moby' && calibration.context === 'dockslate' && calibration.ownerPath, 'A verified running independent DockSlate Moby engine is required');
  await waitFor('real IPC calibration', () => calls.slice(calibrationStart).some(call => call.command === 'engine_status' && call.finishedAt), 5000);
  report.calibration = { command: 'engine_status', observed: true, context: calibration.context, ownerPath: calibration.ownerPath };
  calls.length = 0;
  const startupStartedAt = Date.now();
  await send('Page.reload', { ignoreCache: true });
  await waitFor('all seven startup results', async () => { try { const value = await ui(); assertReady(value); return value; } catch { return false; } });
  await pause(250);
  report.startup = { durationMs: Date.now() - startupStartedAt, calls: serialCalls(calls), counts: counts(calls), ui: await ui() };
  requireFact(commands.every(command => report.startup.counts[command] === (command === 'dashboard_snapshot' ? 1 : 0)), 'Startup must issue exactly one dashboard_snapshot and zero individual data reads');
  check('startup loads all five menus and both disk panels with exactly one actual dashboard snapshot');

  await nav('Containers'); await setInput(`${activePage} input[type=search]`, 'dockslate-navigation-retained');
  await evaluate(`[...document.querySelectorAll('${activePage} .segmented button')].find(item => item.textContent.trim() === 'Stopped').click()`);
  await nav('Images'); await setInput(`${activePage} input[type=search]`, 'dockslate-image-retained');
  await nav('Disk Manager'); await tab('Docker Usage'); await setInput(`${dockerPanel} input[type=search]`, 'dockslate-cache-retained'); await tab('WSL Disks');
  const retained = await ui();
  const navigationStart = calls.length;
  const frames = [];
  for (let index = 0; index < 3; index += 1) {
    for (const name of ['Overview', 'Containers', 'Images', 'Disk Manager', 'Settings']) {
      const frame = await nav(name); frames.push({ round: index + 1, page: name, firstAnimationFrameDelayMs: frame.firstAnimationFrameDelayMs });
      requireFact(frame.busyPanels.length === 0 && frame.errors.length === 0 && JSON.stringify(frame.filters) === JSON.stringify(retained.filters) && frame.containerFilter === 'Stopped' && frame.dockerFilter === retained.dockerFilter, 'Navigation lost retained local state or replaced data with loading');
      if (name === 'Disk Manager') { requireFact(frame.tab === 'WSL Disks', 'Disk tab selection did not persist'); await tab('Docker Usage'); await tab('WSL Disks'); }
    }
  }
  const idleStartedAt = Date.now(); await pause(6500);
  report.navigation = { frames, idleObservationMs: Date.now() - idleStartedAt, calls: serialCalls(calls.slice(navigationStart)), counts: counts(calls.slice(navigationStart)) };
  requireFact(commands.every(command => report.navigation.counts[command] === 0), 'Navigation or idle time triggered a data query');
  check('three menu/tab round trips and more than six seconds idle issue zero data reads and retain filters/tab selection');

  await nav('Containers'); await setInput(`${activePage} input[type=search]`, 'dockslate-refresh-container');
  await nav('Images'); await setInput(`${activePage} input[type=search]`, 'dockslate-refresh-image');
  await nav('Disk Manager'); await tab('Docker Usage'); await setInput(`${dockerPanel} input[type=search]`, 'dockslate-refresh-cache');
  for (const name of ['Images', 'Overview', 'Disk Manager', 'Settings']) {
    const before = await nav(name); assertReady(before);
    const node = await send('Runtime.evaluate', { expression: `document.querySelector('main [data-page="Images"] .data-table,main [data-page="Images"] .state-panel')` });
    requireFact(node.result.objectId, 'Actual image list or empty-state DOM node required');
    const start = calls.length; const startedAt = Date.now();
    const frame = await firstFrame(`const button = document.querySelector('${activePage} .header-actions button'); if (!button || button.disabled || !button.textContent.includes('새로고침')) throw new Error('Global refresh unavailable'); button.click()`);
    requireFact(frame.page === name && stableData(frame) === stableData(before) && frame.busyPanels.length === 0, 'Existing data was removed at refresh start');
    requireFact(JSON.stringify(frame.filters) === JSON.stringify(before.filters) && frame.containerFilter === before.containerFilter && frame.dockerFilter === before.dockerFilter && frame.tab === before.tab, 'Global refresh reset filters, selected menu or disk tab');
    requireFact(frame.refreshButtons.length === 5 && frame.refreshButtons.every(button => button.disabled && button.text.includes('전체 조회')), 'All five headers must share the active global refresh state');
    let retainedWhileLoading = true;
    await waitFor(`${name} full refresh completion`, async () => {
      const value = await ui();
      requireFact(JSON.stringify(value.filters) === JSON.stringify(before.filters) && value.containerFilter === before.containerFilter && value.dockerFilter === before.dockerFilter && value.tab === before.tab, 'Global refresh changed retained local state');
      const phase = calls.slice(start); const phaseCounts = counts(phase);
      requireFact(commands.every(command => phaseCounts[command] <= (command === 'dashboard_snapshot' ? 1 : 0)), 'Global refresh issued duplicate or individual reads');
      const sameNode = await send('Runtime.callFunctionOn', { objectId: node.result.objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true });
      requireFact(sameNode.result.value && value.busyPanels.length === 0 && value.page === name, 'Global refresh replaced retained data nodes or changed the selected menu');
      if (value.refreshButtons.some(button => button.disabled)) retainedWhileLoading &&= stableData(value) === stableData(before);
      return phaseCounts.dashboard_snapshot === 1 && phase.filter(call => commands.includes(call.command)).every(call => call.finishedAt && !call.failed) && value.refreshButtons.every(button => button.disabled === false);
    });
    await pause(150);
    const phase = calls.slice(start); const phaseCounts = counts(phase);
    requireFact(retainedWhileLoading && commands.every(command => phaseCounts[command] === (command === 'dashboard_snapshot' ? 1 : 0)), 'Refresh must retain old data and issue exactly one shared snapshot');
    const actual = phase.find(call => call.command === 'dashboard_snapshot');
    await actual.bodyRead;
    finalSnapshot = actual.snapshot ?? finalSnapshot;
    report.refreshes.push({ page: name, durationMs: Date.now() - startedAt, firstAnimationFrameDelayMs: frame.firstAnimationFrameDelayMs, allHeadersSharedBusy: true, retainedData: true, counts: phaseCounts, calls: serialCalls(phase) });
  }
  check('Refresh from Images, Overview, Disk Manager and Settings each issues one shared snapshot while all headers agree and existing data remains visible');

  await nav('Containers'); await setInput(`${activePage} input[type=search]`, ''); await evaluate(`[...document.querySelectorAll('${activePage} .segmented button')].find(item => item.textContent.trim() === 'All').click()`);
  await nav('Images'); await setInput(`${activePage} input[type=search]`, '');
  await nav('Disk Manager'); await tab('Docker Usage'); await setInput(`${dockerPanel} input[type=search]`, '');

  if (!finalSnapshot) {
    const start = calls.length;
    finalSnapshot = await evaluate("window.__TAURI_INTERNALS__.invoke('dashboard_snapshot')");
    report.comparisonRead = { reason: 'CDP response body unavailable; explicit read-only snapshot used after refresh-count phases', calls: serialCalls(calls.slice(start)) };
  }
  const comparison = await evaluate(`(() => {
    const snapshot = ${JSON.stringify(finalSnapshot)};
    const result = command => { if (!snapshot[command] || !Object.prototype.hasOwnProperty.call(snapshot[command], 'Ok')) throw new Error('Actual snapshot failed: ' + command); return snapshot[command].Ok; };
    const bytes = value => { if (value == null || !Number.isFinite(value)) return '미확인'; if (Math.abs(value) < 1000) return value.toLocaleString() + ' B'; const index = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1000)), 4); return (value / 1000 ** index).toLocaleString(undefined,{maximumFractionDigits:1}) + ' ' + ['B','KB','MB','GB','TB'][index]; };
    const overview = result('overview'), usage = result('disk_usage'), images = result('images_list'), containers = result('containers_list'), inventory = result('wsl_inventory');
    const view = (${snapshotScript})();
    return { expected: { overview:[overview.containersRunning.toLocaleString(),overview.images.toLocaleString(),bytes(overview.dockerBytes),bytes(overview.reclaimableBytes)], docker:[bytes(usage.imagesBytes),bytes(usage.buildCacheBytes),bytes(usage.containersBytes),bytes(usage.volumesBytes)], imageIds:images.map(item=>item.id).sort(), containerIds:containers.map(item=>item.id).sort(), diskSizes:inventory.disks.map(item=>item.exists?bytes(item.fileSizeBytes):'파일 없음') }, actual: { overview:view.overview,docker:view.docker,imageIds:view.imageIds.sort(),containerIds:view.containerIds.sort(),diskSizes:view.disks.map(item=>item.size) } };
  })()`);
  requireFact(JSON.stringify(comparison.expected) === JSON.stringify(comparison.actual), 'Overview, image/container rows, usage and VHDX sizes disagree with the actual returned snapshot');
  report.comparison = comparison;
  check('all retained overview values, Docker categories, image/container IDs and VHDX sizes match actual backend snapshot data');

  await nav('Disk Manager'); await tab('Docker Usage');
  const eligible = await evaluate(`(() => { const row = [...document.querySelectorAll('${dockerPanel} tbody tr')].find(item => item.querySelector('td:nth-child(2)')?.textContent.trim() === 'Build cache' && item.querySelector('input[type=checkbox]:not(:disabled)')); if (!row) return null; return { id:row.querySelector('.cell-subtext')?.textContent.trim(),label:row.querySelector('td:nth-child(3) > span')?.textContent.trim() }; })()`);
  requireFact(eligible?.id, 'No existing eligible build-cache row; read-only cleanup-preview timing needs a pre-existing candidate and this script will not create fixtures');
  await evaluate(`(() => { const row = [...document.querySelectorAll('${dockerPanel} tbody tr')].find(item=>item.querySelector('.cell-subtext')?.textContent.trim() === ${JSON.stringify(eligible.id)}); const checkbox=row?.querySelector('input[type=checkbox]'); if(!checkbox || checkbox.disabled) throw new Error('Eligible cache disappeared'); if(!checkbox.checked) checkbox.click(); })()`);
  const previewStart = calls.length;
  const dialogFrame = await evaluate(`new Promise((resolve,reject)=>{ try { const started=performance.now(); const button=document.querySelector('${dockerPanel} .selection-summary button'); if(!button || button.disabled) throw new Error('Cleanup control unavailable'); button.click(); requestAnimationFrame(()=>{ const dialog=document.querySelector('[role=dialog]'); const confirm=dialog?.querySelector('footer .danger-button'); resolve({ firstAnimationFrameDelayMs:performance.now()-started,visible:!!dialog && dialog.getBoundingClientRect().width>0,title:dialog?.querySelector('h2')?.textContent.trim(),checking:dialog?.querySelector('[role=status]')?.textContent.trim(),confirmDisabled:confirm?.disabled,acknowledgeDisabled:dialog?.querySelector('input[type=checkbox]')?.disabled,targets:[...(dialog?.querySelectorAll('.dialog-target-list li')??[])].map(item=>item.textContent.trim()) }); }); } catch(error){reject(error);} })`);
  requireFact(dialogFrame.visible && dialogFrame.checking && dialogFrame.confirmDisabled && dialogFrame.acknowledgeDisabled && dialogFrame.targets.some(item => item.includes(eligible.id)), 'Cleanup dialog must be visible on the first animation frame with cached selected IDs and disabled approval while validating');
  requireFact(!calls.slice(previewStart).some(call => call.command === 'destructive_preview' && call.finishedAt), 'Preview completed before cancellation; late-response cancellation is unverified');
  await evaluate("(() => { const dialog=document.querySelector('[role=dialog]'); const button=dialog?.querySelector('footer button'); if(!button || button.disabled) throw new Error('Cancel unavailable during validation'); button.click(); })()");
  await waitFor('late preview response after cancellation', () => calls.slice(previewStart).some(call => call.command === 'destructive_preview' && call.finishedAt));
  await pause(350);
  requireFact(await evaluate("!document.querySelector('[role=dialog]')"), 'Canceled validation reopened a dialog after its late response');
  requireFact(!calls.some(call => call.command === 'destructive_execute' || ['container_action','image_pull','runtime_start','runtime_stop','wsl_compact'].includes(call.command)), 'Read-only verification must never execute a mutation');
  report.cleanupPreview = { eligible, firstFrame: dialogFrame, canceledBeforeResponse: true, dialogStayedClosed: true, calls: serialCalls(calls.slice(previewStart)) };
  await evaluate(`(() => { const row = [...document.querySelectorAll('${dockerPanel} tbody tr')].find(item=>item.querySelector('.cell-subtext')?.textContent.trim() === ${JSON.stringify(eligible.id)}); const checkbox=row?.querySelector('input[type=checkbox]'); if(checkbox?.checked) checkbox.click(); })()`);
  check('cleanup confirmation appears on the first animation frame, blocks approval while validating and ignores the late preview after cancellation');
  await nav('Overview'); await screenshot('global-refresh-overview');
  requireFact(exceptions.length === 0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  check('the actual Overview is restored with no renderer exceptions or Docker/runtime/disk mutations');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); report.checks.push({ name: 'halt at first global-refresh criterion failure', passed: false, error: error.message });
  try { await screenshot('failure'); } catch {}
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.exceptions = exceptions; report.observedReadCounts = counts(calls);
  fs.writeFileSync('docs/results/global-refresh-e2e.json', JSON.stringify(report, null, 2));
  try { await send('Network.disable'); } catch {}
  console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failure: report.failure, report: 'docs/results/global-refresh-e2e.json' }));
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Verification ended')); }
  socket.close();
}
