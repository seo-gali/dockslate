import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [activePortFile, approval] = process.argv.slice(2);
if (!activePortFile || approval !== '--approved-owned-runtime-stop-start') {
  throw new Error('Usage: node scripts/verify-runtime-recovery.mjs WEBVIEW_DEVTOOLS_ACTIVE_PORT --approved-owned-runtime-stop-start. Stops and starts only the verified DockSlate runtime; no Docker objects or disks are changed.');
}
if (process.platform !== 'win32') throw new Error('The actual Windows DockSlate EXE is required');
const outputDirectory = '.analysis/runtime-recovery';
const reportPath = 'docs/results/runtime-recovery-e2e.json';
const approvedPath = 'D:\\Program Files\\DockSlate\\runtime\\wsl';
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const canonical = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
const imageIdentities = images => images.map(image => ({ id: image.id, tags: [...image.tags].sort() })).sort((left, right) => left.id.localeCompare(right.id));
const isFixtureImage = image => image.tags.some(tag => tag.replace(/^(?:docker\.io\/)?(?:library\/)?/, '') === 'busybox:1.37.0');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const directory of [outputDirectory, 'docs/results']) {
  const resolved = path.resolve(directory);
  requireFact(!path.relative(process.cwd(), resolved).startsWith('..'), 'Evidence must remain within the workspace');
  let ancestor = resolved;
  for (;;) {
    if (fs.existsSync(ancestor)) requireFact(fs.lstatSync(ancestor).isDirectory() && !fs.lstatSync(ancestor).isSymbolicLink(), 'Evidence directories must not traverse junctions or symlinks');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  fs.mkdirSync(resolved, { recursive: true });
}
const port = Number(fs.readFileSync(activePortFile, 'utf8').split('\n')[0]);
requireFact(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid local WebView2 debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
requireFact(target && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname), 'The built local DockSlate WebView2 window is required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const pending = new Map();
const exceptions = [];
let sequence = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP timeout: ${method}; inspect the actual runtime before retrying a mutation`));
  }, 60000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const snapshot = () => evaluate(`(() => ({
  page: document.querySelector('nav button[aria-current="page"]')?.textContent.trim() ?? null,
  header: document.querySelector('.engine-topline .status-badge')?.textContent.trim() ?? null,
  text: document.querySelector('main [data-page]:not([hidden])')?.innerText ?? '',
  busyPanels: [...document.querySelectorAll('main [data-page]:not([hidden]) .state-panel[aria-busy="true"] h2')].map(item => item.textContent.trim()),
  errors: [...document.querySelectorAll('main [data-page]:not([hidden]) .notice.error')].map(item => item.innerText),
  imageRows: [...document.querySelectorAll('main [data-page]:not([hidden]) tbody tr')].flatMap(row => {
    const identity = row.querySelector('.cell-subtext[title^="sha256:"]');
    return identity ? [{ id: identity.title, tags: identity.closest('td').title === identity.title ? [] : identity.closest('td').title.split('\\n') }] : [];
  }),
  navigationDisabled: [...document.querySelectorAll('nav button')].some(button => button.disabled)
}))()`);
const waitFor = async (description, query, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await query();
    if (value) return value;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${description}; no automatic mutation retry or cleanup was performed`);
};
const nav = async name => {
  await waitFor(`enabled ${name} navigation`, () => evaluate(`!![...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === ${JSON.stringify(name)} && !button.disabled)`));
  await evaluate(`[...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
  await waitFor(`${name} page`, async () => (await snapshot()).page === name);
};
const requestRuntimeAction = async (action, destination) => {
  const label = action === 'stop' ? '중지' : '시작';
  await nav('Settings');
  const buttonText = `런타임 ${label}…`;
  await waitFor(`enabled own-runtime ${action} UI control`, () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(button => button.textContent.trim() === ${JSON.stringify(buttonText)} && !button.disabled)`));
  await evaluate(`[...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(button => button.textContent.trim() === ${JSON.stringify(buttonText)}).click()`);
  await waitFor(`actual ${action} confirmation dialog`, () => evaluate("!!document.querySelector('[role=dialog] input[type=checkbox]')"));
  const dialog = await evaluate("document.querySelector('[role=dialog]').innerText");
  requireFact(dialog.includes('DockSlate') && dialog.includes(`런타임 ${label} 확인`), 'The lifecycle approval dialog identifies another runtime or action');
  report.observations[`${action}ApprovalDialog`] = dialog;
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()");
  const approvalLabel = `${label} 승인 및 실행`;
  await waitFor(`enabled ${action} approval`, () => evaluate(`!![...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === ${JSON.stringify(approvalLabel)} && !button.disabled)`));
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === ${JSON.stringify(approvalLabel)}).click()`);
  await waitFor(`${action} approval dialog closed`, () => evaluate("(() => { const error = document.querySelector('[role=dialog] .dialog-error'); if (error) throw new Error(error.textContent); return !document.querySelector('[role=dialog]'); })()"));
  await nav(destination);
};
const screenshot = async name => {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  const filename = path.join(outputDirectory, `${name}.png`);
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'));
  return filename;
};
const readFingerprint = runtime => {
  requireFact(runtime.distribution === 'DockSlate' && runtime.installPath === approvedPath && runtime.blockedReasons?.length === 0, 'The runtime is outside the approved owned distribution or its ownership is blocked');
  const filename = path.join(path.dirname(runtime.installPath), 'ownership.json');
  const stat = fs.lstatSync(filename);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 131072, 'Runtime ownership must be a single regular marker file');
  const marker = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  requireFact(marker.owner === 'DockSlate' && marker.state === 'installed' && marker.distribution === 'DockSlate' && marker.installPath === approvedPath && marker.installId && marker.registrationId && marker.rootfsSha256, 'Runtime ownership is incomplete or refers to another installation');
  return { installId: marker.installId, registrationId: marker.registrationId, rootfsSha256: marker.rootfsSha256, installPath: marker.installPath, engineVersion: marker.engineVersion };
};
const execFileAsync = promisify(execFile);
const guestInfo = async () => {
  requireFact(process.env.SystemRoot && /^[A-Za-z]:\\/.test(process.env.SystemRoot), 'The Windows system directory is unavailable');
  const executable = path.join(process.env.SystemRoot, 'System32', 'wsl.exe');
  requireFact(fs.existsSync(executable), 'The Windows system WSL executable is unavailable');
  const result = await execFileAsync(executable, ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}'], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  const info = JSON.parse(result.stdout);
  requireFact(info.ID && info.OSType === 'linux' && !/docker desktop/i.test(info.OperatingSystem ?? ''), 'The fixed own-distribution CLI did not identify an independent Linux engine');
  return { id: info.ID, operatingSystem: info.OperatingSystem, serverVersion: info.ServerVersion };
};
const report = {
  observedAt: new Date().toISOString(), target: 'real built Windows DockSlate EXE and approved own WSL runtime',
  mockData: false, explicitOwnedRuntimeStopStartApproval: true,
  mutations: ['own-runtime Stop UI approval', 'own-runtime Start UI approval'],
  transitionObservation: 'Real Settings lifecycle confirmation is followed by immediate navigation to Images or Containers. Subsequent transition observation is DOM-only: no runtime_status, engine_status, manual refresh, further navigation or CLI call completes or recovers the operation. The global application controller tracks its actual approved action without idle polling.',
  failurePolicy: 'Stop at the first failed criterion; do not retry lifecycle commands or automatically clean up. An interrupted test can leave the approved own runtime stopped.',
  checks: [], observations: {}, transitions: [], screenshots: [], exceptions, completed: false, failure: null,
  untested: ['VHDX compaction or deletion', 'Other WSL distributions', 'Concurrent external Docker object changes']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
let previousImageFilter = null;
const observeTransition = async (action, page, terminal) => {
  let previous = '';
  let busyObserved = false;
  const result = await waitFor(`automatic ${action} completion on ${page}`, async () => {
    const value = await snapshot();
    requireFact(value.page === page, `The ${page} page changed during the observed transition`);
    const key = JSON.stringify(value);
    if (key !== previous) {
      report.transitions.push({ observedAt: new Date().toISOString(), action, ...value });
      previous = key;
    }
    if (value.header === '작업 중') {
      requireFact(value.busyPanels.length > 0, 'A busy header must have a busy page state rather than failed Docker data');
      requireFact(!value.text.includes('Disconnected') && !value.text.includes('DockSlate 엔진이 실행되지 않았습니다'), 'An active operation was misrepresented as an unavailable engine');
      requireFact(value.errors.length === 0, 'A busy operation was displayed as a query failure');
      requireFact(value.navigationDisabled === false, 'Runtime lifecycle unnecessarily blocked navigation');
      if (!busyObserved) report.screenshots.push(await screenshot(`${action}-busy-${page.toLowerCase()}`));
      busyObserved = true;
    }
    return terminal(value) && { snapshot: value, busyObserved };
  }, 120000);
  report.observations[`${action}Transition`] = result;
  return result;
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  const initialRuntime = await invoke('runtime_status');
  const ownership = readFingerprint(initialRuntime);
  requireFact(initialRuntime.state === 'running' && initialRuntime.keeperVerified === true, 'The approved own runtime must already be running and verified');
  const initialEngine = await invoke('engine_status');
  requireFact(initialEngine.state === 'connected' && initialEngine.provider === 'DockSlate' && initialEngine.engine === 'moby' && initialEngine.ownerPath === approvedPath && initialEngine.endpoint === 'wsl://DockSlate/var/run/docker.sock', 'The application is not connected to the independent owned Moby engine');
  const baseline = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage'), info: await guestInfo() };
  requireFact(baseline.containers.length === 0, 'Stop/start verification requires no existing containers; existing objects are preserved');
  requireFact(!baseline.images.some(isFixtureImage), 'The E2E busybox:1.37.0 image already exists; inspect its ownership before verification');
  const baselineImages = imageIdentities(baseline.images);
  const imagesLoaded = value => value.header === 'Connected' && value.errors.length === 0 && value.busyPanels.length === 0 &&
    JSON.stringify(imageIdentities(value.imageRows)) === JSON.stringify(baselineImages) &&
    (baselineImages.length > 0 ? !value.text.includes('이미지가 없습니다') : value.text.includes('이미지가 없습니다'));
  report.observations.baseline = { runtime: initialRuntime, engine: initialEngine, ownership, ...baseline };
  check('verified independent owned runtime, stable CLI identity, empty container baseline and preserved image identities');

  await nav('Images');
  previousImageFilter = await evaluate(`document.querySelector('main [data-page]:not([hidden]) input[placeholder^="로컬 이미지"]')?.value ?? null`);
  requireFact(previousImageFilter !== null, 'Actual Images local filter is unavailable');
  if (previousImageFilter) await evaluate(`(() => { const input = document.querySelector('main [data-page]:not([hidden]) input[placeholder^="로컬 이미지"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor('actual connected Images page with exact baseline identities and tags', async () => imagesLoaded(await snapshot()));
  report.screenshots.push(await screenshot('initial-connected-images'));
  await requestRuntimeAction('stop', 'Images');
  await observeTransition('stop', 'Images', value => value.header === 'Disconnected' && value.text.includes('DockSlate 엔진이 실행되지 않았습니다') && value.busyPanels.length === 0 && value.errors.length === 0);
  report.screenshots.push(await screenshot('stopped-images'));
  check('off-Settings runtime stop completes and Images automatically reflects the stopped engine');

  await nav('Containers');
  await waitFor('stopped Containers page', async () => { const value = await snapshot(); return value.header === 'Disconnected' && value.text.includes('DockSlate 엔진이 실행되지 않았습니다'); });
  await requestRuntimeAction('start', 'Containers');
  const started = await observeTransition('start', 'Containers', value => value.header === 'Connected' && value.text.includes('컨테이너가 없습니다') && value.errors.length === 0 && value.busyPanels.length === 0);
  requireFact(started.busyObserved, 'The real start operation completed without observing its explicit busy state; the busy-state criterion is unverified');
  report.screenshots.push(await screenshot('recovered-containers'));
  check('real off-Settings start displays busy separately and automatically restores Containers without manual refresh');

  await nav('Images');
  await waitFor('automatically recovered Images page with exact baseline rows', async () => { const value = await snapshot(); return imagesLoaded(value) && !value.text.includes('Docker access is blocked'); });
  report.screenshots.push(await screenshot('recovered-images'));
  check('Images reopens connected without the stale runtime-operation query error');

  const finalRuntime = await invoke('runtime_status');
  requireFact(finalRuntime.state === 'running' && finalRuntime.keeperVerified === true && canonical(readFingerprint(finalRuntime)) === canonical(ownership), 'Owned runtime identity or verified running state changed');
  const finalEngine = await invoke('engine_status');
  requireFact(finalEngine.state === 'connected' && finalEngine.provider === 'DockSlate' && finalEngine.ownerPath === approvedPath, 'The actual Engine API did not reconnect');
  const finalState = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage'), info: await guestInfo() };
  requireFact(finalState.info.id === baseline.info.id, 'Docker Engine identity changed across the owned runtime stop/start');
  requireFact(finalState.containers.length === 0 && JSON.stringify(imageIdentities(finalState.images)) === JSON.stringify(baselineImages), 'Existing image identities/tags or the empty container baseline changed during lifecycle-only verification');
  requireFact(JSON.stringify(finalState.usage.buildCache.map(item => item.id).sort()) === JSON.stringify(baseline.usage.buildCache.map(item => item.id).sort()), 'Unselected private cache identities changed during lifecycle-only verification');
  report.observations.finalState = { runtime: finalRuntime, engine: finalEngine, ...finalState };
  check('same real engine and owned registration reconnect; containers, images and private build caches are preserved');
  requireFact(exceptions.length === 0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  check('no unhandled renderer exceptions');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  report.checks.push({ name: 'halt at the first failed recovery criterion', passed: false, error: error.message });
  try { report.screenshots.push(await screenshot('failure')); } catch {}
  process.exitCode = 1;
} finally {
  if (previousImageFilter !== null) {
    try {
      await evaluate(`(() => { const input = document.querySelector('main [data-page="Images"] input[placeholder^="로컬 이미지"]'); if (input) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(previousImageFilter)}); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    } catch (restoreError) { report.filterRestoreFailure = String(restoreError); }
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ completed: report.completed, checks: report.checks, report: reportPath, failure: report.failure }));
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Verification ended')); }
  socket.close();
}
