import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [activePortFile, approval, outputDirectory = '.analysis/independent-engine-e2e'] = process.argv.slice(2);
if (!activePortFile || approval !== '--approved-isolated-fixtures') {
  throw new Error('Usage: node scripts/verify-independent-engine.mjs WEBVIEW_DEVTOOLS_ACTIVE_PORT --approved-isolated-fixtures [OUTPUT_DIRECTORY]. This creates/deletes fixtures in an already installed and running DockSlate engine.');
}
if (process.platform !== 'win32') throw new Error('The real Windows DockSlate EXE is required');
const execFileAsync = promisify(execFile);
const systemRoot = process.env.SystemRoot;
if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('Windows system directory is unavailable');
const wslExecutable = path.join(systemRoot, 'System32', 'wsl.exe');
if (!fs.existsSync(wslExecutable)) throw new Error('Windows system wsl.exe is unavailable');
const port = Number(fs.readFileSync(activePortFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback WebView debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target) throw new Error('Built DockSlate Tauri WebView2 window is unavailable');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Only local WebView debugging is permitted');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const pending = new Map();
const exceptions = [];
let counter = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}, timeout = 180000) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}; operation outcome must be inspected before retrying`)); }, timeout);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (description, query, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await query();
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${description}; no automatic mutation retry was performed`);
};
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const prefix = `dockslate-e2e-${Date.now().toString(36)}`;
const fixtureName = `${prefix}-main`;
const httpFixtureName = `${prefix}-http`;
const imageReference = 'busybox:1.37.0';
const source = 'https://raw.githubusercontent.com/docker-library/official-images/master/library/busybox';
const report = {
  observedAt: new Date().toISOString(), target: 'built Windows Tauri EXE and its own real WSL Moby engine',
  mockData: false, explicitIsolatedFixtureApproval: true, fixtureNamespace: prefix,
  imageReference, imageTagSource: source, checks: [], observations: {},
  untested: ['Build cache creation and selective cache deletion', 'VHDX compression or deletion', 'Existing Docker Desktop data migration'],
  completed: false, failure: null, failurePolicy: 'Stop at the first failed criterion; preserve remaining fixture data for inspection. No global prune, forced delete, WSL shutdown, original-runtime access, or automatic cleanup on failure.'
};
const checks = report.checks;
checks.push = (...items) => {
  for (const item of items) console.log(JSON.stringify({ check: item.name, passed: item.passed }));
  return Array.prototype.push.apply(checks, items);
};
const assertWorkspaceDirectory = directory => {
  const resolved = path.resolve(directory);
  const relative = path.relative(process.cwd(), resolved);
  requireFact(/^[A-Za-z]:\\/.test(resolved) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Fixture output must be within the current local-drive workspace');
  let ancestor = resolved;
  for (;;) {
    if (fs.existsSync(ancestor)) requireFact(!fs.lstatSync(ancestor).isSymbolicLink() && fs.lstatSync(ancestor).isDirectory(), 'Fixture directories must not traverse symlinks or directory junctions');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return resolved;
};
assertWorkspaceDirectory(outputDirectory);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.mkdirSync('docs/results', { recursive: true });
let ownership = null;
let engineIdentity = null;
let fixtureId = null;
let fixtureImageId = null;
let httpFixtureId = null;
let mountFixture = null;
let baselineImageIdentities = null;
const imageIdentities = images => images.map(image => ({ id: image.id, tags: [...image.tags].sort() })).sort((left, right) => left.id.localeCompare(right.id));
const isFixtureReference = tag => tag.replace(/^(?:docker\.io\/)?(?:library\/)?/, '') === imageReference;
const sameImages = (images, expected) => JSON.stringify(imageIdentities(images)) === JSON.stringify(expected);
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
const ownedFingerprint = runtime => {
  requireFact(runtime.installPath === 'D:\\Program Files\\DockSlate\\runtime\\wsl', 'The runtime is outside the approved installation target');
  const markerPath = path.join(path.dirname(runtime.installPath), 'ownership.json');
  const markerStat = fs.lstatSync(markerPath);
  requireFact(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1 && markerStat.size > 0 && markerStat.size <= 131072, 'The owned runtime marker must be a single regular file');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''));
  requireFact(marker.owner === 'DockSlate' && marker.state === 'installed' && marker.distribution === 'DockSlate', 'The runtime marker does not identify a complete owned installation');
  const fingerprint = { installId: marker.installId, registrationId: marker.registrationId, rootfsSha256: marker.rootfsSha256, installPath: marker.installPath, engineVersion: marker.engineVersion };
  requireFact(fingerprint.installId && fingerprint.registrationId && fingerprint.rootfsSha256 && fingerprint.installPath === runtime.installPath, 'Owned WSL registration fingerprint is incomplete');
  return fingerprint;
};
const assertOwnedEngine = async () => {
  const runtime = await invoke('runtime_status');
  requireFact(runtime.state === 'running' && runtime.distribution === 'DockSlate' && runtime.keeperVerified === true, 'Only an app-verified, running DockSlate distribution is allowed');
  requireFact(Array.isArray(runtime.blockedReasons) && runtime.blockedReasons.length === 0, 'Runtime ownership or access is blocked');
  const fingerprint = ownedFingerprint(runtime);
  const current = canonical(fingerprint);
  if (ownership === null) ownership = current;
  requireFact(ownership === current, 'Owned runtime identity changed; verification halted');
  const engine = await invoke('engine_status');
  requireFact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby' && engine.endpoint === 'wsl://DockSlate/var/run/docker.sock' && engine.ownerPath === runtime.installPath, 'The app is not connected to its independently verified Linux Moby engine');
  return { runtime, engine };
};
const hostDocker = async (kind, value) => {
  await assertOwnedEngine();
  let arguments_;
  switch (kind) {
    case 'info': arguments_ = ['info', '--format', '{{json .}}']; break;
    case 'buildxVersion': arguments_ = ['buildx', 'version']; break;
    case 'composeVersion': arguments_ = ['compose', 'version']; break;
    case 'imageInspect':
      requireFact(value === imageReference || value === fixtureImageId, 'Only the current fixture image may be inspected');
      arguments_ = ['image', 'inspect', value]; break;
    case 'containerInspect':
      requireFact(value === fixtureId || value === fixtureName || value === httpFixtureId || value === httpFixtureName, 'Only this run\'s exact fixture containers may be inspected');
      arguments_ = ['container', 'inspect', value]; break;
    case 'create':
      requireFact(value === fixtureName && /^dockslate-e2e-[a-z0-9]+-main$/.test(value), 'Fixture name does not match this run');
      arguments_ = ['create', '--pull', 'never', '--name', fixtureName, '--label', `com.docker.compose.project=${prefix}`, '--label', 'com.docker.compose.service=main', '--label', `io.dockslate.e2e=${prefix}`, imageReference,
        '/bin/sh', '-c', `printf '%s\\n' '${prefix}-stdout'; printf '%s\\n' '${prefix}-stderr' >&2; trap 'exit 0' TERM INT; while :; do sleep 1; done`];
      break;
    case 'createHttp':
      requireFact(value === httpFixtureName && /^dockslate-e2e-[a-z0-9]+-http$/.test(value) && mountFixture, 'HTTP fixture does not match this run');
      assertWorkspaceDirectory(mountFixture.hostDirectory);
      requireFact(fs.readFileSync(mountFixture.sentinelPath, 'utf8') === mountFixture.sentinel, 'The exact Windows mount fixture changed before creation');
      arguments_ = ['create', '--pull', 'never', '--name', httpFixtureName, '--label', `io.dockslate.e2e=${prefix}`, '--publish', '127.0.0.1::8080',
        '--mount', `type=bind,source=${mountFixture.guestDirectory},target=/srv,readonly`, imageReference, '/bin/busybox', 'httpd', '-f', '-p', '8080', '-h', '/srv'];
      break;
    default: throw new Error('Unsupported host fixture operation');
  }
  // 배포판·바이너리·소켓 고정
  const result = await execFileAsync(wslExecutable, ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', ...arguments_], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  await assertOwnedEngine();
  return result.stdout.trim();
};
const currentContainer = async () => {
  const containers = await invoke('containers_list');
  const fixture = containers.find(container => container.id === fixtureId && container.name === fixtureName);
  requireFact(fixture, 'The exact fixture container is unavailable');
  return fixture;
};
const denied = async (command, args, pattern) => {
  const result = await evaluate(`(async () => { try { return { allowed: true, result: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) }; } catch (error) { return { allowed: false, message: String(error) }; } })()`);
  requireFact(result.allowed === false, `${command} unexpectedly accepted a forbidden operation`);
  requireFact(pattern.test(result.message), `Unexpected refusal for ${command}: ${result.message}`);
  return result.message;
};
const nav = async name => {
  await evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find(item => item.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Navigation unavailable'); button.click(); })()`);
  await waitFor(`${name} navigation`, () => evaluate(`document.querySelector('nav button[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(name)}`));
};
const refreshPage = async () => {
  await waitFor('enabled refresh button', () => evaluate("!![...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(item => item.textContent.trim() === '전체 새로고침' && !item.disabled)"));
  await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(item => item.textContent.trim() === '전체 새로고침' && !item.disabled).click()");
  await waitFor('page refresh finished', () => evaluate("!![...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(item => item.textContent.trim() === '전체 새로고침' && !item.disabled)"));
};
const screenshot = async name => {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDirectory, `${name}.png`), Buffer.from(image.data, 'base64'));
};
const detailAction = async (label, expectedState) => {
  await assertOwnedEngine();
  await currentContainer();
  await waitFor(`enabled container ${label} control`, () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) .detail-actions button')].find(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled)`));
  await evaluate(`[...document.querySelectorAll('main [data-page]:not([hidden]) .detail-actions button')].find(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled).click()`);
  await waitFor(`fixture state ${expectedState}`, async () => (await currentContainer()).state === expectedState);
  await waitFor('container operation control restored', () => evaluate("!![...document.querySelectorAll('main [data-page]:not([hidden]) .detail-actions button')].find(item => !item.disabled)"));
};
const executeExactPreview = async request => {
  await assertOwnedEngine();
  const selected = request.ids ?? request.imageIds ?? [];
  requireFact(selected.length === 1 && selected[0] === fixtureImageId && /^sha256:[a-f0-9]{64}$/.test(fixtureImageId), 'Only the exact fixture image may be deleted by this helper');
  requireFact(baselineImageIdentities && !baselineImageIdentities.some(image => image.id === fixtureImageId), 'A preexisting image must never be selected for fixture deletion');
  const currentImages = await invoke('images_list');
  requireFact(sameImages(currentImages.filter(image => image.id !== fixtureImageId), baselineImageIdentities), 'Unrelated image identities or tags changed; fixture deletion is halted');
  const currentFixture = currentImages.find(image => image.id === fixtureImageId);
  requireFact(currentFixture?.tags.length === 1 && isFixtureReference(currentFixture.tags[0]), 'Fixture image has an unexpected or additional tag; deletion is halted');
  requireFact(!request.buildCacheIds?.length, 'Build cache deletion is outside this harness');
  const preview = await invoke('destructive_preview', { request });
  requireFact(preview.targets.length === 1 && preview.targets[0] === fixtureImageId && preview.recoverable === false && preview.expiresAt > Date.now(), 'Deletion preview contains unexpected targets or an invalid approval lifetime');
  await denied('destructive_execute', { token: preview.token, approved: false }, /approval/i);
  const result = await invoke('destructive_execute', { token: preview.token, approved: true });
  requireFact(result.failed.length === 0 && result.deleted.length === 1 && result.deleted[0] === fixtureImageId, `Fixture deletion failed: ${JSON.stringify(result)}`);
  await denied('destructive_execute', { token: preview.token, approved: true }, /missing|consumed/i);
  return { kind: request.kind, targets: preview.targets, impact: preview.impact, estimatedBytes: preview.estimatedBytes, result };
};

const assertSharedViews = async expectedImageCount => waitFor('all shared views updated after the real UI mutation without manual Refresh', async () => {
  const value = await evaluate(`(() => {
    const overview = document.querySelector('main [data-page="Overview"]');
    return { busy: [...document.querySelectorAll('main [data-page] .header-actions')].some(header => header.querySelector('button')?.disabled),
      imageCount: Number(overview.querySelectorAll('.metric-value')[1]?.textContent.replaceAll(',','')),
      runningCount: Number(overview.querySelectorAll('.metric-value')[0]?.textContent.replaceAll(',','')),
      stoppedText: overview.querySelector('.metric-subtext')?.textContent.trim(),
      imageIds: [...document.querySelectorAll('main [data-page="Images"] .cell-subtext[title^="sha256:"]')].map(item=>item.title),
      cleanupImageRows: [...document.querySelectorAll('main [data-page="Disk Manager"] .candidate-table tbody tr')].filter(row=>row.querySelector('td:nth-child(2)')?.textContent.trim()==='Image').length };
  })()`);
  return !value.busy && value.imageCount === expectedImageCount && value.runningCount === 0 && value.stoppedText === '중지된 컨테이너 0개' && value.imageIds.length === expectedImageCount && value.cleanupImageRows === expectedImageCount && value;
});

try {
  await send('Runtime.enable');
  await send('Page.enable');
  const connection = await assertOwnedEngine();
  report.observations.connection = connection;
  const info = JSON.parse(await hostDocker('info'));
  requireFact(info.OSType === 'linux' && info.ID && !/docker desktop/i.test(info.OperatingSystem ?? ''), 'Guest CLI does not identify an independent Linux engine');
  engineIdentity = info.ID;
  report.observations.engineIdentity = engineIdentity;
  checks.push({ name: 'app and fixed own-distribution CLI verify independent Linux Moby engine', passed: true });
  report.observations.cliVersions = { buildx: await hostDocker('buildxVersion'), compose: await hostDocker('composeVersion') };
  requireFact(/\bv?0\.38\.0\b/.test(report.observations.cliVersions.buildx) && /\bv?5\.6\.0\b/.test(report.observations.cliVersions.compose), 'Installed Buildx or Compose CLI version does not match the runtime pins');
  checks.push({ name: 'real guest Buildx and Compose CLI versions match the approved pins', passed: true });
  const baseline = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage'), overview: await invoke('overview') };
  report.observations.baseline = baseline;
  requireFact(baseline.containers.length === 0, 'Fixture verification requires an empty container baseline; existing objects are preserved');
  requireFact(!baseline.images.some(image => image.tags.some(isFixtureReference)), 'The busybox:1.37.0 fixture image already exists; existing images must never be used as disposable fixtures');
  baselineImageIdentities = imageIdentities(baseline.images);
  requireFact(baseline.overview.containersRunning === 0 && baseline.overview.containersStopped === 0 && baseline.overview.images === baselineImageIdentities.length, 'Overview does not reflect the actual empty-container and existing-image baseline');
  checks.push({ name: 'measured empty-container baseline and exact existing image identities; fixture image absent', passed: true });
  report.observations.deleteWithoutApproval = await denied('destructive_execute', { token: 'invalid-isolated-verification-token', approved: false }, /approval/i);
  report.observations.invalidPull = await denied('image_pull', { reference: '--invalid-reference' }, /invalid image reference/i);
  report.observations.runtimeStopWithoutApproval = await denied('runtime_stop', { approved: false }, /approval/i);
  report.observations.compactWithoutApproval = await denied('wsl_compact', { token: 'invalid-isolated-verification-token', approved: false }, /approval/i);
  checks.push({ name: 'unapproved deletion, runtime stop and compaction plus invalid image reference denied before mutation', passed: true });

  await nav('Images');
  await waitFor('enabled Pull image button', () => evaluate("!![...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(item => item.textContent.trim() === 'Pull image' && !item.disabled)"));
  if (!await evaluate("!!document.querySelector('main [data-page]:not([hidden]) #image-reference')")) {
    await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) button')].find(item => item.textContent.trim() === 'Pull image' && !item.disabled).click()");
  }
  await waitFor('image input', () => evaluate("!!document.querySelector('main [data-page]:not([hidden]) #image-reference')"));
  await evaluate(`(() => { const input = document.querySelector('main [data-page]:not([hidden]) #image-reference'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(imageReference)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor('enabled Pull submit', () => evaluate("!!document.querySelector('main [data-page]:not([hidden]) .pull-form button[type=submit]:not(:disabled)')"));
  await evaluate("document.querySelector('main [data-page]:not([hidden]) .pull-form button[type=submit]').click()");
  const pulled = await waitFor('real image Pull completion', async () => {
    const failure = await evaluate("document.querySelector('main [data-page]:not([hidden]) .operation-banner.danger')?.textContent ?? ''");
    if (failure) { report.observations.pullFailure = failure; throw new Error(failure); }
    const images = await invoke('images_list');
    return images.find(image => image.tags.includes(imageReference));
  }, 180000);
  fixtureImageId = pulled.id;
  requireFact(/^sha256:[a-f0-9]{64}$/.test(fixtureImageId) && pulled.size > 0, 'Pulled fixture image identity or size is invalid');
  requireFact(!baselineImageIdentities.some(image => image.id === fixtureImageId), 'The pulled image identity belongs to a preexisting image; no fixture deletion may proceed');
  requireFact(sameImages((await invoke('images_list')).filter(image => image.id !== fixtureImageId), baselineImageIdentities), 'Pull changed unrelated existing image identities or tags');
  report.observations.pulledImage = pulled;
  report.observations.imageInspect = JSON.parse(await hostDocker('imageInspect', imageReference));
  await waitFor('image table reflects completed Pull', () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) tr')].find(row => row.textContent.includes(${JSON.stringify(imageReference)}))`));
  await screenshot('images-pulled');
  checks.push({ name: 'actual Images UI Pull and engine image identity/digest', passed: true });
  report.observations.sharedViewsAfterPull = await assertSharedViews(baselineImageIdentities.length + 1);
  checks.push({ name: 'UI Pull updates Overview, Images and Docker Usage together without manual refresh', passed: true });

  fixtureId = await hostDocker('create', fixtureName);
  requireFact(/^[a-f0-9]{64}$/.test(fixtureId), 'Guest fixture creation returned an invalid container ID; inspect before retrying');
  report.observations.fixture = { id: fixtureId, name: fixtureName, imageId: fixtureImageId, composeProject: prefix };
  const created = await currentContainer();
  requireFact(created.state === 'created' && created.composeProject === prefix, 'Container list does not expose the fixture state and Compose label');
  await nav('Containers');
  await refreshPage();
  await waitFor('fixture name and Compose group visible', () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) .name-button')].find(item => item.textContent.trim() === ${JSON.stringify(fixtureName)}) && [...document.querySelectorAll('main [data-page]:not([hidden]) .group-row')].some(item => item.textContent.includes(${JSON.stringify(prefix)}))`));
  await evaluate(`[...document.querySelectorAll('main [data-page]:not([hidden]) .name-button')].find(item => item.textContent.trim() === ${JSON.stringify(fixtureName)}).click()`);
  await detailAction('시작', 'running');
  await screenshot('containers-running-compose');
  checks.push({ name: 'actual container list, Compose group and UI Start', passed: true });
  const overviewRunning = await invoke('overview');
  requireFact(overviewRunning.containersRunning === 1 && overviewRunning.containersStopped === 0 && overviewRunning.images === baselineImageIdentities.length + 1, 'Overview does not reflect the running fixture plus exact existing image count');
  report.observations.overviewRunning = overviewRunning;
  checks.push({ name: 'Overview counts reflect the real running container and image', passed: true });
  report.observations.runningDeleteDenied = await denied('destructive_preview', { request: { kind: 'container_delete', ids: [fixtureId] } }, /must be stopped|running.*excluded/i);
  report.observations.referencedImageDeleteDenied = await denied('destructive_preview', { request: { kind: 'image_delete', ids: [fixtureImageId] } }, /referenced/i);
  const referencedUsage = await invoke('disk_usage');
  requireFact(referencedUsage.images.find(image => image.id === fixtureImageId)?.eligible === false, 'Referenced image must be blocked for cleanup');
  report.observations.referencedUsage = referencedUsage;
  checks.push({ name: 'running container and referenced image deletion are blocked', passed: true });
  const logs = await waitFor('stdout and stderr log frames', async () => {
    const value = await invoke('container_logs', { id: fixtureId });
    return value.content.includes(`${prefix}-stdout`) && value.content.includes(`${prefix}-stderr`) && value;
  });
  report.observations.logs = logs;
  await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) .detail-tabs button')].find(item => item.textContent.trim() === 'Logs').click()");
  await waitFor('actual Logs detail view', () => evaluate(`document.querySelector('main [data-page]:not([hidden]) pre.logs')?.textContent.includes(${JSON.stringify(`${prefix}-stdout`)}) && document.querySelector('main [data-page]:not([hidden]) pre.logs')?.textContent.includes(${JSON.stringify(`${prefix}-stderr`)})`));
  await screenshot('container-logs');
  checks.push({ name: 'real Docker stdout/stderr framing and visible Logs view', passed: true });
  await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) .detail-tabs button')].find(item => item.textContent.trim() === 'Details').click()");
  const beforeRestart = JSON.parse(await hostDocker('containerInspect', fixtureId))[0].State.StartedAt;
  await detailAction('재시작', 'running');
  const restarted = await waitFor('different real container start timestamp', async () => {
    const value = JSON.parse(await hostDocker('containerInspect', fixtureId))[0];
    return value.State.Running && value.State.StartedAt !== beforeRestart && value.State.StartedAt;
  });
  report.observations.restart = { beforeRestart, restarted };
  checks.push({ name: 'UI Restart changes the real container start timestamp', passed: true });
  await detailAction('중지', 'exited');
  checks.push({ name: 'actual UI Stop reaches exited state', passed: true });
  report.observations.stoppedReferenceDeleteDenied = await denied('destructive_preview', { request: { kind: 'image_delete', ids: [fixtureImageId] } }, /referenced/i);
  checks.push({ name: 'image referenced by a stopped container remains protected', passed: true });

  await waitFor('container deletion control', () => evaluate("!![...document.querySelectorAll('main [data-page]:not([hidden]) .detail-actions button')].find(item => item.textContent.trim() === '삭제…' && !item.disabled)"));
  await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) .detail-actions button')].find(item => item.textContent.trim() === '삭제…' && !item.disabled).click()");
  await waitFor('exact container approval dialog', () => evaluate(`document.querySelector('[role=dialog]')?.textContent.includes(${JSON.stringify(fixtureId)})`));
  const approvalState = await evaluate("({unchecked:document.querySelector('[role=dialog] input[type=checkbox]')?.checked === false,disabled:document.querySelector('[role=dialog] footer button.danger-button')?.disabled === true,targets:[...document.querySelectorAll('[role=dialog] .dialog-target-list li')].map(item => item.textContent)})");
  requireFact(approvalState.unchecked && approvalState.disabled && approvalState.targets.length === 1 && (approvalState.targets[0] === fixtureId || approvalState.targets[0].endsWith(` · ${fixtureId}`)), 'Container confirmation does not require approval of the exact target');
  report.observations.containerApproval = approvalState;
  await screenshot('container-delete-approval');
  await assertOwnedEngine();
  requireFact((await currentContainer()).state === 'exited', 'Fixture is no longer stopped before approval');
  await waitFor('real preview validated before acknowledgement', () => evaluate("document.querySelector('[role=dialog] input[type=checkbox]')?.disabled === false"));
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()");
  await waitFor('approved deletion button enabled', () => evaluate("document.querySelector('[role=dialog] footer button.danger-button')?.disabled === false"));
  await evaluate("document.querySelector('[role=dialog] footer button.danger-button').click()");
  await waitFor('approved fixture container removal', async () => !(await invoke('containers_list')).some(container => container.id === fixtureId));
  await waitFor('container approval closed', () => evaluate("!document.querySelector('[role=dialog]')"));
  checks.push({ name: 'real UI exact-target confirmation, required checkbox and approved container deletion', passed: true });
  report.observations.sharedViewsAfterContainerDelete = await assertSharedViews(baselineImageIdentities.length + 1);
  checks.push({ name: 'UI container deletion updates shared Overview counts without manual refresh', passed: true });

  const hostDirectory = path.join(assertWorkspaceDirectory(outputDirectory), `${prefix}-windows-bind`);
  requireFact(!fs.existsSync(hostDirectory) && !/[\x00-\x1f,]/.test(hostDirectory), 'The unique Windows mount fixture directory is occupied or unsupported');
  fs.mkdirSync(hostDirectory);
  assertWorkspaceDirectory(hostDirectory);
  const sentinelPath = path.join(hostDirectory, 'sentinel.txt');
  const sentinel = `${prefix}-windows-bind-mount-and-localhost\n`;
  fs.writeFileSync(sentinelPath, sentinel, { encoding: 'utf8', flag: 'wx' });
  const guestDirectory = `/mnt/${hostDirectory[0].toLowerCase()}${hostDirectory.slice(2).replaceAll('\\', '/')}`;
  mountFixture = { hostDirectory, guestDirectory, sentinelPath, sentinel };
  report.observations.windowsBindFixture = mountFixture;
  httpFixtureId = await hostDocker('createHttp', httpFixtureName);
  requireFact(/^[a-f0-9]{64}$/.test(httpFixtureId), 'HTTP fixture creation returned an invalid ID; inspect before retrying');
  report.observations.httpFixture = { id: httpFixtureId, name: httpFixtureName };
  const currentHttpFixture = async () => {
    const value = (await invoke('containers_list')).find(container => container.id === httpFixtureId && container.name === httpFixtureName);
    requireFact(value, 'The exact HTTP fixture is unavailable');
    return value;
  };
  await assertOwnedEngine();
  requireFact((await currentHttpFixture()).state === 'created', 'HTTP fixture is not in the expected created state');
  await invoke('container_action', { id: httpFixtureId, action: 'start' });
  await waitFor('HTTP fixture running', async () => (await currentHttpFixture()).state === 'running');
  const httpInspect = JSON.parse(await hostDocker('containerInspect', httpFixtureId))[0];
  const bind = httpInspect.Mounts.find(item => item.Type === 'bind' && item.Destination === '/srv');
  requireFact(bind && bind.Source === guestDirectory && bind.RW === false, 'Docker did not report the exact Windows source mounted read-only');
  const portBinding = httpInspect.NetworkSettings.Ports['8080/tcp'];
  requireFact(portBinding?.length === 1 && portBinding[0].HostIp === '127.0.0.1', 'HTTP fixture did not publish solely on loopback');
  const publishedPort = Number(portBinding[0].HostPort);
  requireFact(Number.isInteger(publishedPort) && publishedPort > 0 && publishedPort <= 65535, 'The dynamically assigned Docker port is invalid');
  const appHttpContainer = await currentHttpFixture();
  requireFact(appHttpContainer.ports.includes(`127.0.0.1:${publishedPort}`) && appHttpContainer.ports.includes('8080/tcp'), 'The app does not expose the actual published port');
  const httpUrl = `http://127.0.0.1:${publishedPort}/sentinel.txt`;
  report.observations.httpFixture = { ...report.observations.httpFixture, inspect: httpInspect, appContainer: appHttpContainer, hostUrl: httpUrl };
  let lastHttpFailure = null;
  const httpObservation = await waitFor('Windows localhost HTTP serving the exact Windows bind-mounted sentinel', async () => {
    try {
      const response = await fetch(httpUrl, { signal: AbortSignal.timeout(4000), redirect: 'error', cache: 'no-store' });
      const body = await response.text();
      if (response.status !== 200 || body !== sentinel) { lastHttpFailure = { status: response.status, body }; report.observations.lastHttpFailure = lastHttpFailure; return false; }
      return { status: response.status, body, url: httpUrl };
    } catch (error) {
      lastHttpFailure = { error: error.message, cause: error.cause?.message ?? null };
      report.observations.lastHttpFailure = lastHttpFailure;
      return false;
    }
  }, 45000);
  requireFact(fs.readFileSync(sentinelPath, 'utf8') === sentinel, 'Windows bind source changed during the read-only HTTP check');
  report.observations.windowsLocalhostHttp = httpObservation;
  checks.push({ name: 'real read-only Windows bind mount and dynamically published Windows localhost HTTP', passed: true });
  await nav('Containers');
  await refreshPage();
  await waitFor('HTTP published port visible in container table', () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) .container-table tr')].find(row => row.textContent.includes(${JSON.stringify(httpFixtureName)}) && row.textContent.includes(${JSON.stringify(`127.0.0.1:${publishedPort}`)}))`));
  await screenshot('container-windows-bind-localhost-port');
  await assertOwnedEngine();
  await invoke('container_action', { id: httpFixtureId, action: 'stop' });
  await waitFor('HTTP fixture stopped', async () => (await currentHttpFixture()).state === 'exited');
  const httpDeletePreview = await invoke('destructive_preview', { request: { kind: 'container_delete', ids: [httpFixtureId] } });
  requireFact(httpDeletePreview.targets.length === 1 && httpDeletePreview.targets[0] === httpFixtureId, 'HTTP cleanup preview selected an unexpected container');
  await denied('destructive_execute', { token: httpDeletePreview.token, approved: false }, /approval/i);
  const httpDeleted = await invoke('destructive_execute', { token: httpDeletePreview.token, approved: true });
  requireFact(httpDeleted.failed.length === 0 && httpDeleted.deleted.length === 1 && httpDeleted.deleted[0] === httpFixtureId && !(await invoke('containers_list')).some(container => container.id === httpFixtureId), 'Exact HTTP fixture was not deleted');
  report.observations.httpFixtureDeletion = httpDeleted;
  checks.push({ name: 'actual app published-port table and exact approved HTTP fixture cleanup', passed: true });

  report.observations.imageDeletion = await executeExactPreview({ kind: 'image_delete', ids: [fixtureImageId] });
  requireFact(sameImages(await invoke('images_list'), baselineImageIdentities), 'Exact fixture image was not removed or an unrelated image identity/tag changed');
  checks.push({ name: 'approved exact image deletion and single-use approval token', passed: true });
  await assertOwnedEngine();
  await invoke('image_pull', { reference: imageReference });
  const cleanupImage = (await invoke('images_list')).find(image => image.tags.includes(imageReference));
  requireFact(cleanupImage?.id === fixtureImageId, 'Second fixture Pull returned a different identity; inspect before selecting cleanup');
  const cleanupUsage = await invoke('disk_usage');
  requireFact(cleanupUsage.images.find(image => image.id === fixtureImageId)?.eligible === true, 'Unused fixture image is not eligible for selected cleanup');
  report.observations.cleanupUsage = cleanupUsage;
  await nav('Disk Manager');
  await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) [role=tab]')].find(button => button.textContent.trim() === 'Docker Usage').click()");
  await refreshPage();
  await waitFor('actual Docker usage table', () => evaluate(`!![...document.querySelectorAll('main [data-page]:not([hidden]) [data-tab]:not([hidden]) .candidate-table tr')].find(row => row.textContent.includes(${JSON.stringify(imageReference)}))`));
  await screenshot('disk-manager-unused-image');
  await evaluate(`(() => {
    const panel = document.querySelector('main [data-page="Disk Manager"] [data-tab="docker"]');
    if (panel.querySelector('input[type=checkbox]:checked')) throw new Error('A preexisting cleanup selection must be preserved');
    const row = [...panel.querySelectorAll('.candidate-table tbody tr')].find(item=>item.querySelector('td:nth-child(2)')?.textContent.trim()==='Image' && item.querySelector('td:nth-child(3)')?.title.split('\\n')[1]===${JSON.stringify(fixtureImageId)});
    const input = row?.querySelector('input[type=checkbox]');
    if (!input || input.disabled) throw new Error('Exact unused fixture image is not selectable');
    input.click();
  })()`);
  await evaluate("document.querySelector('main [data-page=\"Disk Manager\"] .selection-summary button').click()");
  await waitFor('exact real cleanup approval validated', () => evaluate(`(() => { const dialog=document.querySelector('[role=dialog]'); const targets=[...(dialog?.querySelectorAll('.dialog-target-list li')??[])].map(item=>item.textContent.trim()); return targets.length===1 && (targets[0]===${JSON.stringify(fixtureImageId)} || targets[0].endsWith(' · '+${JSON.stringify(fixtureImageId)})) && dialog.querySelector('input[type=checkbox]')?.disabled===false; })()`));
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()");
  await waitFor('explicit cleanup approval enabled', () => evaluate("document.querySelector('[role=dialog] footer .danger-button')?.disabled===false"));
  await evaluate("document.querySelector('[role=dialog] footer .danger-button').click()");
  await waitFor('real cleanup dialog closed', () => evaluate("!document.querySelector('[role=dialog]')"));
  report.observations.selectedCleanup = { mode: 'real UI exact-image selection and explicit approval', targets: [fixtureImageId], sharedViews: await assertSharedViews(baselineImageIdentities.length) };
  checks.push({ name: 'real Disk Manager selected cleanup updates all shared views without manual refresh', passed: true });
  const after = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage'), overview: await invoke('overview') };
  requireFact(after.containers.length === 0 && sameImages(after.images, baselineImageIdentities) && after.overview.containersRunning === 0 && after.overview.containersStopped === 0 && after.overview.images === baselineImageIdentities.length, 'Fixture data remains after deletion or an existing image identity/tag changed');
  requireFact(canonical(after.usage.buildCache.map(item => item.id).sort()) === canonical(baseline.usage.buildCache.map(item => item.id).sort()), 'Build cache identities changed even though no cache mutation was authorized by the harness');
  report.observations.afterCleanup = after;
  checks.push({ name: 'fixture data removed and unrelated image identities, tags and build caches retained', passed: true });

  await assertOwnedEngine();
  await invoke('runtime_stop', { approved: true });
  const stoppedRuntime = await waitFor('owned runtime stopped', async () => { const value = await invoke('runtime_status'); return value.state === 'stopped' && value; }, 120000);
  requireFact(canonical(ownedFingerprint(stoppedRuntime)) === ownership, 'Owned registration changed during stop');
  const disconnectedEngine = await invoke('engine_status');
  requireFact(disconnectedEngine.state !== 'connected', 'Stopped engine is still displayed as connected');
  report.observations.runtimeStopped = { runtime: stoppedRuntime, engine: disconnectedEngine };
  await invoke('runtime_start', { approved: true });
  await waitFor('owned runtime restarted', async () => { const value = await invoke('runtime_status'); return value.state === 'running' && value.keeperVerified === true; }, 120000);
  report.observations.runtimeRestarted = await assertOwnedEngine();
  const afterRestart = JSON.parse(await hostDocker('info'));
  const restartState = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage') };
  requireFact(afterRestart.ID === engineIdentity && restartState.containers.length === 0 && sameImages(restartState.images, baselineImageIdentities), 'Engine identity, cleanup state or existing image identities/tags changed after runtime restart');
  requireFact(canonical(restartState.usage.buildCache.map(item => item.id).sort()) === canonical(baseline.usage.buildCache.map(item => item.id).sort()), 'Unrelated cache identities changed after runtime restart');
  report.observations.afterRuntimeRestart = restartState;
  checks.push({ name: 'real owned-runtime Stop/Start, offline state, stable engine identity and preserved cleanup state', passed: true });
  await nav('Overview');
  await refreshPage();
  await waitFor('connected Overview metrics', () => evaluate("document.querySelector('main [data-page]:not([hidden])')?.textContent.includes('Connected') && document.querySelectorAll('main [data-page]:not([hidden]) .metrics-grid .metric').length === 4"));
  const finalMetrics = await evaluate("[...document.querySelectorAll('main [data-page]:not([hidden]) .metric-value')].map(value => value.textContent)");
  requireFact(Number(finalMetrics[0].replaceAll(',', '')) === 0 && Number(finalMetrics[1].replaceAll(',', '')) === baselineImageIdentities.length, 'Final visible Overview does not retain the exact existing image count and empty running-container baseline');
  report.observations.finalMetricTexts = finalMetrics;
  await screenshot('overview-independent-connected');
  checks.push({ name: 'final connected independent-engine Overview UI', passed: true });
  requireFact(exceptions.length === 0, `Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  checks.push({ name: 'unhandled renderer exceptions', passed: true });
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  try { await screenshot('failure'); } catch {}
  checks.push({ name: 'halt on the first failed criterion', passed: false, error: error.message });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.exceptions = exceptions;
  report.remainingFixture = { name: fixtureName, id: fixtureId, imageId: fixtureImageId, httpName: httpFixtureName, httpId: httpFixtureId, windowsBindDirectory: mountFixture?.hostDirectory ?? null, note: report.completed ? 'No fixture containers or images remain; runtime is running. The tiny workspace sentinel file is retained as evidence.' : 'Inspection is required; no automatic cleanup or retry was performed.' };
  fs.writeFileSync('docs/results/independent-engine-e2e.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ completed: report.completed, checks: checks.map(({ name, passed }) => ({ name, passed })), failure: report.failure, report: 'docs/results/independent-engine-e2e.json' }));
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Verification ended')); }
  socket.close();
}
