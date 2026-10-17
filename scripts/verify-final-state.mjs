import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [portFile] = process.argv.slice(2);
if (!portFile) throw new Error('Provide the actual native WebView port file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback port');
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(item => item.type === 'page' && item.url === 'http://tauri.localhost/');
if (!page || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.webSocketDebuggerUrl).hostname)) throw new Error('Actual local DockSlate window is required');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let counter = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Final native verification timed out')); }, 180000);
  pending.set(id, { timer, resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const readOnlyCommands = new Set(['runtime_status', 'engine_status', 'disk_usage', 'overview', 'wsl_inventory', 'wsl_preview']);
const invoke = (command, args = {}) => {
  if (!readOnlyCommands.has(command)) throw new Error('Final-state verification permits read-only backend commands only');
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
};
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const report = { observedAt: new Date().toISOString(), mode: 'actual final EXE; read-only engine/disk/CLI comparison and native UI', mutationExecuted: false, checks: [], completed: false };
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const waitFor = async query => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { if (await query()) return; await new Promise(resolve => setTimeout(resolve, 300)); }
  throw new Error('Final native UI did not reflect the actual backend state');
};
const capture = async name => {
  const value = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join('.analysis', `${name}.png`), Buffer.from(value.data, 'base64'));
};
const approxBytes = text => {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB)$/.exec(text.trim());
  requireFact(match, `Unrecognized decimal byte size: ${text}`);
  const unit = { B: 1, kB: 1000, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2]];
  const decimals = match[1].split('.')[1]?.length ?? 0;
  return { bytes: Number(match[1]) * unit, tolerance: unit / 10 ** decimals / 2 + 1 };
};
const assertDisplayedBytes = (text, measured, description) => {
  requireFact(Number.isSafeInteger(measured) && measured >= 0, `No actual byte measurement for ${description}`);
  const displayed = approxBytes(text);
  requireFact(Math.abs(displayed.bytes - measured) <= displayed.tolerance, `${description} does not match measured decimal bytes: ${text} vs ${measured}`);
  return { text, measuredBytes: measured, ...displayed };
};
const activePage = 'document.querySelector("main [data-page]:not([hidden])")';
const diskPanel = `${activePage}?.querySelector('[data-tab="wsl"]:not([hidden])')`;
let ownDiskExpression = null;
let openedPreparation = false;
let openedStopDialog = false;
try {
  await send('Page.enable');
  requireFact(!await evaluate('!!document.querySelector("[role=dialog]")'), 'An existing user dialog must be completed before read-only native verification');
  const runtime = await invoke('runtime_status');
  const engine = await invoke('engine_status');
  report.runtime = runtime; report.engine = engine;
  requireFact(runtime.state === 'running' && runtime.keeperVerified && runtime.installPath === 'D:\\Program Files\\DockSlate\\runtime\\wsl', 'Owned D-drive runtime is not verified and running');
  requireFact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby' && engine.ownerPath === runtime.installPath, 'Independent engine is not connected');
  check('final EXE connects to the owned D-drive Moby engine without Docker Desktop');
  const cli = promisify(execFile);
  const base = ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock'];
  const program = path.join(process.env.SystemRoot, 'System32', 'wsl.exe');
  const info = JSON.parse((await cli(program, [...base, 'info', '--format', '{{json .}}'], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 })).stdout);
  const before = JSON.parse(fs.readFileSync('docs/results/independent-engine-e2e-before-desktop-removal.json', 'utf8'));
  requireFact(info.ID === before.observations.engineIdentity && info.OSType === 'linux' && !/Docker Desktop/i.test(info.OperatingSystem), 'Engine identity changed after Desktop removal and app relaunch');
  report.engineId = info.ID;
  check('same real engine identity survives Desktop removal and final app relaunch');
  const usage = await invoke('disk_usage');
  const overview = await invoke('overview');
  const rows = (await cli(program, [...base, 'system', 'df', '--format', '{{json .}}'], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 })).stdout.trim().split(/\r?\n/).filter(Boolean).map(value => JSON.parse(value));
  report.usage = usage; report.overview = overview; report.dockerCliDf = rows;
  for (const [type, key] of [['Images', 'imagesBytes'], ['Containers', 'containersBytes'], ['Local Volumes', 'volumesBytes'], ['Build Cache', 'buildCacheBytes']]) {
    const row = rows.find(value => value.Type === type);
    requireFact(row && Number.isSafeInteger(usage[key]) && usage[key] >= 0, `Usage is unknown for a measured ${type} category`);
    const expected = approxBytes(row.Size);
    requireFact(Math.abs(usage[key] - expected.bytes) <= expected.tolerance, `Actual API/CLI ${type} usage differs: ${usage[key]} vs ${row.Size}`);
  }
  const activeContainers = info.ContainersRunning + info.ContainersPaused;
  requireFact(overview.images === info.Images && overview.containersRunning === activeContainers && overview.containersStopped === info.Containers - activeContainers && Number.isSafeInteger(overview.dockerBytes), 'Final Overview counts differ from the real Docker CLI inventory or measured Docker total is invalid');
  check('all four real usage categories match Docker CLI, including omitted-zero fields');
  const wsl = await invoke('wsl_inventory'); report.wsl = wsl;
  const disk = wsl.disks.find(value => value.owner === 'DockSlate' && value.distribution === 'DockSlate');
  requireFact(disk?.exists && disk.fileSizeBytes > 0 && disk.path.replace(/^\\\\\?\\/, '').startsWith(runtime.installPath + '\\'), 'Own registered VHDX path or actual size is missing');
  requireFact(disk.compactionStatus === 'blocked' && disk.blockedReasons.length > 0, 'Unsafe running VHDX compaction is not blocked');
  requireFact(!wsl.disks.some(value => value.owner === 'Docker Desktop'), 'Removed Docker Desktop disk remains in inventory');
  check('only actual owned D-drive VHDX is reported and unsafe compaction remains blocked');
  await evaluate("[...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'Overview').click()");
  await waitFor(() => evaluate(`[...${activePage}.querySelectorAll('button')].some(button => button.textContent.trim() === '전체 새로고침' && !button.disabled)`));
  await evaluate(`[...${activePage}.querySelectorAll('button')].find(button => button.textContent.trim() === '전체 새로고침').click()`);
  await waitFor(() => evaluate("document.querySelectorAll('main [data-page]:not([hidden]) .metric-value').length === 4 && document.querySelectorAll('main [data-page]:not([hidden]) .metric-value')[2].textContent !== '미확인' && document.querySelector('main [data-page]:not([hidden])').innerText.includes('Connected')"));
  await waitFor(() => evaluate(`[...${activePage}.querySelectorAll('button')].some(button => button.textContent.trim() === '전체 새로고침' && !button.disabled)`));
  report.metricTexts = await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) .metric-value')].map(value => value.textContent)");
  await capture('final-independent-overview');
  check('final real Overview displays connected state and measured usage');
  requireFact(await evaluate(`${activePage}.innerText.includes('MB / GB (1,000 기준)')`), 'Overview does not explain the decimal unit basis');
  report.displayedBytes = {
    dockerUsage: assertDisplayedBytes(report.metricTexts[2], overview.dockerBytes, 'Overview Docker usage'),
    reclaimable: assertDisplayedBytes(report.metricTexts[3], overview.reclaimableBytes, 'Overview cleanup estimate')
  };
  check('visible Overview usage and cleanup estimate match actual decimal bytes');
  await evaluate(`(() => {
    const button = [...${activePage}.querySelectorAll('button')].find(item => item.textContent.trim() === '정리 대상 보기');
    if (!button || button.disabled) throw new Error('Overview cleanup shortcut is unavailable');
    button.click();
  })()`);
  await waitFor(() => evaluate(`${activePage}?.getAttribute('data-page') === 'Disk Manager' && !!${activePage}.querySelector('[data-tab="docker"]:not([hidden])') && [...${activePage}.querySelectorAll('[role="tab"]')].some(tab => tab.textContent.trim() === 'Docker Usage' && tab.getAttribute('aria-selected') === 'true')`));
  check('Overview cleanup shortcut opens the actual Docker Usage panel');
  await evaluate(`[...${activePage}.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.trim() === 'WSL Disks').click()`);
  ownDiskExpression = `[...(${diskPanel}?.querySelectorAll('.disk-card') ?? [])].find(card => card.querySelector('.disk-path code')?.textContent === ${JSON.stringify(disk.path)})`;
  await waitFor(() => evaluate(`!!(${ownDiskExpression})`));
  const diskSizeText = await evaluate(`(${ownDiskExpression}).querySelector('.disk-properties strong').textContent`);
  const measuredFileSize = fs.statSync(disk.path).size;
  report.displayedBytes.vhdx = assertDisplayedBytes(diskSizeText, measuredFileSize, 'Actual owned VHDX file size');
  check('visible WSL disk size matches the actual file using decimal units');
  if (!await evaluate(`!!(${ownDiskExpression}).querySelector('.disk-inspection')`)) {
    await evaluate(`(() => {
      const button = [...(${ownDiskExpression}).querySelectorAll('button')].find(item => item.textContent.trim() === '압축 준비 및 검사');
      if (!button || button.disabled) throw new Error('Owned VHDX preparation action is unavailable');
      button.click();
    })()`);
    openedPreparation = true;
  }
  await waitFor(() => evaluate(`!!(${ownDiskExpression}).querySelector('.disk-inspection')`));
  const preparation = await evaluate(`(() => {
    const card = (${ownDiskExpression});
    const stop = [...card.querySelectorAll('button')].find(button => button.textContent.trim() === 'DockSlate 엔진 중지…');
    const compact = [...card.querySelectorAll('button')].find(button => button.textContent.trim() === '압축…');
    return { text: card.innerText, stopAvailable: !!stop && !stop.disabled, compactionDisabled: !!compact && compact.disabled,
      inputCount: card.querySelectorAll('input:not([type=checkbox])').length };
  })()`);
  report.preparation = preparation;
  requireFact(preparation.inputCount === 0 && preparation.text.includes('백업 파일 없이 원본 VHDX를 압축합니다') && preparation.text.includes('관리자 권한과 디스크 지원 확인') && preparation.text.includes('Get-DiskImage·Get-VHD·Optimize-VHD'), 'Preparation must require no backup path while explaining administrator rights and disk support');
  requireFact(preparation.stopAvailable && preparation.compactionDisabled, 'Owned engine stop approval is unavailable or unsafe compaction is enabled');
  await capture('final-independent-vhdx-preparation');
  check('VHDX preparation has no backup input and retains owned-engine stop, administrator and disk checks');
  const preview = await invoke('wsl_preview', { diskId: disk.id });
  report.backupFreePreview = preview;
  requireFact(preview.requiresBackup === false && preview.eligible === false && preview.token === null && !preview.blockedReasons.some(reason => /backup/i.test(reason)) && !preview.checks.some(check => check.name === 'verifiedBackup'), 'Read-only disk preview still requires a backup or bypasses running/admin protection');
  check('actual backup-free disk preview preserves runtime/elevation safety and issues no compaction token');
  await evaluate(`[...(${ownDiskExpression}).querySelectorAll('button')].find(button => button.textContent.trim() === 'DockSlate 엔진 중지…').click()`);
  openedStopDialog = true;
  await waitFor(() => evaluate(`document.querySelector('[role="dialog"]')?.innerText.includes('DockSlate 런타임 중지 확인')`));
  const approval = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent.includes('중지 승인 및 실행'));
    return { text: dialog.innerText, acknowledged: dialog.querySelector('input[type="checkbox"]')?.checked,
      executionDisabled: !!confirm && confirm.disabled };
  })()`);
  report.stopApproval = approval;
  requireFact(approval.acknowledged === false && approval.executionDisabled && approval.text.includes('서비스가 중단됩니다'), 'Stop approval lacks an explicit disabled-until-approved impact confirmation');
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button => button.textContent.trim() === '취소').click()`);
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`));
  openedStopDialog = false;
  const afterCancel = await invoke('runtime_status');
  report.runtimeAfterCancel = afterCancel;
  requireFact(afterCancel.state === 'running' && afterCancel.keeperVerified && afterCancel.installPath === runtime.installPath, 'Canceling the stop approval changed the owned running runtime');
  requireFact(await evaluate(`[...(${ownDiskExpression}).querySelectorAll('button')].find(button => button.textContent.trim() === '압축…')?.disabled === true`), 'Compaction became enabled after canceling the stop approval');
  check('canceling VHDX preparation stop approval leaves the real engine running and compaction blocked');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  console.log(JSON.stringify({ completed: false, failure: String(error) }));
} finally {
  try {
    if (openedStopDialog) {
      await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); const cancel = dialog && [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === '취소'); if (cancel && !cancel.disabled) cancel.click(); })()`);
    }
    if (openedPreparation && ownDiskExpression) {
      await evaluate(`(() => { const card = (${ownDiskExpression}); const close = card && [...card.querySelectorAll('button')].find(button => button.textContent.trim() === '준비 패널 닫기'); if (close && !close.disabled) close.click(); })()`);
    }
    await evaluate("[...document.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'Overview')?.click()");
  } catch (restoreError) {
    report.restoreFailure = String(restoreError); report.completed = false; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync('docs/results/final-native-state-verification.json', JSON.stringify(report, null, 2));
  socket.close();
}
