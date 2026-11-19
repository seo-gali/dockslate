import fs from 'node:fs';
import { connectNative, pause, waitFor } from './native-verification.mjs';

const native = await connectNative(process.argv[2]);
const { evaluate, send, nav, calls, setInput, exceptions } = native;
const pages = ['Overview', 'Containers', 'Images', 'Resources', 'Builds', 'Disk Manager', 'Settings'];
const individualReads = ['engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory', 'volumes_list', 'networks_list'];
const refreshButton = '.app-topbar button[data-tooltip]';
const dockerPanel = '[data-page="Disk Manager"] [data-tab="docker"]';
const serialCalls = values => values.map(({command, observedAt, finishedAt, durationMs, failed}) => ({command, observedAt, finishedAt, durationMs, failed}));
const tab = async label => {
  await evaluate(`(()=>{const button=[...document.querySelectorAll('main [data-page]:not([hidden]) [role=tab]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Tab unavailable');button.click()})()`);
  await waitFor('selected tab', () => evaluate(`document.querySelector('main [data-page]:not([hidden]) [role=tab][aria-selected=true]')?.textContent.trim()===${JSON.stringify(label)}`));
};
const report = { observedAt: new Date().toISOString(), target: 'Actual built Windows WebView2 with an already running owned engine; English UI and quiet engine required', mockData: false, completed: false, checks: [], refreshes: [], exceptions };
const requireFact = (value, message) => { if (!value) throw Error(message); };
const check = name => report.checks.push({ name, passed: true });
const state = () => evaluate(`(() => {
  const get = name => document.querySelector('[data-page="'+name+'"]');
  return {
    page: document.querySelector('main [data-page]:not([hidden])')?.getAttribute('data-page'),
    busy: document.querySelector('${refreshButton}')?.disabled,
    overview: [...get('Overview').querySelectorAll('.metric-value')].map(e=>e.textContent.trim()),
    docker: [...get('Disk Manager').querySelectorAll('[data-tab="docker"] .metric-value')].map(e=>e.textContent.trim()),
    filters: ['Containers','Images'].map(name=>get(name).querySelector('input[type=search]')?.value),
    status: get('Containers').querySelector('.table-filter')?.value,
    disks: [...get('Disk Manager').querySelectorAll('.disk-card')].map(card=>({path:card.querySelector('.disk-path code')?.textContent.trim(),size:card.querySelector('.disk-properties > div:first-child strong')?.textContent.trim()}))
  };
})()`);
const tabs = () => evaluate(`['Images','Resources','Builds','Disk Manager','Settings'].map(name=>document.querySelector('[data-page="'+name+'"] [role=tab][aria-selected=true]')?.textContent.trim())`);
const finishReads = start => calls.slice(start).filter(call => ['dashboard_snapshot', 'builds_snapshot', 'containers_metrics', 'docker_events_snapshot'].includes(call.command)).every(call => call.durationMs != null);
const responseBodies = new Map();
native.onEvent(message => {
  if (message.method !== 'Network.loadingFinished') return;
  const call = calls.findLast(call => call.requestId === message.params.requestId);
  if (call?.command !== 'dashboard_snapshot') return;
  responseBodies.set(call.requestId, send('Network.getResponseBody', { requestId: call.requestId }).then(result => {
    let value = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
    for (let i = 0; i < 2 && typeof value === 'string'; i++) value = JSON.parse(value);
    return { value };
  }).catch(error => ({ error: error.message })));
});
try {
  requireFact(await evaluate(`document.documentElement.lang==='en'`), 'Select English before this verification');
  const engine = await native.invoke('engine_status');
  requireFact(engine.state === 'connected' && engine.engine === 'moby' && engine.context === 'dockslate' && engine.ownerPath, 'A running verified DockSlate Moby engine is required');
  await waitFor('calibration read complete', () => calls.some(call => call.command === 'engine_status' && call.durationMs != null));
  const startup = calls.length;
  await send('Page.reload');
  await waitFor('initial shared snapshot', async () => (await state()).overview.length === 4 && !(await state()).busy && finishReads(startup));
  const startupCalls = calls.slice(startup);
  requireFact(startupCalls.filter(call => call.command === 'dashboard_snapshot').length === 1 && !startupCalls.some(call => individualReads.includes(call.command)), 'Startup must use one shared snapshot without individual reads');
  check('Startup performs one shared dashboard read');
  for (const page of pages) {
    await nav(page);
    await waitFor(`lazy ${page}`, () => evaluate(`!!document.querySelector('main [data-page]:not([hidden]) h1')`));
  }
  requireFact(await evaluate(`${JSON.stringify(pages)}.every(name=>!!document.querySelector('main [data-page="'+name+'"]'))`), 'Required menu pages missing');
  await setInput('[data-page="Containers"] input[type=search]', 'dockslate-retained-container');
  await setInput('[data-page="Images"] input[type=search]', 'dockslate-retained-image');
  const retained = await state(), retainedTabs = await tabs();
  const navigation = calls.length;
  for (let round = 0; round < 3; round++) for (const page of pages) await nav(page);
  await pause(6500);
  requireFact(!calls.slice(navigation).some(call => [...individualReads, 'dashboard_snapshot', 'builds_snapshot'].includes(call.command)), 'Navigation or idle time issued redundant data reads');
  requireFact(JSON.stringify((await state()).filters) === JSON.stringify(retained.filters) && JSON.stringify(await tabs()) === JSON.stringify(retainedTabs), 'Navigation lost local input or tab state');
  check('Seven menus preserve input and tabs without redundant reads during three round trips and idle');
  let finalSnapshot;
  for (const page of ['Images', 'Overview', 'Disk Manager', 'Settings']) {
    await nav(page);
    const before = await state(), start = calls.length;
    const firstFrame = await evaluate(`new Promise(resolve=>{document.querySelector('${refreshButton}').click();requestAnimationFrame(()=>resolve({busy:document.querySelector('${refreshButton}').disabled,values:[...document.querySelectorAll('[data-page="Overview"] .metric-value')].map(e=>e.textContent.trim())}))})`);
    requireFact((firstFrame.busy || calls.slice(start).some(call => call.command === 'dashboard_snapshot' && call.durationMs != null)) && JSON.stringify(firstFrame.values) === JSON.stringify(before.overview), 'Refresh must retain existing values while the request is pending');
    await waitFor('one full refresh completed', async () => calls.slice(start).some(call => call.command === 'dashboard_snapshot' && call.durationMs != null) && !(await state()).busy && finishReads(start));
    const phase = calls.slice(start), snapshots = phase.filter(call => call.command === 'dashboard_snapshot');
    const after = await state();
    requireFact(snapshots.length === 1 && !phase.some(call => individualReads.includes(call.command)), 'Refresh duplicated snapshot or individual reads');
    requireFact(after.page === page && after.status === before.status && JSON.stringify(after.filters) === JSON.stringify(before.filters) && JSON.stringify(await tabs()) === JSON.stringify(retainedTabs), 'Refresh lost selection or local state');
    const body = await responseBodies.get(snapshots[0].requestId);
    requireFact(body?.value && !body.error, 'Actual snapshot response body unavailable');
    finalSnapshot = body.value;
    report.refreshes.push({ page, calls: phase.map(({command, durationMs, failed}) => ({command, durationMs, failed})), retainedData: true });
  }
  check('Global refresh from four menus preserves current data and local state with one snapshot each');
  const overview = finalSnapshot.overview?.Ok, usage = finalSnapshot.disk_usage?.Ok, inventory = finalSnapshot.wsl_inventory?.Ok;
  requireFact(overview && usage && inventory, 'Actual snapshot has failed overview, usage or disk results');
  const bytes = value => {
    if (value == null || !Number.isFinite(value)) return 'Unknown';
    if (Math.abs(value) < 1000) return value.toLocaleString('en-US') + ' B';
    const index = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1000)), 4);
    return (value / 1000 ** index).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' ' + ['B','KB','MB','GB','TB'][index];
  };
  const actual = await state();
  const expected = {
    overview: [overview.containersRunning.toLocaleString('en-US'), overview.images.toLocaleString('en-US'), bytes(overview.dockerBytes), bytes(overview.reclaimableBytes)],
    docker: [usage.imagesBytes, usage.buildCacheBytes, usage.containersBytes, usage.volumesBytes].map(bytes),
    disks: inventory.disks.map(disk=>({path:disk.path ?? 'Unknown',size:disk.exists ? bytes(disk.fileSizeBytes) : 'No files'})),
  };
  requireFact(JSON.stringify({overview:actual.overview,docker:actual.docker,disks:actual.disks}) === JSON.stringify(expected), 'Visible overview, Docker usage or VHDX values disagree with the actual snapshot');
  report.comparison = {expected, actual:{overview:actual.overview,docker:actual.docker,disks:actual.disks}};
  check('Overview, Docker usage and VHDX values match the returned backend snapshot');
  await setInput('[data-page="Containers"] input[type=search]', '');
  await setInput('[data-page="Images"] input[type=search]', '');
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
  await nav('Overview');
  const mutations = ['container_action','containers_action','image_pull','image_removal_execute','destructive_execute','network_create','network_delete_execute','volume_create','volume_execute','runtime_start','runtime_stop','runtime_install','wsl_shutdown','wsl_compact','startup_set'];
  requireFact(!calls.some(call => mutations.includes(call.command)), 'Read-only verification executed a mutation');
  requireFact(!exceptions.length, 'Unhandled renderer exception');
  check('No native mutations or renderer exceptions');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.untested = ['Native paint timing', 'Docker changes and VHDX operations'];
  fs.writeFileSync(process.argv[3] ?? 'docs/results/global-refresh-e2e.json', JSON.stringify(report, null, 2));
  native.close(); console.log(JSON.stringify(report));
}
