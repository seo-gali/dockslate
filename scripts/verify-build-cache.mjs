import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [portFile, approval] = process.argv.slice(2);
if (!portFile || approval !== '--approved-isolated-fixtures') throw new Error('Explicit isolated cache fixture approval is required');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback debugging port');
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(value => value.type === 'page' && value.url === 'http://tauri.localhost/');
if (!page || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.webSocketDebuggerUrl).hostname)) throw new Error('Actual local DockSlate window is required');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const pending = new Map();
let counter = 0;
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data), request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id); clearTimeout(request.timer);
  if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result);
});
const evaluate = expression => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native cache verification timed out; inspect before retrying')); }, 180000);
  pending.set(id, { timer, resolve: result => result.exceptionDetails ? reject(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)) : resolve(result.result.value), reject });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const requireFact = (condition, message) => { if (!condition) throw new Error(message); };
const execFileAsync = promisify(execFile);
const expectedPath = 'D:\\Program Files\\DockSlate\\runtime\\wsl';
const markerFile = path.join(path.dirname(expectedPath), 'ownership.json');
const prefix = `dockslate-e2e-cache-${Date.now().toString(36)}`;
const fixtureRoot = path.resolve('.analysis', prefix);
const approvedWorkspace = path.resolve(process.cwd()) + path.sep;
requireFact(fixtureRoot.startsWith(approvedWorkspace) && /^[A-Za-z]:\\/.test(fixtureRoot), 'Cache fixture directory leaves workspace');
const report = { observedAt: new Date().toISOString(), approved: true, prefix, fixtureRoot, checks: [], observations: {}, completed: false };
let identity = null;
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const owned = async () => {
  const runtime = await invoke('runtime_status');
  requireFact(runtime.state === 'running' && runtime.keeperVerified && runtime.distribution === 'DockSlate' && runtime.installPath === expectedPath && !runtime.blockedReasons.length, 'Owned runtime verification failed');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, ''));
  requireFact(marker.owner === 'DockSlate' && marker.state === 'installed' && marker.installPath === expectedPath && marker.registrationId, 'Owned installation marker mismatch');
  const current = JSON.stringify([marker.installId, marker.registrationId, marker.rootfsSha256, marker.engineVersion]);
  if (identity === null) identity = current;
  requireFact(identity === current, 'Owned runtime identity changed');
  const engine = await invoke('engine_status');
  requireFact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby' && engine.ownerPath === expectedPath, 'Independent Moby connection failed');
};
const guestBuild = async name => {
  await owned();
  requireFact(['a', 'b'].includes(name), 'Unknown cache fixture');
  const directory = path.join(fixtureRoot, name);
  let cursor = directory;
  for (;;) {
    if (fs.existsSync(cursor)) requireFact(!fs.lstatSync(cursor).isSymbolicLink() && fs.lstatSync(cursor).isDirectory(), 'Fixture directory traverses a link');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  requireFact(!fs.existsSync(directory), 'Cache fixture directory is already occupied');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'payload.txt'), `${prefix}-${name}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'Dockerfile'), `FROM scratch\nCOPY payload.txt /dockslate-e2e-marker\nLABEL io.dockslate.e2e="${prefix}-${name}"\n`, { flag: 'wx' });
  const guestDirectory = `/mnt/${directory[0].toLowerCase()}${directory.slice(2).replaceAll('\\', '/')}`;
  const tag = `${prefix}:${name}`;
  const result = await execFileAsync(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'buildx', 'build', '--builder', 'default', '--load', '--network', 'none', '--progress', 'plain', '--tag', tag, guestDirectory], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  await owned();
  report.observations[name] = { tag, directory, guestDirectory, stdout: result.stdout, stderr: result.stderr };
  return tag;
};
const execute = async request => {
  await owned();
  const ids = request.ids ?? request.buildCacheIds;
  requireFact(ids?.length === 1, 'Only one exact fixture target is permitted');
  const preview = await invoke('destructive_preview', { request });
  requireFact(preview.targets.length === 1 && preview.targets[0] === ids[0] && preview.expiresAt > Date.now(), 'Unexpected destructive preview targets');
  const result = await invoke('destructive_execute', { token: preview.token, approved: true });
  requireFact(result.failed.length === 0 && result.deleted.length === 1 && result.deleted[0] === ids[0], `Exact fixture cleanup failed: ${JSON.stringify(result)}`);
  return { targets: preview.targets, impact: preview.impact, result };
};
try {
  await owned();
  const baseline = { containers: await invoke('containers_list'), images: await invoke('images_list'), usage: await invoke('disk_usage') };
  report.observations.baseline = baseline;
  requireFact(!baseline.containers.length && !baseline.images.length && !baseline.usage.buildCache.length, 'Cache E2E requires an empty isolated engine/cache baseline');
  check('empty independent engine and build cache; existing data excluded');
  const tags = [await guestBuild('a'), await guestBuild('b')];
  const images = await invoke('images_list');
  requireFact(images.length === 2 && tags.every(tag => images.some(image => image.tags.includes(tag))), 'Expected exactly the two isolated built images');
  report.observations.images = images;
  check('two real isolated Buildx scratch-image builds');
  for (const image of images) {
    requireFact(image.tags.every(tag => tags.includes(tag)), 'Fixture image acquired an unrelated tag');
    await execute({ kind: 'image_delete', ids: [image.id] });
  }
  requireFact(!(await invoke('images_list')).length, 'Built fixture image metadata remains');
  const before = await invoke('disk_usage');
  report.observations.before = before;
  const eligible = before.buildCache.filter(item => item.eligible);
  requireFact(eligible.length >= 2, 'Two private unused cache candidates are required to verify selective deletion');
  const selected = eligible.find(item => /COPY|regular/i.test(item.label)) ?? eligible[0];
  report.observations.selected = selected;
  report.observations.deletion = await execute({ kind: 'cleanup', imageIds: [], buildCacheIds: [selected.id] });
  const after = await invoke('disk_usage');
  report.observations.after = after;
  requireFact(!after.buildCache.some(item => item.id === selected.id), 'Selected cache ID remains');
  const remaining = new Set(after.buildCache.map(item => item.id));
  requireFact(before.buildCache.filter(item => item.id !== selected.id).every(item => remaining.has(item.id)), 'An unselected cache record was removed');
  check('actual app deletes only the approved exact cache ID and retains every unselected ID');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  console.log(JSON.stringify({ passed: false, failure: String(error) }));
} finally {
  report.finishedAt = new Date().toISOString();
  report.remaining = 'On success, unselected fixture caches are retained to prove selection. Small workspace Dockerfiles and payloads are retained as evidence. Failure performs no automatic cleanup.';
  fs.writeFileSync('docs/results/build-cache-e2e.json', JSON.stringify(report, null, 2));
  socket.close();
}
