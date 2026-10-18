import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { connectNative } from './native-verification.mjs';

const [portFile, approval, expectedEngineId] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile || approval !== '--approved-isolated-fixtures' || !expectedEngineId || process.argv.length !== 5) {
  throw new Error('Usage: node scripts/verify-resource-actions.mjs WEBVIEW_PORT_FILE --approved-isolated-fixtures EXPECTED_ENGINE_ID');
}
const native = await connectNative(portFile);
const execFileAsync = promisify(execFile);
const fixture = `dockslate-e2e-resources-${Date.now()}-${randomUUID().slice(0, 8)}`;
const fixtureRoot = path.resolve('.analysis', fixture);
const volumeName = `${fixture}-data`;
const tag = `${fixture}:fixture`;
const resultFile = 'docs/results/resource-actions-e2e.json';
const idPattern = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const createdContainers = new Map();
const createdNetworks = new Map();
let baseline = null;
let ownership = null;
let imageId = null;
let volumeFingerprint = null;
let mutated = false;
let preserveFailed = false;
const report = {
  observedAt: new Date().toISOString(),
  target: 'Actual Windows DockSlate native window and verified owned Moby Engine',
  mockData: false,
  explicitIsolatedFixtureApproval: true,
  expectedEngineId,
  fixture: { name: fixture, root: fixtureRoot, tag, volumeName },
  failureConditions: [
    'Engine ID, independent runtime ownership or owned install path changes',
    'Any baseline container identity/name/image/state, image ID/tag, network configuration, volume identity or build cache ID changes or disappears',
    'Any unrelated object is created while the isolated scenario is running',
    'A fixture ID or tag overlaps a baseline object or fixture ownership metadata cannot be verified',
    'Built-in or referenced network deletion is accepted, including references from created/stopped containers',
    'Unapproved, consumed or stale image/network tokens perform a deletion',
    'Cascade deletes an unapproved target or removes the fixture volume',
    'Cleanup would stop or force-delete a running container, remove another object or prune globally',
  ],
  cleanupPolicy: 'Stop mutations if ownership/baseline changes. Otherwise remove only exact verified new stopped fixture container IDs, the exact fixture image ID, exact empty fixture network IDs and the exact fingerprint-bound fixture volume. Use application approval previews and force-free commands. Leave new build cache IDs for the root agent to inspect and selectively clean after all scenarios.',
  checks: [], observations: {}, cleanup: [], completed: false, failure: null,
  untested: ['Running/paused/restarting-reference rejection requires a separately approved runnable fixture; this scenario uses created containers with a missing executable and pulls no image', 'Approval expiry after 120 seconds', 'External mutation during the interval between the final check and Docker DELETE', 'Windows physical storage reclamation'],
};
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = (values, key) => [...values].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
const imageIdentities = values => sorted(values.map(value => ({ id: value.id, tags: [...value.tags].sort() })), 'id');
const containerIdentities = values => sorted(values.map(({ id, name, image, state }) => ({ id, name, image, state })), 'id');
const networkIdentities = values => sorted(values.map(({ id, name, driver, scope, internal, builtin, ipam }) => ({ id, name, driver, scope, internal, builtin, ipam })), 'id');
const volumeIdentities = values => sorted(values.map(({ name, driver, scope, mountpoint, createdAt, labels, options }) => ({ name, driver, scope, mountpoint, createdAt, labels, options })), 'name');
const save = () => { fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify(report, null, 2)); };
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); save(); };
const snapshot = async () => {
  const [containers, images, networks, volumes, usage] = await Promise.all(['containers_list', 'images_list', 'networks_list', 'volumes_list', 'disk_usage'].map(command => native.invoke(command)));
  return { containers, images, networks, volumes, cacheIds: usage.buildCache.map(value => value.id).sort() };
};
const guestRead = async args => {
  const result = await execFileAsync(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), ['--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  return result.stdout;
};
const assertEngine = async () => {
  const [runtime, engine] = await Promise.all([native.invoke('runtime_status'), native.invoke('engine_status')]);
  requireFact(runtime.state === 'running' && runtime.distribution === 'DockSlate' && runtime.keeperVerified === true && runtime.installPath && runtime.blockedReasons.length === 0, 'Verified running owned DockSlate runtime required');
  requireFact(engine.state === 'connected' && engine.engine === 'moby' && engine.provider === 'DockSlate' && engine.ownerPath === runtime.installPath && engine.endpoint === 'wsl://DockSlate/var/run/docker.sock', 'Independent DockSlate Moby connection required');
  const identity = [runtime.installPath, runtime.distribution, engine.context, engine.endpoint, engine.apiVersion];
  if (ownership === null) ownership = identity;
  requireFact(equal(identity, ownership), 'Owned runtime binding changed');
  requireFact((await guestRead(['info', '--format', '{{.ID}}'])).trim() === expectedEngineId, 'Actual engine ID differs from the approved engine');
  return { runtime, engine };
};
const assertPreserved = current => {
  try {
    requireFact(equal(imageIdentities(current.images.filter(value => value.id !== imageId)), imageIdentities(baseline.images)), 'Baseline images/tags changed or an unrelated image appeared');
    requireFact(equal(containerIdentities(current.containers.filter(value => !createdContainers.has(value.id))), containerIdentities(baseline.containers)), 'Baseline containers changed or an unrelated container appeared');
    requireFact(equal(networkIdentities(current.networks.filter(value => !createdNetworks.has(value.id))), networkIdentities(baseline.networks)), 'Baseline network configuration changed or an unrelated network appeared');
    requireFact(equal(volumeIdentities(current.volumes.filter(value => value.name !== volumeName)), volumeIdentities(baseline.volumes)), 'Baseline volume identity changed or an unrelated volume appeared');
    requireFact(baseline.cacheIds.every(id => current.cacheIds.includes(id)), 'A baseline build cache ID disappeared');
  } catch (error) { preserveFailed = true; throw error; }
};
const guard = async () => {
  requireFact(!preserveFailed, 'Baseline changed; all further fixture mutations are halted');
  try { await assertEngine(); } catch (error) { preserveFailed = true; throw error; }
  const current = await snapshot(); assertPreserved(current); return current;
};
const rejected = async (description, command, args, pattern) => {
  const before = await guard();
  let rejection = null;
  try { await native.invoke(command, args); } catch (error) { rejection = error.message; }
  requireFact(rejection && (!pattern || pattern.test(rejection)), `${description}: expected safety rejection, got ${rejection ?? 'success'}`);
  report.observations[description] = { rejected: true, error: rejection };
  const after = await guard();
  requireFact(equal(imageIdentities(before.images), imageIdentities(after.images))
    && equal(containerIdentities(before.containers), containerIdentities(after.containers))
    && equal(networkIdentities(before.networks), networkIdentities(after.networks))
    && equal(volumeIdentities(before.volumes), volumeIdentities(after.volumes)), `${description}: a rejected request changed a fixture or baseline resource`);
  check(description);
};
const exactToken = (preview, kind, ids) => {
  requireFact(preview.kind === kind && idPattern.test(preview.token ?? '') && preview.expiresAt > Date.now() && equal([...preview.targets].sort(), [...ids].sort()), 'Preview does not bind the exact approved target IDs');
};
const inspectFixtureImage = async () => {
  requireFact(imagePattern.test(imageId ?? '') && !baseline.images.some(value => value.id === imageId), 'Fixture image overlaps baseline or lacks a full identity');
  const inspected = JSON.parse(await guestRead(['image', 'inspect', imageId]));
  requireFact(inspected.length === 1 && inspected[0].Id === imageId && inspected[0].Config?.Labels?.['io.dockslate.e2e.resource'] === fixture && equal(inspected[0].RepoTags, [tag]), 'Fixture image identity, tag or ownership label changed');
};
const createNetwork = async suffix => {
  await guard(); mutated = true;
  const name = `${fixture}-${suffix}`;
  const result = await native.invoke('network_create', { name, internal: false });
  requireFact(idPattern.test(result.id) && result.name === name && !baseline.networks.some(value => value.id === result.id), 'New fixture network identity is invalid');
  createdNetworks.set(result.id, name);
  await guard(); return result;
};
const createContainer = async (suffix, networkId, withVolume) => {
  await guard(); await inspectFixtureImage(); mutated = true;
  const name = `${fixture}-${suffix}`;
  const result = await native.invoke('container_run', { imageId, name, ports: [], options: { networkId, restartPolicy: 'no', ...(withVolume ? { mounts: [{ name: volumeName, target: '/data', readOnly: false }] } : {}) } });
  requireFact(idPattern.test(result.id) && result.name === name && !baseline.containers.some(value => value.id === result.id), 'New fixture container identity is invalid');
  createdContainers.set(result.id, { name, networkId, withVolume });
  const inspected = await native.invoke('container_inspect', { id: result.id });
  requireFact(inspected.Id === result.id && inspected.Name === `/${name}` && inspected.Image === imageId && ['created', 'exited', 'dead'].includes(inspected.State?.Status) && inspected.State?.Running === false, 'Fixture is not the exact expected stopped/created container');
  await guard(); return result;
};
const deleteNetwork = async id => {
  const current = await guard();
  const network = current.networks.find(value => value.id === id);
  requireFact(createdNetworks.has(id) && network?.name === createdNetworks.get(id) && network.builtin === false && network.containers.length === 0 && network.deletable === true, 'Only the exact empty new fixture network can be removed');
  const preview = await native.invoke('network_delete_preview', { id }); exactToken(preview, 'network_delete', [id]);
  await guard();
  const result = await native.invoke('network_delete_execute', { token: preview.token, approved: true });
  requireFact(equal(result.deleted, [id]) && result.failed.length === 0, 'Exact fixture network deletion failed');
  return result;
};
const cleanup = async () => {
  let current = await guard();
  const stopped = current.containers.filter(value => createdContainers.has(value.id));
  if (stopped.length) {
    for (const value of stopped) {
      const owned = createdContainers.get(value.id);
      const inspected = await native.invoke('container_inspect', { id: value.id });
      requireFact(value.name === owned.name && ['created', 'exited', 'dead'].includes(value.state) && inspected.Id === value.id && inspected.Image === imageId && inspected.State?.Running === false && inspected.HostConfig?.NetworkMode === owned.networkId, 'Cleanup stopped-container ownership/state mismatch');
    }
    const ids = stopped.map(value => value.id);
    const preview = await native.invoke('destructive_preview', { request: { kind: 'container_delete', ids } }); exactToken(preview, 'container_delete', ids);
    await guard(); const result = await native.invoke('destructive_execute', { token: preview.token, approved: true });
    requireFact(!result.failed.length && equal([...result.deleted].sort(), [...ids].sort()), 'Exact stopped fixture cleanup failed'); report.cleanup.push({ kind: 'containers', ids, result });
  }
  current = await guard();
  if (imageId && current.images.some(value => value.id === imageId)) {
    await inspectFixtureImage();
    const preview = await native.invoke('image_removal_preview', { id: imageId, deleteReferencingContainers: false });
    requireFact(preview.eligible === true && preview.containers.length === 0, 'Fixture image still has references or is not eligible for cleanup'); exactToken(preview, 'image_delete', [imageId]);
    await guard(); const result = await native.invoke('image_removal_execute', { token: preview.token, approved: true });
    requireFact(!result.failed.length && equal(result.deleted, [imageId]), 'Exact fixture image cleanup failed'); report.cleanup.push({ kind: 'image', id: imageId, result });
  }
  for (const id of createdNetworks.keys()) {
    current = await guard();
    if (current.networks.some(value => value.id === id)) report.cleanup.push({ kind: 'network', id, result: await deleteNetwork(id) });
  }
  current = await guard();
  if (volumeFingerprint && current.volumes.some(value => value.name === volumeName)) {
    const volume = await native.invoke('volume_inspect', { name: volumeName });
    requireFact(equal(volumeIdentities([volume]), volumeFingerprint) && volume.containers.length === 0 && !baseline.volumes.some(value => value.name === volumeName), 'Fixture volume fingerprint or zero-reference check failed');
    const preview = await native.invoke('volume_destructive_preview', { kind: 'delete', name: volumeName });
    requireFact(preview.name === volumeName && preview.kind === 'delete' && preview.eligible === true && preview.token && preview.expiresAt > Date.now(), 'Volume cleanup preview is not restricted to the exact fixture');
    await guard(); const result = await native.invoke('volume_execute', { token: preview.token, approved: true });
    requireFact(result.state === 'completed' && result.name === volumeName, 'Fixture volume cleanup failed'); report.cleanup.push({ kind: 'volume', name: volumeName, result });
  }
  current = await guard();
  requireFact(equal(imageIdentities(current.images), imageIdentities(baseline.images)) && equal(containerIdentities(current.containers), containerIdentities(baseline.containers)) && equal(networkIdentities(current.networks), networkIdentities(baseline.networks)) && equal(volumeIdentities(current.volumes), volumeIdentities(baseline.volumes)), 'Fixture objects remain after exact cleanup');
  report.observations.afterCleanup = current;
  report.observations.newBuildCacheIds = current.cacheIds.filter(id => !baseline.cacheIds.includes(id));
  check('all exact fixture objects cleaned; every baseline resource preserved; new build caches left for coordinated root cleanup');
};

try {
  report.observations.engine = await assertEngine();
  baseline = await snapshot(); report.observations.baseline = baseline; save();
  requireFact(!baseline.images.some(value => value.tags.includes(tag)) && !baseline.volumes.some(value => value.name === volumeName) && !baseline.containers.some(value => value.name.startsWith(fixture)) && !baseline.networks.some(value => value.name.startsWith(fixture)), 'Fixture namespace overlaps baseline');
  check('captured actual baseline and verified expected independent engine before fixture creation');
  const builtin = baseline.networks.find(value => value.name === 'bridge' && value.builtin);
  requireFact(builtin && idPattern.test(builtin.id), 'Actual built-in bridge network required');
  await rejected('built-in network deletion blocked', 'network_delete_preview', { id: builtin.id }, /built-in|기본/i);
  const builds = await native.invoke('builds_snapshot');
  const builder = builds.builders.find(value => value.name === builds.selectedBuilder);
  requireFact(builder?.driver === 'docker' && !builds.selectionError, 'Local Docker-driver builder required; remote or docker-container builders are outside this isolated scenario');
  requireFact(!fs.existsSync(fixtureRoot), 'Fixture source directory already exists'); fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'marker.txt'), `${fixture}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(fixtureRoot, 'Dockerfile'), `FROM scratch\nCOPY marker.txt /fixture-marker.txt\nLABEL io.dockslate.e2e.resource="${fixture}"\nCMD ["/dockslate-e2e-intentionally-missing-executable"]\n`, { flag: 'wx' });
  await guard(); mutated = true;
  let job = await native.invoke('image_build_start', { contextPath: fixtureRoot, dockerfile: 'Dockerfile', tag, noCache: false });
  job = await native.waitFor('real isolated scratch image build', async () => { const value = await native.invoke('image_build_status', { id: job.id }); return value.state === 'running' ? null : value; }, 180000);
  report.observations.build = job;
  requireFact(job.state === 'completed' && imagePattern.test(job.imageId ?? ''), `Fixture build failed: ${job.error ?? 'no image identity'}`);
  imageId = job.imageId; report.fixture.imageId = imageId; await inspectFixtureImage(); await guard();
  check('built independently owned scratch/COPY fixture without pulling or modifying original hello-world image');
  await guard();
  const volume = await native.invoke('volume_create', { name: volumeName });
  requireFact(volume.name === volumeName, 'Unexpected new volume identity');
  const volumeInspect = await native.invoke('volume_inspect', { name: volumeName });
  requireFact(volumeInspect.driver === 'local' && volumeInspect.scope === 'local' && volumeInspect.labels?.['io.dockslate.creation'] && volumeInspect.containers.length === 0, 'Fixture volume ownership metadata unavailable');
  volumeFingerprint = volumeIdentities([volumeInspect]);
  const firstNetwork = await createNetwork('primary');
  const first = await createContainer('first', firstNetwork.id, true);
  report.fixture.first = first; report.fixture.networks = [...createdNetworks].map(([id, name]) => ({ id, name }));
  const firstList = (await native.invoke('networks_list')).find(value => value.id === firstNetwork.id);
  requireFact(firstList?.containers.some(value => value.id === first.id && ['created', 'exited', 'dead'].includes(value.state)) && firstList.deletable === false, 'Network list missed the stopped/created container reference');
  await rejected('stopped container network reference blocks deletion', 'network_delete_preview', { id: firstNetwork.id }, /referenc|참조/i);
  const off = await native.invoke('image_removal_preview', { id: imageId, deleteReferencingContainers: false });
  requireFact(off.eligible === false && off.token === null && off.blockedReasons.length && off.containers.some(value => value.id === first.id), 'Non-cascade preview failed to show exact blocked stopped reference');
  report.observations.nonCascade = off; check('non-cascade mode returns blocked DTO and exact stopped container names/IDs/states');
  const refusedImage = await native.invoke('image_removal_preview', { id: imageId, deleteReferencingContainers: true });
  requireFact(refusedImage.eligible === true, 'Stopped fixture cascade unexpectedly blocked'); exactToken(refusedImage, 'image_delete', [first.id, imageId]);
  await rejected('image approved=false rejects and preserves all resources', 'image_removal_execute', { token: refusedImage.token, approved: false }, /approval|승인/i);
  await rejected('image token is single use after rejected execution', 'image_removal_execute', { token: refusedImage.token, approved: true }, /consum|missing|승인/i);
  const secondNetwork = await createNetwork('stale');
  const refusedNetwork = await native.invoke('network_delete_preview', { id: secondNetwork.id }); exactToken(refusedNetwork, 'network_delete', [secondNetwork.id]);
  await rejected('network approved=false rejects and preserves network', 'network_delete_execute', { token: refusedNetwork.token, approved: false }, /approval|승인/i);
  await rejected('network token is single use after rejected execution', 'network_delete_execute', { token: refusedNetwork.token, approved: true }, /consum|missing|승인/i);
  const staleImage = await native.invoke('image_removal_preview', { id: imageId, deleteReferencingContainers: true }); exactToken(staleImage, 'image_delete', [first.id, imageId]);
  const staleNetwork = await native.invoke('network_delete_preview', { id: secondNetwork.id }); exactToken(staleNetwork, 'network_delete', [secondNetwork.id]);
  const second = await createContainer('second', secondNetwork.id, false); report.fixture.second = second;
  await rejected('changed exact image reference set invalidates approval', 'image_removal_execute', { token: staleImage.token, approved: true }, /referenc|changed|참조|변경/i);
  await rejected('changed exact network reference set invalidates approval', 'network_delete_execute', { token: staleNetwork.token, approved: true }, /referenc|changed|참조|변경/i);
  const beforeCascade = await guard();
  requireFact(beforeCascade.containers.some(value => value.id === first.id) && beforeCascade.containers.some(value => value.id === second.id), 'A stale approval deleted a fixture container');
  const cascade = await native.invoke('image_removal_preview', { id: imageId, deleteReferencingContainers: true });
  requireFact(cascade.eligible === true && equal(cascade.containers.map(value => value.id).sort(), [first.id, second.id].sort()), 'Cascade preview does not enumerate every exact stopped reference'); exactToken(cascade, 'image_delete', [first.id, second.id, imageId]);
  report.observations.cascadePreview = cascade;
  await guard(); const removed = await native.invoke('image_removal_execute', { token: cascade.token, approved: true });
  requireFact(!removed.failed.length && equal([...removed.deleted].sort(), [first.id, second.id, imageId].sort()) && removed.volumesRetained === true, 'Cascade deletion differs from exact approved targets');
  const afterCascade = await guard();
  requireFact(!afterCascade.containers.some(value => value.id === first.id || value.id === second.id) && !afterCascade.images.some(value => value.id === imageId) && equal(volumeIdentities(afterCascade.volumes.filter(value => value.name === volumeName)), volumeFingerprint), 'Cascade removed the retained volume or left an approved target');
  report.observations.cascadeResult = removed; report.observations.retainedVolume = afterCascade.volumes.find(value => value.name === volumeName);
  check('approved cascade removes only both exact stopped containers and fixture image while preserving named volume and all baseline resources');
  for (const id of createdNetworks.keys()) {
    const result = await deleteNetwork(id); report.observations[`networkDeletion:${id}`] = result;
    requireFact(!(await guard()).networks.some(value => value.id === id), 'Selected unused network remains after deletion');
  }
  check('approved deletion removes only each exact unused fixture network');
  await cleanup();
  requireFact(native.exceptions.length === 0, 'Native window reported a JavaScript exception');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); save();
  if (mutated && baseline && !preserveFailed) {
    try { await cleanup(); } catch (cleanupError) { report.cleanupFailure = cleanupError.stack ?? String(cleanupError); }
  }
  process.exitCode = 1;
} finally {
  report.baselineChanged = preserveFailed;
  report.calls = native.calls.map(({ command, durationMs, failed }) => ({ command, durationMs, failed }));
  report.exceptions = native.exceptions;
  if (baseline) {
    try {
      const final = await snapshot();
      report.observations.final = final;
      report.observations.newBuildCacheIds = final.cacheIds.filter(id => !baseline.cacheIds.includes(id));
    } catch (error) { report.finalReadFailure = error.message; }
  }
  save(); native.close();
  console.log(JSON.stringify({ completed: report.completed, resultFile, baselineChanged: preserveFailed, failure: report.failure, cleanupFailure: report.cleanupFailure ?? null }));
}
