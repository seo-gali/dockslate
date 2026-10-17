import fs from 'node:fs';
import path from 'node:path';

const [portFile] = process.argv.slice(2);
if (!portFile || process.platform !== 'win32') throw new Error('Provide the actual built Windows DockSlate WebView2 port file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local WebView2 debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('The actual local DockSlate window is required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const pending = new Map();
const exceptions = [];
const calls = [];
const inFlightRequests = new Map();
let sequence = 0;
const readCommands = ['dashboard_snapshot', 'engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory'];
const parseCommand = url => {
  try {
    const value = new URL(url);
    return value.hostname === 'ipc.localhost' ? decodeURIComponent(value.pathname.replace(/^\//, '')) : null;
  } catch { return null; }
};
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent') {
    const command = message.params.request.method === 'POST' ? parseCommand(message.params.request.url) : null;
    if (command) {
      const call = { command, observedAt: Date.now() };
      calls.push(call);
      inFlightRequests.set(message.params.requestId, call);
    }
  }
  if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
    const call = inFlightRequests.get(message.params.requestId);
    if (call) {
      call.finishedAt = Date.now();
      if (message.method === 'Network.loadingFailed') call.failed = true;
      inFlightRequests.delete(message.params.requestId);
    }
  }
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (description, query, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await query(); if (value) return value; await pause(200); }
  throw new Error(`Timed out waiting for ${description}`);
};
const activePage = 'main [data-page]:not([hidden])';
const dockerPanel = `${activePage} [data-tab="docker"]:not([hidden])`;
const wslPanel = `${activePage} [data-tab="wsl"]:not([hidden])`;
const readSnapshot = `() => {
  const page = document.querySelector('main [data-page]:not([hidden])');
  const panel = page?.querySelector('[data-tab]:not([hidden])') ?? page;
  return {
    page: page?.getAttribute('data-page') ?? null,
    tab: page?.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? null,
    header: document.querySelector('.engine-topline .status-badge')?.textContent.trim() ?? null,
    metrics: [...(panel?.querySelectorAll('.metric-value') ?? [])].map(item => item.textContent.trim()),
    diskPaths: [...(panel?.querySelectorAll('.disk-path code') ?? [])].map(item => item.textContent.trim()),
    diskSizes: [...(panel?.querySelectorAll('.disk-properties > div:first-child strong') ?? [])].map(item => item.textContent.trim()),
    inputs: [...(panel?.querySelectorAll('input[type=search],.backup-form input') ?? [])].map(item => item.value),
    activeFilter: panel?.querySelector('.segmented button[aria-pressed=true]')?.textContent.trim() ?? null,
    refreshDisabled: page?.querySelector('.header-actions button')?.disabled ?? null,
    imageDataVisible: page?.getAttribute('data-page') === 'Images' ? !!page.querySelector('.data-table') || [...page.querySelectorAll('.state-panel h2')].some(item => item.textContent.trim() === '이미지가 없습니다') : null,
    busyPanels: [...(panel?.querySelectorAll('.state-panel[aria-busy=true]') ?? [])].map(item => item.innerText),
    errors: [...(panel?.querySelectorAll('.notice.error') ?? [])].map(item => item.innerText)
  };
}`;
const snapshot = () => evaluate(`(${readSnapshot})()`);
const firstFrameClick = expression => evaluate(`new Promise((resolve, reject) => {
  try { const actionStartedAt = performance.now(); ${expression}; requestAnimationFrame(() => resolve({ ...(${readSnapshot})(), firstFrameDelayMs: performance.now() - actionStartedAt })); } catch (error) { reject(error); }
})`);
const nav = async name => {
  const value = await firstFrameClick(`const button = [...document.querySelectorAll('nav button')].find(item => item.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Navigation unavailable'); button.click()`);
  requireFact(value.page === name, `${name} was not visible on the first animation frame`);
  return value;
};
const tab = async label => {
  const value = await firstFrameClick(`const button = [...document.querySelectorAll('${activePage} [role=tab]')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Tab unavailable'); button.click()`);
  requireFact(value.page === 'Disk Manager' && value.tab === label, `${label} was not visible on the first animation frame`);
  return value;
};
const setInput = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input || input.disabled) throw new Error('Input unavailable');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const captureReference = async selector => {
  const result = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  requireFact(result.result.objectId, `Persistent DOM node unavailable: ${selector}`);
  return { objectId: result.result.objectId, selector };
};
const verifyReference = async reference => {
  const result = await send('Runtime.callFunctionOn', { objectId: reference.objectId, functionDeclaration: 'function(selector) { return this.isConnected && this === document.querySelector(selector); }', arguments: [{ value: reference.selector }], returnByValue: true });
  requireFact(result.result.value === true, `Data node was remounted: ${reference.selector}`);
};
const report = {
  observedAt: new Date().toISOString(), target: 'actual built Windows DockSlate WebView2 window',
  mockData: false, changes: 'renderer reload, menu/tab clicks, temporary local filter/backup-input edits and one explicit Images Refresh; no runtime or Docker object mutation',
  measurement: 'CDP Network.requestWillBeSent records decoded IPC POST command names and local timestamps only; CORS OPTIONS requests are excluded. No headers, payloads, responses, backend functions, or request routing are intercepted or modified.',
  checks: [], startup: {}, navigation: {}, manualRefresh: {}, observations: [], screenshots: [], completed: false, failure: null,
  untested: ['Backend internals beyond actual IPC call counts', 'VHDX compaction or deletion']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const counts = list => Object.fromEntries(readCommands.map(command => [command, list.filter(item => item.command === command).length]));
const remember = (step, value) => { report.observations.push({ step, ...value }); return value; };
const assertReady = value => requireFact(value.header === 'Connected' && value.busyPanels.length === 0 && value.errors.length === 0, 'Retained data was replaced with loading, unavailable, or failed content');
const outputDirectory = path.resolve('.analysis/navigation-cache');
requireFact(!path.relative(process.cwd(), outputDirectory).startsWith('..'), 'Evidence must remain in the workspace');
fs.mkdirSync(outputDirectory, { recursive: true });
const screenshot = async name => {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  const filename = path.join(outputDirectory, `${name}.png`);
  fs.writeFileSync(filename, Buffer.from(image.data, 'base64')); report.screenshots.push(filename);
};
let navigationStart = 0;
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const beforeCalibration = calls.length;
  const calibration = await evaluate("window.__TAURI_INTERNALS__.invoke('engine_status')");
  requireFact(calibration.state === 'connected' && calibration.provider === 'DockSlate' && calibration.ownerPath === 'D:\\Program Files\\DockSlate\\runtime\\wsl', 'The actual independent owned engine must be running before read-only navigation verification');
  await waitFor('real IPC network observation', () => calls.slice(beforeCalibration).some(item => item.command === 'engine_status'), 5000);
  report.calibration = { command: 'engine_status', observed: true };
  calls.length = 0;
  await send('Page.reload', { ignoreCache: true });
  await waitFor('all actual startup data to be retained', async () => {
    try {
      return await evaluate("document.querySelectorAll('main [data-page]').length === 5 && document.querySelectorAll('main [data-page=\"Overview\"] .metric-value').length === 4 && document.querySelectorAll('main [data-page=\"Disk Manager\"] [data-tab=\"docker\"] .metric-value').length === 4 && document.querySelectorAll('main [data-page=\"Disk Manager\"] [data-tab=\"wsl\"] .disk-card').length > 0 && document.querySelector('.engine-topline .status-badge')?.textContent.trim() === 'Connected'");
    } catch { return false; }
  });
  await pause(350);
  report.startup.calls = [...calls]; report.startup.counts = counts(calls);
  for (const command of ['dashboard_snapshot', 'runtime_status', 'wsl_inventory']) requireFact(report.startup.counts[command] === 1, `Startup must request ${command} exactly once; observed ${report.startup.counts[command]}`);
  for (const command of ['engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage']) requireFact(report.startup.counts[command] === 0, `A separate startup ${command} request bypassed the shared dashboard snapshot`);
  check('startup performs one real dashboard snapshot, one runtime query and one WSL inventory query');
  navigationStart = calls.length;

  const containerFilter = 'dockslate-navigation-container-state';
  const imageFilter = 'dockslate-navigation-image-state';
  const dockerFilter = 'dockslate-navigation-cache-state';
  const backupValue = path.join(process.cwd(), '.analysis', 'navigation-cache-input-only.vhdx.bak');
  await nav('Containers');
  await setInput(`${activePage} input[type=search]`, containerFilter);
  await evaluate(`[...document.querySelectorAll('${activePage} .segmented button')].find(button => button.textContent.trim() === 'Stopped').click()`);
  const containerNode = await captureReference('main [data-page="Containers"] input[type=search]');
  await nav('Images'); await setInput(`${activePage} input[type=search]`, imageFilter);
  const imageNode = await captureReference('main [data-page="Images"] input[type=search]');
  await nav('Disk Manager');
  const initialDocker = remember('initial docker data', await tab('Docker Usage')); assertReady(initialDocker);
  requireFact(initialDocker.metrics.length === 4 && !initialDocker.metrics.includes('미확인'), 'Actual measured Docker category data is unavailable');
  await setInput(`${dockerPanel} input[type=search]`, dockerFilter);
  const dockerNode = await captureReference('main [data-page="Disk Manager"] [data-tab="docker"] .disk-metrics');
  const initialWsl = remember('initial WSL data', await tab('WSL Disks')); assertReady(initialWsl);
  requireFact(initialWsl.diskPaths.length > 0 && initialWsl.diskSizes.length === initialWsl.diskPaths.length, 'Actual WSL path/size data is unavailable');
  const wslNode = await captureReference('main [data-page="Disk Manager"] [data-tab="wsl"] .disk-card .disk-path code');
  await evaluate(`[...document.querySelectorAll('${wslPanel} .disk-card button')].find(button => button.textContent.trim() === '압축 준비 및 검사').click()`);
  await waitFor('local backup input', () => evaluate(`!!document.querySelector('${wslPanel} .backup-form input')`));
  await setInput(`${wslPanel} .backup-form input`, backupValue);
  const backupNode = await captureReference('main [data-page="Disk Manager"] [data-tab="wsl"] .backup-form input');
  check('real Docker measurements and WSL path/size data are loaded; local filter and backup-input state can be edited without disk operations');

  for (let index = 0; index < 3; index += 1) {
    remember(`round ${index + 1} overview`, await nav('Overview'));
    const containers = remember(`round ${index + 1} containers`, await nav('Containers')); assertReady(containers);
    requireFact(containers.inputs[0] === containerFilter && containers.activeFilter === 'Stopped', 'Container search/state filter did not persist on the first frame'); await verifyReference(containerNode);
    const images = remember(`round ${index + 1} images`, await nav('Images')); assertReady(images);
    requireFact(images.inputs[0] === imageFilter, 'Image search did not persist on the first frame'); await verifyReference(imageNode);
    const restoredWsl = remember(`round ${index + 1} WSL page`, await nav('Disk Manager')); assertReady(restoredWsl);
    requireFact(restoredWsl.tab === 'WSL Disks' && JSON.stringify(restoredWsl.diskPaths) === JSON.stringify(initialWsl.diskPaths) && JSON.stringify(restoredWsl.diskSizes) === JSON.stringify(initialWsl.diskSizes) && restoredWsl.inputs.includes(backupValue), 'WSL tab/data/local backup input did not persist immediately');
    await verifyReference(wslNode); await verifyReference(backupNode);
    const restoredDocker = remember(`round ${index + 1} Docker tab`, await tab('Docker Usage')); assertReady(restoredDocker);
    requireFact(JSON.stringify(restoredDocker.metrics) === JSON.stringify(initialDocker.metrics) && restoredDocker.inputs[0] === dockerFilter, 'Docker data/search did not persist on the first frame'); await verifyReference(dockerNode);
    const restoredTab = remember(`round ${index + 1} WSL tab`, await tab('WSL Disks')); assertReady(restoredTab);
    requireFact(restoredTab.inputs.includes(backupValue), 'WSL local preparation state was reset when its tab was hidden');
  }
  check('three menu/tab round trips retain the same actual data nodes, measurements and local inputs on the first animation frame');
  await screenshot('retained-wsl-preparation');
  const idleStartedAt = Date.now();
  await pause(16000);
  report.navigation.idleObservationMs = Date.now() - idleStartedAt;
  report.navigation.calls = calls.slice(navigationStart);
  report.navigation.counts = counts(report.navigation.calls);
  const frameTimings = report.observations.filter(item => item.step.startsWith('round ') && Number.isFinite(item.firstFrameDelayMs)).map(item => item.firstFrameDelayMs);
  report.navigation.firstFrameDelayMs = { samples: frameTimings, minimum: Math.min(...frameTimings), maximum: Math.max(...frameTimings), mean: frameTimings.reduce((sum, value) => sum + value, 0) / frameTimings.length };
  requireFact(readCommands.every(command => report.navigation.counts[command] === 0), 'Navigation or idle time issued a full-data backend read');
  check('menu/tab navigation and a 16-second idle interval make zero full-data backend IPC calls');

  await setInput(`${wslPanel} .backup-form input`, '');
  await evaluate(`[...document.querySelectorAll('${wslPanel} .disk-card button')].find(button => button.textContent.trim() === '준비 패널 닫기').click()`);
  await tab('Docker Usage'); await setInput(`${dockerPanel} input[type=search]`, '');
  await screenshot('retained-docker-usage');
  await nav('Images'); await setInput(`${activePage} input[type=search]`, '');
  await nav('Containers'); await setInput(`${activePage} input[type=search]`, '');
  await evaluate(`[...document.querySelectorAll('${activePage} .segmented button')].find(button => button.textContent.trim() === 'All').click()`);
  const beforeManualRefresh = await nav('Images'); assertReady(beforeManualRefresh);
  requireFact(beforeManualRefresh.imageDataVisible === true && beforeManualRefresh.refreshDisabled === false, 'Images must show its actual loaded list or empty state before manual refresh');
  const imageDataNode = await captureReference('main [data-page="Images"] .data-table,main [data-page="Images"] .state-panel');
  const manualStart = calls.length;
  const manualStartedAt = Date.now();
  const firstRefreshFrame = await firstFrameClick(`const button = document.querySelector('${activePage} .header-actions button'); if (!button || button.disabled || button.textContent.trim() !== '새로고침') throw new Error('Images Refresh is unavailable'); button.click()`);
  let loadingObserved = firstRefreshFrame.refreshDisabled === true;
  report.manualRefresh.firstFrame = firstRefreshFrame;
  report.manualRefresh.samples = [];
  const verifyRefreshView = async value => {
    assertReady(value);
    requireFact(value.page === 'Images' && value.imageDataVisible === true, 'The loaded image list/empty state disappeared during manual refresh');
    await verifyReference(imageDataNode);
    loadingObserved ||= value.refreshDisabled === true;
  };
  await verifyRefreshView(firstRefreshFrame);
  await waitFor('the real manual Images refresh to finish with retained data', async () => {
    const value = await snapshot();
    await verifyRefreshView(value);
    report.manualRefresh.samples.push({ observedAt: Date.now(), ...value });
    const observed = calls.slice(manualStart);
    const currentCounts = counts(observed);
    requireFact(readCommands.every(command => currentCounts[command] <= (command === 'images_list' || command === 'engine_status' ? 1 : 0)), 'Manual Images refresh requested extra or unrelated full-data reads');
    return currentCounts.engine_status === 1 && currentCounts.images_list === 1 && observed.filter(call => readCommands.includes(call.command)).every(call => call.finishedAt && !call.failed) && value.refreshDisabled === false;
  });
  await pause(250);
  report.manualRefresh.calls = calls.slice(manualStart);
  report.manualRefresh.counts = counts(report.manualRefresh.calls);
  report.manualRefresh.durationMs = Date.now() - manualStartedAt;
  report.manualRefresh.loadingObserved = loadingObserved;
  requireFact(loadingObserved, 'The refresh completed without observing the loading state; data retention while loading is unverified');
  requireFact(readCommands.every(command => report.manualRefresh.counts[command] === (command === 'images_list' || command === 'engine_status' ? 1 : 0)), 'Images Refresh must request exactly one images_list and one engine_status, with no other full-data reads');
  await verifyRefreshView(await snapshot());
  await screenshot('manual-images-refresh-retains-data');
  check('explicit Images Refresh makes exactly one engine and image-list read while retaining the actual list or empty state throughout loading');
  await nav('Overview');
  requireFact(exceptions.length === 0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  check('temporary local inputs are cleared and the real Overview is restored without renderer exceptions');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); report.checks.push({ name: 'halt at first cache criterion failure', passed: false, error: error.message });
  try { await screenshot('failure'); } catch {}
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.exceptions = exceptions;
  if (!report.completed) report.observedReadCounts = counts(calls);
  fs.writeFileSync('docs/results/navigation-cache-e2e.json', JSON.stringify(report, null, 2));
  try { await send('Network.disable'); } catch {}
  console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failure: report.failure, report: 'docs/results/navigation-cache-e2e.json' }));
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Verification ended')); }
  socket.close();
}
