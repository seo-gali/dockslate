import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const [portFile, approval, expectedEngineId, mode] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile || approval !== '--approved-isolated-fixtures' || !expectedEngineId || (mode && mode !== '--advanced')) throw new Error('Usage: node scripts/verify-image-run.mjs WEBVIEW_PORT_FILE --approved-isolated-fixtures EXPECTED_ENGINE_ID [--advanced]');
const advanced = mode === '--advanced';
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Actual local DockSlate window required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const pending = new Map(), requests = new Map(), calls = [], exceptions = [];
let sequence = 0;
const dataCommands = ['dashboard_snapshot', 'engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory', 'image_search', 'networks_list'];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120000);
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
      if (['container_run', 'network_create'].includes(call.command) && !call.failed) call.bodyRead = send('Network.getResponseBody', { requestId: call.requestId }).then(response => {
        let value = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        for (let count = 0; count < 2 && typeof value === 'string'; count += 1) { try { value = JSON.parse(value); } catch { break; } }
        if (value && typeof value === 'object' && typeof value.id === 'string') call.result = value;
      }).catch(error => { call.responseReadError = error.message; });
      requests.delete(call.requestId);
    }
  }
  const request = pending.get(message.id); if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.value ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result.value;
};
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (description, query, timeout = 120000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await query(); if (value) return value; await pause(150); } throw new Error(`Timed out: ${description}`); };
const serialCalls = values => values.map(({ command, observedAt, finishedAt, durationMs, failed, responseReadError }) => ({ command, observedAt, finishedAt, durationMs, failed, responseReadError }));
const counts = values => Object.fromEntries([...dataCommands, 'image_details', 'container_run', 'network_create', 'container_logs', 'destructive_preview', 'destructive_execute'].map(command => [command, values.filter(item => item.command === command).length]));
const activePage = 'main [data-page]:not([hidden])';
const runSection = `${activePage} section[aria-label="컨테이너 실행"]`;
const nav = async name => {
  await evaluate(`(()=>{const button=[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim()===${JSON.stringify(name)});if(!button||button.disabled)throw new Error('Navigation unavailable');button.click();})()`);
  await waitFor(`active ${name}`, () => evaluate(`document.querySelector('${activePage}')?.getAttribute('data-page')===${JSON.stringify(name)}`));
};
const setInput = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled)throw new Error('Input unavailable');const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const setSelect = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled||![...input.options].some(option=>option.value===${JSON.stringify(value)}))throw new Error('Select unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
const fixtureName = `dockslate-e2e-run-${Date.now()}`;
const fixtureNetworkName = `${fixtureName}-net`;
const advancedOptions = { env: [`DOCKSLATE_E2E_MARKER=${fixtureName}`, 'DOCKSLATE_LITERAL=spaces ; $(literal)'], command: ['/hello'], entrypoint: ['/hello'], workingDir: '/dockslate-e2e', restartPolicy: 'on-failure', memoryBytes: 64_000_000, nanoCpus: 500_000_000 };
const fixtureRoot = path.resolve('.analysis', fixtureName);
const reportFile = advanced ? 'docs/results/image-run-advanced-e2e.json' : 'docs/results/image-run-e2e.json';
const report = {
  observedAt: new Date().toISOString(), target: 'actual built Windows DockSlate native window and its verified owned running Moby engine', mockData: false, explicitIsolatedFixtureApproval: true,
  fixture: { name: fixtureName, root: fixtureRoot, expectedEngineId, advanced, networkName: advanced ? fixtureNetworkName : null }, checks: [], observations: {}, screenshots: [], completed: false, failure: null,
  failureConditions: ['Wrong or changed engine ownership or engine ID', 'Existing hello-world image missing or declares volumes or a different default command', 'Invalid input creates a container or network', 'Any original image/tag/container/cache/network ID changes', 'Created fixture uses another image, does not exit successfully or lacks actual Hello from Docker logs', 'UI does not navigate to the created container with logs and coherent shared data', 'Advanced settings differ from actual Docker configuration', 'Cleanup selection contains a preexisting, running or unverified container/network'],
  failurePolicy: 'Record failure before any best-effort cleanup. Delete only an exact newly created and verified stopped fixture container and, in advanced mode, its exact empty local bridge network with unchanged engine identity and preserved baseline. Never stop containers, change runtime state, pull, prune, remove images or compact disks.',
  untested: ['Long-running images', 'Published port connectivity', 'Create succeeds but start fails', 'WSL lifecycle changes', 'Real disk compaction']
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const writeReport = () => { fs.mkdirSync('docs/results', { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); };
const screenshot = async name => { const value = await send('Page.captureScreenshot', { format: 'png' }); const file = path.join(fixtureRoot, `${name}.png`); fs.writeFileSync(file, Buffer.from(value.data, 'base64')); report.screenshots.push(file); };
let owned = null, baseline = null, fixtureImage = null, fixtureContainerId = null, fixtureNetworkId = null, networkVerifiedForRemoval = null, mutationSubmitted = false, cleanupDone = false;
const imageIdentities = images => images.map(image => ({ id: image.id, tags: [...image.tags].sort() })).sort((a, b) => a.id.localeCompare(b.id));
const containerIdentities = containers => containers.map(container => ({ id: container.id, name: container.name, image: container.image, state: container.state })).sort((a, b) => a.id.localeCompare(b.id));
const cacheIds = usage => usage.buildCache.map(item => item.id).sort();
const networkIdentities = networks => networks.map(network => ({ id: network.ID, name: network.Name, driver: network.Driver, scope: network.Scope })).sort((a, b) => a.id.localeCompare(b.id));
const execFileAsync = promisify(execFile);
const assertOwned = async () => {
  const runtime = await invoke('runtime_status'), engine = await invoke('engine_status');
  requireFact(runtime.state === 'running' && runtime.distribution === 'DockSlate' && runtime.keeperVerified === true && runtime.installPath && runtime.blockedReasons.length === 0, 'Verified running owned DockSlate runtime required');
  requireFact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby' && engine.ownerPath === runtime.installPath && engine.endpoint === 'wsl://DockSlate/var/run/docker.sock', 'Independent owned Moby connection required');
  const markerFile = path.join(path.dirname(runtime.installPath), 'ownership.json'), stat = fs.lstatSync(markerFile);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size < 131072, 'Verified regular ownership marker required');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, ''));
  requireFact(marker.owner === 'DockSlate' && marker.state === 'installed' && marker.distribution === 'DockSlate' && marker.installPath === runtime.installPath && marker.installId && marker.registrationId, 'Ownership marker mismatch');
  const fingerprint = JSON.stringify([marker.installId, marker.registrationId, marker.rootfsSha256, runtime.installPath]);
  if (owned === null) owned = fingerprint;
  requireFact(owned === fingerprint, 'Owned runtime identity changed');
  return { runtime, engine };
};
const guest = async (kind, reference) => {
  await assertOwned();
  let args;
  if (kind === 'identity') args = ['info', '--format', '{{.ID}}'];
  else if (kind === 'image-inspect') { requireFact(reference === fixtureImage?.id, 'Only the selected existing hello-world image may be inspected'); args = ['image', 'inspect', reference]; }
  else if (kind === 'container-inspect' || kind === 'container-logs') { requireFact(reference === fixtureContainerId && /^[a-f0-9]{64}$/.test(reference ?? ''), 'Only the exact new fixture container may be read'); args = kind === 'container-inspect' ? ['container', 'inspect', reference] : ['container', 'logs', '--timestamps', reference]; }
  else if (kind === 'network-list') args = ['network', 'ls', '--no-trunc', '--format', '{{json .}}'];
  else if (kind === 'network-inspect') { requireFact(reference === fixtureNetworkId && /^[a-f0-9]{64}$/.test(reference ?? ''), 'Only the exact new fixture network may be inspected'); args = ['network', 'inspect', reference]; }
  else if (kind === 'network-remove') { requireFact(reference === fixtureNetworkId && reference === networkVerifiedForRemoval && /^[a-f0-9]{64}$/.test(reference ?? '') && !baseline.networks.some(network => network.ID === reference), 'Only the exact empty verified new fixture network may be removed'); args = ['network', 'rm', reference]; }
  else throw new Error('Unsupported guest command');
  const result = await execFileAsync(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  return result.stdout;
};
const assertEngineIdentity = async () => requireFact((await guest('identity')).trim() === expectedEngineId, 'Actual owned engine ID differs from expected identity');
const readNetworks = async () => (await guest('network-list')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const readState = async () => ({ images: await invoke('images_list'), containers: await invoke('containers_list'), usage: await invoke('disk_usage'), overview: await invoke('overview'), ...(advanced ? { networks: await readNetworks() } : {}) });
const assertBaselinePreserved = (state, allowFixture) => {
  requireFact(JSON.stringify(imageIdentities(state.images)) === JSON.stringify(imageIdentities(baseline.images)), 'A preexisting image ID or tag changed');
  const containers = allowFixture ? state.containers.filter(container => container.id !== fixtureContainerId) : state.containers;
  requireFact(JSON.stringify(containerIdentities(containers)) === JSON.stringify(containerIdentities(baseline.containers)), 'A preexisting container ID, image or state changed');
  requireFact(JSON.stringify(cacheIds(state.usage)) === JSON.stringify(cacheIds(baseline.usage)), 'Build cache IDs changed during container execution');
  requireFact(state.usage.volumesBytes === baseline.usage.volumesBytes, 'Volume usage changed during the volume-free fixture run');
  if (advanced) requireFact(JSON.stringify(networkIdentities(state.networks.filter(network => network.ID !== fixtureNetworkId))) === JSON.stringify(networkIdentities(baseline.networks)), 'A preexisting network identity changed or an unrelated network appeared');
};
const discoverFixture = async () => {
  const containers = await invoke('containers_list');
  const matches = containers.filter(container => container.name === fixtureName);
  requireFact(matches.length <= 1, 'More than one exact fixture container name found');
  if (matches.length === 1) {
    const fixture = matches[0]; requireFact(/^[a-f0-9]{64}$/.test(fixture.id) && !baseline.containers.some(old => old.id === fixture.id), 'Fixture container identity overlaps baseline');
    if (fixtureContainerId) requireFact(fixtureContainerId === fixture.id, 'Fixture container ID changed');
    fixtureContainerId = fixture.id;
  }
  return matches[0] ?? null;
};
const cleanupFixture = async () => {
  await assertEngineIdentity();
  const fixture = await discoverFixture();
  let containerCleanup = { absent: true };
  if (fixture) {
    requireFact(['exited', 'created', 'dead'].includes(fixture.state), 'Fixture is not stopped; cleanup will not stop or force-delete it');
    const state = await readState(); assertBaselinePreserved(state, true);
    const inspected = JSON.parse(await guest('container-inspect', fixtureContainerId));
    requireFact(inspected.length === 1 && inspected[0].Id === fixtureContainerId && inspected[0].Name === `/${fixtureName}` && inspected[0].Image === fixtureImage.id && inspected[0].State?.Running === false, 'Exact stopped fixture name, ID and image must match before cleanup');
    const preview = await invoke('destructive_preview', { request: { kind: 'container_delete', ids: [fixtureContainerId] } });
    requireFact(preview.kind === 'container_delete' && preview.targets.length === 1 && preview.targets[0] === fixtureContainerId && preview.token && preview.expiresAt > Date.now(), 'Cleanup preview is not restricted to the exact new stopped fixture');
    const removed = await invoke('destructive_execute', { token: preview.token, approved: true });
    requireFact(removed.failed.length === 0 && removed.deleted.length === 1 && removed.deleted[0] === fixtureContainerId, 'Exact stopped fixture cleanup failed');
    containerCleanup = { target: fixtureContainerId, impact: preview.impact, result: removed };
  }
  let networkCleanup = null;
  if (advanced) {
    const networks = await readNetworks(), matches = networks.filter(network => network.Name === fixtureNetworkName);
    requireFact(matches.length <= 1, 'More than one exact fixture network name found');
    if (matches.length === 1) {
      const id = matches[0].ID; requireFact(/^[a-f0-9]{64}$/.test(id) && !baseline.networks.some(network => network.ID === id) && (!fixtureNetworkId || fixtureNetworkId === id), 'Fixture network ID changed or overlaps baseline'); fixtureNetworkId = id;
      assertBaselinePreserved(await readState(), false); await assertEngineIdentity();
      const inspected = JSON.parse(await guest('network-inspect', fixtureNetworkId)), network = inspected[0];
      requireFact(inspected.length === 1 && network.Id === fixtureNetworkId && network.Name === fixtureNetworkName && network.Driver === 'bridge' && network.Scope === 'local' && network.ConfigOnly === false && Object.keys(network.Containers ?? {}).length === 0, 'Fixture network identity, bridge scope or zero-endpoint check failed before exact removal');
      networkVerifiedForRemoval = fixtureNetworkId;
      networkCleanup = { target: fixtureNetworkId, name: fixtureNetworkName, endpoints: Object.keys(network.Containers ?? {}), command: 'docker network rm <verified exact newly created fixture ID>', output: (await guest('network-remove', fixtureNetworkId)).trim() };
      networkVerifiedForRemoval = null;
    } else networkCleanup = { absent: true };
  }
  const after = await readState(); assertBaselinePreserved(after, false);
  requireFact(!after.containers.some(container => container.id === fixtureContainerId), 'Fixture remains after cleanup');
  if (advanced) requireFact(!after.networks.some(network => network.ID === fixtureNetworkId), 'Fixture network remains after exact cleanup');
  cleanupDone = true;
  return { container: containerCleanup, network: networkCleanup, remainingImages: imageIdentities(after.images), remainingContainers: containerIdentities(after.containers), preservedCacheIds: cacheIds(after.usage), ...(advanced ? { remainingNetworks: networkIdentities(after.networks) } : {}) };
};

try {
  requireFact(!fs.existsSync(fixtureRoot), 'Fixture evidence directory already exists'); fs.mkdirSync(fixtureRoot, { recursive: true });
  const artifact = path.resolve('src-tauri/target/release/dockslate.exe'), artifactStat = fs.statSync(artifact);
  report.artifact = { path: artifact, bytes: artifactStat.size, modifiedAt: artifactStat.mtime.toISOString(), sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const verified = await assertOwned(); await assertEngineIdentity(); baseline = await readState(); report.observations.baseline = baseline; report.observations.ownership = { ...verified, engineId: expectedEngineId };
  requireFact(!baseline.containers.some(container => container.name === fixtureName), 'Fixture container name already exists');
  if (advanced) requireFact(!baseline.networks.some(network => network.Name === fixtureNetworkName), 'Fixture network name already exists');
  const images = baseline.images.filter(image => image.tags.includes('hello-world:latest'));
  requireFact(images.length === 1, 'Exactly one preexisting hello-world:latest image is required; verification will not pull'); fixtureImage = images[0]; report.fixture.image = fixtureImage;
  const inspectedImages = JSON.parse(await guest('image-inspect', fixtureImage.id)), inspectedImage = inspectedImages[0];
  requireFact(inspectedImages.length === 1 && inspectedImage.Id === fixtureImage.id && inspectedImage.Os === 'linux' && JSON.stringify(inspectedImage.Config?.Cmd) === JSON.stringify(['/hello']) && !(inspectedImage.Config?.Entrypoint?.length) && !Object.keys(inspectedImage.Config?.Volumes ?? {}).length, 'Existing hello-world must use /hello and declare no volumes');
  report.observations.imageConfig = { id: inspectedImage.Id, os: inspectedImage.Os, command: inspectedImage.Config.Cmd, entrypoint: inspectedImage.Config.Entrypoint, volumes: inspectedImage.Config.Volumes ?? null };
  check('verified expected owned engine identity, exact image/container/cache baseline and existing volume-free hello-world default command');

  const invalidCases = [
    { name: 'shell metacharacters in container name', args: { imageId: fixtureImage.id, name: `${fixtureName};echo invalid`, ports: [] } },
    { name: 'invalid image ID', args: { imageId: 'hello-world:latest;echo invalid', name: fixtureName, ports: [] } },
    { name: 'container port zero', args: { imageId: fixtureImage.id, name: fixtureName, ports: [{ containerPort: 0, hostPort: null, protocol: 'tcp' }] } },
    { name: 'host port out of range', args: { imageId: fixtureImage.id, name: fixtureName, ports: [{ containerPort: 80, hostPort: 65536, protocol: 'tcp' }] } },
    { name: 'duplicate container port', args: { imageId: fixtureImage.id, name: fixtureName, ports: [{ containerPort: 80, hostPort: null, protocol: 'tcp' }, { containerPort: 80, hostPort: null, protocol: 'tcp' }] } },
  ];
  if (advanced) {
    const none = baseline.networks.find(network => network.Name === 'none'); requireFact(none && /^[a-f0-9]{64}$/.test(none.ID), 'Actual built-in none network required for safe rejection verification');
    report.observations.noneNetworkId = none.ID;
    for (const [name, options] of [
      ['invalid environment key', { env: ['INVALID-KEY=value'] }], ['duplicate environment key', { env: ['DUPLICATE=one', 'DUPLICATE=two'] }],
      ['relative working directory', { workingDir: 'relative/path' }], ['memory below minimum', { memoryBytes: 1 }], ['zero CPU limit', { nanoCpus: 0 }],
      ['privileged option outside schema', { privileged: true }], ['invalid network ID', { networkId: 'bridge;echo invalid' }],
    ]) invalidCases.push({ name, args: { imageId: fixtureImage.id, name: fixtureName, ports: [], options } });
    invalidCases.push({ name: 'none network with published port', args: { imageId: fixtureImage.id, name: fixtureName, ports: [{ containerPort: 80, hostPort: null, protocol: 'tcp' }], options: { networkId: none.ID } } });
  }
  report.observations.validation = [];
  for (const test of invalidCases) {
    mutationSubmitted = true;
    const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('container_run',${JSON.stringify(test.args)}).then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}))`);
    report.observations.validation.push({ ...test, result }); requireFact(result.rejected && result.error.length > 0, `Invalid input was accepted: ${test.name}`);
  }
  assertBaselinePreserved(await readState(), false);
  check('invalid name, image ID, zero/out-of-range and duplicate ports reject before any container creation');
  if (advanced) {
    report.observations.networkValidation = [];
    for (const name of ['bridge', `${fixtureNetworkName};echo invalid`]) {
      const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('network_create',${JSON.stringify({ name, internal: true })}).then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}))`);
      report.observations.networkValidation.push({ name, result }); requireFact(result.rejected && result.error.length > 0, 'Invalid or built-in network name accepted');
    }
    requireFact(JSON.stringify(networkIdentities(await readNetworks())) === JSON.stringify(networkIdentities(baseline.networks)), 'Invalid network requests changed actual network identities');
    check('advanced invalid options, none-plus-port and built-in/injected network names reject without creating containers or networks');
  }

  await nav('Images');
  await evaluate(`(()=>{const button=document.querySelector('${runSection} button[aria-label="실행 설정 닫기"]');if(button){if(button.disabled)throw new Error('Existing image run operation is active');button.click();}return true;})()`);
  await waitFor('previous idle image run form closed', () => evaluate(`!document.querySelector('${runSection}')`));
  const label = `${fixtureImage.tags[0]} 컨테이너 실행`;
  const start = calls.length;
  await evaluate(`(()=>{const row=[...document.querySelectorAll('${activePage} tbody tr')].find(item=>item.querySelector('.cell-subtext')?.getAttribute('title')===${JSON.stringify(fixtureImage.id)});const button=[...(row?.querySelectorAll('button')??[])].find(item=>item.getAttribute('aria-label')===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Image row run action unavailable');button.click();return true;})()`);
  await waitFor('image run settings with actual image details', () => evaluate(`(()=>{const section=document.querySelector('${runSection}');const submit=section?.querySelector('form button[type="submit"]');return !!submit&&!submit.disabled&&section.innerText.includes('이미지에 설정된 기본 명령');})()`));
  await setInput(`${runSection} #run-name`, fixtureName);
  requireFact(await evaluate(`document.querySelector('${runSection} #run-container-port')?.value===''&&document.querySelector('${runSection} #run-host-port')?.value===''`), 'hello-world unexpectedly preselected a port mapping');
  await nav('Overview'); await nav('Images');
  requireFact(await evaluate(`document.querySelector('${runSection} #run-name')?.value===${JSON.stringify(fixtureName)}`), 'Menu navigation lost image run input');
  requireFact(calls.slice(start).filter(call => call.command === 'image_details').length === 1, 'Image settings were reread during menu navigation');
  if (advanced) {
    requireFact(await evaluate(`document.querySelector('${runSection} details.run-advanced')?.open===false`), 'Advanced settings must start collapsed');
    requireFact(calls.slice(start).filter(call => call.command === 'networks_list').length === 0, 'Collapsed advanced settings queried networks');
    await setInput(`${runSection} #run-container-port`, '80'); await setInput(`${runSection} #run-host-port`, '8081');
    await evaluate(`(()=>{document.querySelector('${runSection} details.run-advanced > summary').click();return true;})()`);
    await waitFor('actual network options after first advanced open', () => evaluate(`(()=>{const select=document.querySelector('${runSection} #run-network');return !!select&&!select.disabled&&[...select.options].some(option=>option.value===${JSON.stringify(report.observations.noneNetworkId)});})()`));
    await setSelect(`${runSection} #run-network`, report.observations.noneNetworkId);
    requireFact(await evaluate(`document.querySelector('${runSection} #run-container-port')?.value===''&&document.querySelector('${runSection} #run-host-port')?.value===''&&document.querySelector('${runSection} #run-container-port')?.disabled===true&&document.querySelector('${runSection} #run-host-port')?.disabled===true`), 'Selecting none did not clear and disable both published port fields');
    await setSelect(`${runSection} #run-network`, '');
    requireFact(await evaluate(`document.querySelector('${runSection} #run-container-port')?.disabled===false`), 'Restoring default bridge did not enable container port entry');
    await setInput(`${runSection} #run-env`, `${advancedOptions.env[0]}\n`);
    requireFact(await evaluate(`document.querySelector('${runSection} #run-env')?.value.endsWith(${JSON.stringify('\n')})`), 'Controlled environment textarea dropped typed newline');
    await setInput(`${runSection} #run-env`, `${advancedOptions.env.join('\n')}\n`);
    await setInput(`${runSection} #run-command`, '/hello\n'); await setInput(`${runSection} #run-entrypoint`, '/hello\n');
    await setInput(`${runSection} #run-workdir`, advancedOptions.workingDir); await setInput(`${runSection} #run-memory`, '64'); await setInput(`${runSection} #run-cpus`, '0.5'); await setSelect(`${runSection} #run-restart`, 'on-failure');
    await evaluate(`(()=>{const summary=document.querySelector('${runSection} details.run-advanced > summary');summary.click();summary.click();return true;})()`);
    await nav('Overview'); await nav('Images');
    requireFact(await evaluate(`document.querySelector('${runSection} #run-env')?.value===${JSON.stringify(`${advancedOptions.env.join('\n')}\n`)}&&document.querySelector('${runSection} #run-command')?.value===${JSON.stringify('/hello\n')}&&document.querySelector('${runSection} #run-entrypoint')?.value===${JSON.stringify('/hello\n')}&&document.querySelector('${runSection} #run-workdir')?.value===${JSON.stringify(advancedOptions.workingDir)}&&document.querySelector('${runSection} #run-memory')?.value==='64'&&document.querySelector('${runSection} #run-cpus')?.value==='0.5'&&document.querySelector('${runSection} #run-restart')?.value==='on-failure'`), 'Advanced fields or raw textarea newlines changed after navigation');
    requireFact(calls.slice(start).filter(call => call.command === 'networks_list').length === 1, 'Reopening advanced settings or navigating reread networks');
    await evaluate(`(()=>{const button=document.querySelector('${runSection} button[aria-label="네트워크 목록 새로고침"]');if(!button||button.disabled)throw new Error('Explicit network refresh unavailable');button.click();return true;})()`);
    await waitFor('explicit network refresh completed', () => evaluate(`document.querySelector('${runSection} #run-network')?.disabled===false`));
    requireFact(calls.slice(start).filter(call => call.command === 'networks_list').length === 2, 'Explicit refresh did not issue exactly one additional network read');
    check('advanced settings start collapsed, load networks once, preserve typed newlines and resource/command settings across navigation, and refresh networks only on request');

    await evaluate(`(()=>{const button=[...document.querySelectorAll('${runSection} button')].find(item=>item.textContent.trim()==='네트워크 만들기');if(!button||button.disabled)throw new Error('Network create entry unavailable');button.click();return true;})()`);
    await setInput(`${runSection} #run-network-name`, fixtureNetworkName);
    await evaluate(`(()=>{const checkbox=document.querySelector('${runSection} #run-network-internal');if(!checkbox||checkbox.disabled)throw new Error('Internal network control unavailable');if(!checkbox.checked)checkbox.click();return true;})()`);
    const networkStart = calls.length; mutationSubmitted = true;
    await evaluate(`(()=>{const button=[...document.querySelectorAll('${runSection} button')].find(item=>item.textContent.trim()==='네트워크 생성');if(!button||button.disabled)throw new Error('Network create submit unavailable');button.click();return true;})()`);
    await waitFor('created internal bridge selected in actual UI', () => evaluate(`(()=>{const select=document.querySelector('${runSection} #run-network');const option=select?.selectedOptions[0];return !!option&&option.textContent.includes(${JSON.stringify(fixtureNetworkName)})&&option.textContent.includes('내부 전용')&&!select.disabled&&!!document.querySelector('${runSection} form button[type="submit"]')&&!document.querySelector('${runSection} form button[type="submit"]').disabled;})()`));
    const networks = await invoke('networks_list'), matches = networks.filter(network => network.name === fixtureNetworkName);
    requireFact(matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].id) && !baseline.networks.some(network => network.ID === matches[0].id), 'Created network identity overlaps or differs from unique fixture'); fixtureNetworkId = matches[0].id; report.fixture.networkId = fixtureNetworkId;
    const inspected = JSON.parse(await guest('network-inspect', fixtureNetworkId)), network = inspected[0];
    requireFact(inspected.length === 1 && network.Id === fixtureNetworkId && network.Name === fixtureNetworkName && network.Driver === 'bridge' && network.Scope === 'local' && network.Internal === true && network.ConfigOnly === false && Object.keys(network.Containers ?? {}).length === 0, 'Actual newly created internal local bridge configuration mismatched');
    requireFact(calls.slice(networkStart).filter(call => call.command === 'network_create').length === 1, 'One UI network creation issued multiple creation commands');
    report.observations.createdNetwork = { network, calls: serialCalls(calls.slice(networkStart)), counts: counts(calls.slice(networkStart)) };
    check('actual UI creates and selects one unique internal local bridge network with exact inspected identity and zero initial endpoints');
  }
  await screenshot('image-row-run-settings');
  check('local image row exposes an actual run form and preserves its name and image details across menu navigation');

  const submittedAt = Date.now(), submitStart = calls.length; mutationSubmitted = true;
  await evaluate(`(()=>{const button=document.querySelector('${runSection} form button[type="submit"]');if(!button||button.disabled)throw new Error('Run submit unavailable');button.click();return true;})()`);
  await waitFor('automatic navigation to created container logs', () => evaluate(`document.querySelector('${activePage}')?.getAttribute('data-page')==='Containers'&&!!document.querySelector('${activePage} pre[aria-label="컨테이너 로그"]')`));
  const fixture = await waitFor('actual newly created exited fixture', async () => { const value = await discoverFixture(); return value && value.state === 'exited' ? value : false; });
  const uiCalls = calls.slice(submitStart); await Promise.all(uiCalls.filter(call => call.bodyRead).map(call => call.bodyRead));
  requireFact(uiCalls.filter(call => call.command === 'container_run').length === 1, 'One UI submission did not issue exactly one create/start command');
  const actualRun = uiCalls.find(call => call.command === 'container_run')?.result;
  requireFact(actualRun?.id === fixtureContainerId && actualRun.name === fixtureName && actualRun.started === true, 'Actual UI run response identity or start result mismatched');
  const inspected = JSON.parse(await guest('container-inspect', fixtureContainerId)), container = inspected[0];
  requireFact(inspected.length === 1 && container.Id === fixtureContainerId && container.Name === `/${fixtureName}` && container.Image === fixtureImage.id && container.State?.Status === 'exited' && container.State.ExitCode === 0, 'Actual created container image, identity or successful exit mismatched');
  requireFact(container.HostConfig?.Privileged === false && !container.HostConfig?.Binds?.length && !Object.keys(container.HostConfig?.PortBindings ?? {}).length && !container.Mounts?.length && !['host', 'container'].includes(container.HostConfig?.NetworkMode), 'Unexpected privilege, mount or port configuration on fixture');
  if (advanced) {
    requireFact(advancedOptions.env.every(value => container.Config?.Env?.includes(value)) && JSON.stringify(container.Config.Cmd) === JSON.stringify(advancedOptions.command) && JSON.stringify(container.Config.Entrypoint) === JSON.stringify(advancedOptions.entrypoint) && container.Config.WorkingDir === advancedOptions.workingDir, 'Actual env, CMD, Entrypoint or working directory differs from UI');
    requireFact(container.HostConfig.RestartPolicy?.Name === 'on-failure' && container.HostConfig.Memory === advancedOptions.memoryBytes && container.HostConfig.NanoCpus === advancedOptions.nanoCpus && container.HostConfig.NetworkMode === fixtureNetworkId && container.NetworkSettings?.Networks?.[fixtureNetworkName]?.NetworkID === fixtureNetworkId, 'Actual restart policy, memory, CPU or network differs from UI');
    report.observations.advancedConfiguration = { requested: { ...advancedOptions, networkId: fixtureNetworkId }, actual: { env: container.Config.Env, command: container.Config.Cmd, entrypoint: container.Config.Entrypoint, workingDir: container.Config.WorkingDir, restartPolicy: container.HostConfig.RestartPolicy, memoryBytes: container.HostConfig.Memory, nanoCpus: container.HostConfig.NanoCpus, networkMode: container.HostConfig.NetworkMode, networks: container.NetworkSettings.Networks } };
  }
  const actualLogs = await guest('container-logs', fixtureContainerId); requireFact(actualLogs.includes('Hello from Docker!'), 'Actual hello-world fixture lacks real Docker output');
  await waitFor('actual Hello from Docker output rendered', () => evaluate(`document.querySelector('${activePage} pre[aria-label="컨테이너 로그"]')?.textContent.includes('Hello from Docker!')`));
  const selected = await evaluate(`(()=>{const page=document.querySelector('${activePage}');const row=page?.querySelector('tbody tr.selected');return{name:row?.querySelector('.name-button')?.textContent,id:row?.querySelector('.cell-subtext')?.getAttribute('title'),logs:page?.querySelector('pre[aria-label="컨테이너 로그"]')?.textContent,activeLogTab:[...(page?.querySelectorAll('.detail-tabs button')??[])].some(button=>button.textContent==='Logs'&&button.getAttribute('aria-pressed')==='true')};})()`);
  requireFact(selected.name === fixtureName && selected.id === fixtureContainerId && selected.activeLogTab && selected.logs.includes('Hello from Docker!'), 'Created container was not selected with its actual logs tab');
  report.observations.created = { durationMs: Date.now() - submittedAt, fixture, response: actualRun, inspected: container, actualLogs, selected, calls: serialCalls(uiCalls), counts: counts(uiCalls) };
  await screenshot('created-container-selected-real-logs');
  check('Images run creates and starts exactly one real container, then opens its selected Containers logs and shows actual successful hello-world output');
  if (advanced) check('actual container inspect matches environment literals, CMD, Entrypoint, working directory, on-failure policy, 64 MB memory, 0.5 CPU and the new internal bridge');

  const current = await readState(); assertBaselinePreserved(current, true);
  const linkedImage = current.images.find(image => image.id === fixtureImage.id);
  requireFact(linkedImage?.containers === fixtureImage.containers + 1, 'Actual image reference count did not increase');
  requireFact(current.overview.images === baseline.overview.images && current.overview.containersStopped === baseline.overview.containersStopped + 1 && current.overview.containersRunning === baseline.overview.containersRunning, 'Actual overview container/image counts disagree');
  await waitFor('shared cached page coherence', () => evaluate(`(()=>{const overview=document.querySelector('main [data-page="Overview"]');const images=document.querySelector('main [data-page="Images"]');const row=[...(images?.querySelectorAll('tbody tr')??[])].find(item=>item.querySelector('.cell-subtext')?.getAttribute('title')===${JSON.stringify(fixtureImage.id)});return overview?.innerText.includes(${JSON.stringify(`중지된 컨테이너 ${current.overview.containersStopped}개`)})&&row?.innerText.includes(${JSON.stringify(`${linkedImage.containers}개에서 참조`)});})()`));
  report.observations.sharedData = { overview: current.overview, imageReferenceCount: linkedImage.containers };
  await nav('Images'); const navigationStart = calls.length;
  for (const name of ['Overview', 'Disk Manager', 'Images']) await nav(name);
  await pause(2500); const navigationCalls = calls.slice(navigationStart);
  requireFact(!navigationCalls.some(call => dataCommands.includes(call.command) || call.command === 'image_details' || call.command === 'container_run' || call.command === 'container_logs'), 'Finished image execution reread data during unrelated menu navigation or idle');
  report.observations.navigation = { calls: serialCalls(navigationCalls), counts: counts(navigationCalls) };
  check('image reference and shared overview counts update automatically; later unrelated menu navigation and idle issue zero data reads');

  report.observations.cleanup = await cleanupFixture();
  await nav('Images');
  await evaluate(`(()=>{const button=[...document.querySelectorAll('${activePage} .header-actions button')].find(item=>item.textContent.trim()==='전체 새로고침');if(!button||button.disabled)throw new Error('Global refresh unavailable after fixture cleanup');button.click();return true;})()`);
  await waitFor('original shared data after exact fixture cleanup', () => evaluate(`(()=>{const overview=document.querySelector('main [data-page="Overview"]');const images=document.querySelector('main [data-page="Images"]');const containers=document.querySelector('main [data-page="Containers"]');const row=[...(images?.querySelectorAll('tbody tr')??[])].find(item=>item.querySelector('.cell-subtext')?.getAttribute('title')===${JSON.stringify(fixtureImage.id)});const reference=${JSON.stringify(fixtureImage.containers === 0 ? '미사용' : `${fixtureImage.containers}개에서 참조`)};return overview?.innerText.includes(${JSON.stringify(`중지된 컨테이너 ${baseline.overview.containersStopped}개`)})&&row?.innerText.includes(reference)&&![...(containers?.querySelectorAll('tbody tr')??[])].some(item=>item.querySelector('.cell-subtext')?.getAttribute('title')===${JSON.stringify(fixtureContainerId)})&&![...document.querySelectorAll('main [data-page] .header-actions button:first-child')].some(button=>button.disabled);})()`));
  requireFact(exceptions.length === 0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  check(`approved cleanup removes only the exact stopped fixture${advanced ? ' and its verified empty local bridge network' : ''}, preserving every original image, tag, container, cache ID, volume usage${advanced ? ' and network identity' : ''}`);
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); report.checks.push({ name: 'halt at first image-run criterion failure', passed: false, error: error.message });
  try { await screenshot('failure-before-cleanup'); } catch {}
  report.failureRecordedBeforeCleanup = new Date().toISOString(); writeReport(); process.exitCode = 1;
  if (mutationSubmitted && baseline && fixtureImage && !cleanupDone) {
    try { report.observations.failureCleanup = await cleanupFixture(); }
    catch (cleanupError) { report.observations.failureCleanup = { completed: false, error: cleanupError.stack ?? String(cleanupError), preservedFixtureId: fixtureContainerId }; }
  }
} finally {
  report.finishedAt = new Date().toISOString(); report.exceptions = exceptions; report.observedCounts = counts(calls);
  report.remaining = cleanupDone ? `Exact new fixture container${advanced ? ' and its empty local bridge network' : ''} removed. Original images, containers, build cache, volumes${advanced ? ' and networks' : ''} retained. Workspace screenshots retained.` : 'No global cleanup performed. Any unverified or active fixture is preserved for inspection.';
  writeReport(); try { await send('Network.disable'); } catch {}
  console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failure: report.failure, report: reportFile }));
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Verification ended')); }
  socket.close();
}
