import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectNative, waitFor } from './native-verification.mjs';

const [sessionFile, approval, mode] = process.argv.slice(2);
if (!sessionFile || approval !== '--isolated-fixture' || (mode && !['--volume-port', '--mongodb'].includes(mode))) throw Error('Usage: node scripts/verify-compose-import.mjs SESSION_JSON --isolated-fixture [--volume-port|--mongodb]');
const mongodb = mode === '--mongodb';
const volumePort = !!mode;
const resultFile = `docs/results/${mongodb ? 'compose-mongodb' : volumePort ? 'compose-volume-port' : 'compose-import'}-e2e.json`;
const root = process.cwd();
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8').replace(/^\uFEFF/, ''));
if (!path.resolve(session.profile).startsWith(path.join(root, '.analysis', 'compose-smoke-webview-'))) throw Error('Fresh isolated native profile required');
if (crypto.createHash('sha256').update(fs.readFileSync(session.artifact)).digest('hex').toUpperCase() !== session.sha256) throw Error('Native artifact changed');
const c = await connectNative(session.portFile);
const execute = promisify(execFile);
const id = crypto.randomBytes(6).toString('hex');
const fixtureRoot = path.resolve(`.analysis/file-import-fixture-${id}/샘플 프로젝트`);
const report = { observedAt: new Date().toISOString(), artifactSha256: session.sha256, native: true, mockBackend: false, fixtureRoot, checks: [], completed: false, failure: null };
const assert = (value, message) => { if (!value) throw Error(message); };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ name, passed: true })); };
const ev = c.evaluate;
const clickText = (selector, text) => ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Unavailable control: '+${JSON.stringify(text)});e.click()})()`);
const snapshot = async () => {
  const [containers, images, volumes, networks] = await Promise.all(['containers_list', 'images_list', 'volumes_list', 'networks_list'].map(command => c.invoke(command)));
  return { containers, images, volumes, networks };
};
const signature = state => Object.fromEntries(Object.entries(state).map(([kind, rows]) => [kind, rows.map(row => row.id ?? row.name).sort()]));
let baseline, project, fixtureImage, volumeName;
const containerPort = mongodb ? 27017 : 8080;
const volumeTarget = mongodb ? '/data/db' : '/state';
const database = `dockslate_fixture_${id}`;
const databaseNonce = crypto.randomBytes(16).toString('hex');
const databaseCommand = ['mongod', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'];
const shell = mongodb ? JSON.parse(fs.readFileSync('.analysis/compose-mongodb-shell.json', 'utf8').replace(/^\uFEFF/, '')) : null;
if (mongodb && (!shell.hashVerified || crypto.createHash('sha256').update(fs.readFileSync(shell.executable)).digest('hex').toUpperCase() !== shell.executableSha256)) throw Error('Reviewed Windows MongoDB shell changed');
if (mongodb) fs.mkdirSync(path.join(shell.profile, 'Temp'), { recursive: true });
const mongo = async (port, expression) => {
  const response = await execute(shell.executable, [`mongodb://127.0.0.1:${port}/${database}?directConnection=true&serverSelectionTimeoutMS=3000`, '--norc', '--quiet', '--eval', expression], {
    windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.join(process.env.SystemRoot, 'System32'), USERPROFILE: shell.profile, HOME: shell.profile, APPDATA: path.join(shell.profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(shell.profile, 'AppData/Local'), TEMP: path.join(shell.profile, 'Temp'), TMP: path.join(shell.profile, 'Temp') },
  });
  return JSON.parse(response.stdout.trim());
};
const databaseRead = `const d=db.probe.findOne({_id:${JSON.stringify(id)}}); if(!d||d.nonce!==${JSON.stringify(databaseNonce)}||d.counter!==2)throw Error('Persisted test document missing or changed'); print(JSON.stringify({database:db.getName(),version:db.version(),document:d}));`;
const httpBody = async port => {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  assert(response.status === 200, 'Published HTTP endpoint did not return 200');
  return response.text();
};
const service = async () => {
  const container = (await c.invoke('containers_list')).find(row => row.name === `${project}-probe-1`);
  assert(container && !baseline.containers.some(row => row.id === container.id), 'Isolated service container missing');
  const inspect = await c.invoke('container_inspect', { id: container.id });
  assert(inspect.Image === fixtureImage.id && inspect.Config.Labels['com.docker.compose.project'] === project, 'Service image/project identity changed');
  return { container, inspect };
};
const publishedPort = inspect => {
  const bindings = inspect.NetworkSettings.Ports[`${containerPort}/tcp`];
  assert(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1', 'Expected one loopback-only port binding');
  const port = Number(bindings[0].HostPort);
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid dynamically published host port');
  return port;
};
try {
  const runtime = await c.invoke('runtime_status');
  assert(runtime.state === 'running' && runtime.keeperVerified && runtime.distribution === 'DockSlate', 'Verified running owned runtime required');
  report.engine = await c.invoke('engine_status');
  assert(report.engine.state === 'connected' && report.engine.engine === 'moby', 'Owned Moby engine required');
  baseline = await snapshot();
  const baseImage = mongodb ? 'mongo:latest' : volumePort ? 'busybox:1.37.0' : 'hello-world:latest';
  assert(baseline.images.some(image => image.tags.includes(baseImage)), 'Cached test image required; this test does not pull images');
  report.baseline = signature(baseline);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'Dockerfile'), `FROM ${baseImage}\nLABEL io.dockslate.compose-smoke="${id}"\n` + (volumePort && !mongodb ? 'COPY server.sh /server.sh\nENTRYPOINT ["/bin/sh", "/server.sh"]\n' : ''));
  fs.writeFileSync(path.join(fixtureRoot, 'compose.yaml'), 'services:\n  probe:\n    build:\n      context: .\n      dockerfile: Dockerfile\n    restart: "no"\n' + (volumePort ? `    ports:\n      - "127.0.0.1::${containerPort}"\n    volumes:\n      - state:${volumeTarget}\n` + (mongodb ? `      - config:/data/configdb\n    command: ${JSON.stringify(databaseCommand)}\n` : '') + 'volumes:\n  state: {}\n' + (mongodb ? '  config: {}\n' : '') : ''));
  if (volumePort && !mongodb) fs.writeFileSync(path.join(fixtureRoot, 'server.sh'), `set -eu\nif [ ! -f /state/index.html ]; then\n  printf 'dockslate-volume-${id}\\n' > /state/index.html\n  cat /proc/sys/kernel/random/uuid >> /state/index.html\nfi\nexec httpd -f -p 8080 -h /state\n`);
  report.fixture = Object.fromEntries(['Dockerfile', 'compose.yaml', ...(volumePort && !mongodb ? ['server.sh'] : [])].map(file => [file, fs.readFileSync(path.join(fixtureRoot, file), 'utf8')]));
  if (mongodb) report.client = { name: 'MongoDB Shell', platform: 'Windows x64', version: shell.version, source: shell.source, archiveSha256: shell.sha256, executableSha256: shell.executableSha256, authenticode: shell.authenticode, isolatedProfile: true, telemetryDisabled: true };
  await c.send('Page.reload');
  await waitFor('setup ready', () => ev(`!!document.querySelector('nav')||[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='DockSlate 시작'&&!b.disabled)`));
  if (!await ev(`!!document.querySelector('nav')`)) await clickText('button', 'DockSlate 시작');
  await waitFor('main navigation', () => ev(`!!document.querySelector('nav')`));
  await clickText('nav button', '빌드');
  await waitFor('active Builds', () => ev(`document.querySelector('main [data-page]:not([hidden])')?.getAttribute('data-page')==='Builds'`));
  await waitFor('build tabs', () => ev(`!!document.querySelector('[data-page="Builds"] [role="tab"]')`));
  await ev(`document.querySelector('[data-page="Builds"] [role="tab"]').click()`);
  await clickText('[data-page="Builds"] button', 'Compose 파일 선택');
  const selected = await execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-File', path.resolve('scripts/select-native-import-file.ps1'), '-TargetProcessId', String(session.pid), '-Path', path.join(fixtureRoot, 'compose.yaml')], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  check('Actual Windows Compose file picker selects the isolated Korean/spaces project', JSON.parse(selected.stdout.trim().replace(/^\uFEFF/, '')));
  await waitFor('Compose build result', () => ev(`['completed','failed'].includes(document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'))||!!document.querySelector('[data-page="Builds"] .image-build-panel>[role="alert"]')`), 120000);
  const build = await ev(`({state:document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'),text:document.querySelector('[data-page="Builds"] .image-build-panel')?.innerText,path:document.querySelector('[data-page="Builds"] .detail-grid dd')?.textContent,project:[...document.querySelectorAll('[data-page="Builds"] .detail-grid dd')][1]?.textContent,engineId:[...document.querySelectorAll('[data-page="Builds"] .detail-grid dd')][2]?.textContent})`);
  report.build = build;
  project = build.project;
  assert(build.state === 'completed', 'Compose build failed: ' + build.text);
  assert(build.path?.toLowerCase() === path.join(fixtureRoot, 'compose.yaml').toLowerCase() && /^dockslate-import-[a-f0-9]{32,64}$/.test(project), 'Selected source/project identity mismatch');
  fixtureImage = (await c.invoke('images_list')).find(image => image.tags.includes(`${project}-probe:import`));
  assert(fixtureImage && !baseline.images.some(image => image.id === fixtureImage.id), 'Distinct built image missing');
  assert(!(await c.invoke('containers_list')).some(container => container.name.startsWith(project)), 'Service started without separate run approval');
  check('Compose builds the Dockerfile image and creates no service before run approval', { project, imageId: fixtureImage.id });
  await waitFor('run preview enabled', () => ev(`[...document.querySelectorAll('[data-compose-state] button')].some(b=>b.textContent.trim()==='실행 미리보기'&&!b.disabled)`));
  await clickText('[data-compose-state] button', '실행 미리보기');
  await waitFor('Compose approval', () => ev(`!!document.querySelector('.confirm-dialog')`));
  const confirmation = await ev(`({text:document.querySelector('.confirm-dialog').innerText,disabled:document.querySelector('.confirm-dialog footer button:last-child').disabled})`);
  assert(confirmation.disabled && confirmation.text.includes(project) && confirmation.text.includes('probe'), 'Run acknowledgment/details missing');
  check('Run confirmation names the project/service and requires acknowledgment', { initiallyDisabled: true });
  await ev(`document.querySelector('.confirm-dialog .acknowledgement input').click()`);
  await ev(`document.querySelector('.confirm-dialog footer button:last-child').click()`);
  await waitFor('Compose run result', () => ev(`!document.querySelector('.confirm-dialog')&&['completed','failed'].includes(document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'))`), 90000);
  const run = await ev(`({state:document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'),text:document.querySelector('[data-compose-state]')?.innerText})`);
  assert(run.state === 'completed', 'Compose run failed: ' + run.text);
  const { container } = await service();
  if (volumePort) {
    const { inspect } = await waitFor('fixture service running', async () => { const value = await service(); return value.inspect.State.Running ? value : null; });
    volumeName = `${project}_state`;
    assert(!baseline.volumes.some(row => row.name === volumeName), 'Refusing baseline volume');
    const dataMount = inspect.Mounts.find(mount => mount.Destination === volumeTarget);
    assert(inspect.Mounts.length === (mongodb ? 2 : 1) && dataMount?.Type === 'volume' && dataMount.Name === volumeName && dataMount.RW, 'Compose did not attach the new writable named volume');
    if (mongodb) assert(inspect.Mounts.some(mount => mount.Type === 'volume' && mount.Name === `${project}_config` && mount.Destination === '/data/configdb'), 'MongoDB config volume is not isolated');
    const volume = (await c.invoke('volumes_list')).find(row => row.name === volumeName);
    assert(volume?.labels?.['com.docker.compose.project'] === project, 'Volume project ownership missing');
    check('Compose creates and mounts a new writable named volume with matching project ownership', { containerId: container.id, volume });
    const firstPort = publishedPort(inspect);
    let body;
    if (mongodb) {
      await waitFor('Windows MongoDB ping', async () => { try { return (await mongo(firstPort, 'print(JSON.stringify(db.runCommand({ping:1})))')).ok === 1; } catch { return false; } }, 90000);
      const inserted = await mongo(firstPort, `if(db.getName()!==${JSON.stringify(database)}||db.probe.countDocuments({})!==0)throw Error('Test database not empty'); const r=db.probe.insertOne({_id:${JSON.stringify(id)},nonce:${JSON.stringify(databaseNonce)},counter:1},{writeConcern:{w:1,j:true}}); if(!r.acknowledged||db.probe.findOne({_id:${JSON.stringify(id)}}).counter!==1)throw Error('Insert/read failed'); const u=db.probe.updateOne({_id:${JSON.stringify(id)}},{$inc:{counter:1}},{writeConcern:{w:1,j:true}}); if(u.modifiedCount!==1)throw Error('Update failed'); ${databaseRead}`);
      body = JSON.stringify(inserted);
      check('Real Windows MongoDB client connects through the published port and inserts, reads, updates with journal acknowledgment', { host: '127.0.0.1', port: firstPort, result: inserted, exitCode: 0, writeConcern: { w: 1, j: true } });
    } else {
      body = await waitFor('Windows loopback HTTP response', async () => { try { return await httpBody(firstPort); } catch { return null; } });
      assert(new RegExp(`^dockslate-volume-${id}\\n[a-f0-9-]{36}\\n$`).test(body), 'HTTP response does not contain the fixture and first-boot UUID');
      check('Windows reaches the container HTTP server through its actual dynamic loopback port', { url: `http://127.0.0.1:${firstPort}/`, status: 200, body, containerPort: 8080 });
    }
    await c.invoke('container_action', { id: container.id, action: 'stop' });
    const stopped = await service();
    assert(!stopped.inspect.State.Running && stopped.inspect.Id === container.id, 'Original fixture service did not stop');
    if (!mongodb) await waitFor('original host port closed', async () => { try { await httpBody(firstPort); return false; } catch { return true; } });
    const runtime = await c.invoke('runtime_status');
    const engine = await c.invoke('engine_status');
    assert(runtime.state === 'running' && runtime.keeperVerified && engine.ownerPath === report.engine.ownerPath && engine.endpoint === report.engine.endpoint, 'Owned engine changed before fixture recreation');
    const wsl = path.join(process.env.SystemRoot, 'System32/wsl.exe');
    const guest = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/nonexistent', 'DOCKER_CONFIG=/nonexistent/dockslate-compose-test', 'COMPOSE_DISABLE_ENV_FILE=1', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock'];
    const identity = await execute(wsl, ['--distribution', 'DockSlate', '--user', 'root', '--exec', ...guest, 'info', '--format', '{{.ID}}'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert(identity.stdout.trim() === build.engineId, 'Actual engine identity changed before recreation');
    const config = { services: { probe: { image: fixtureImage.id, restart: 'no', ports: [`127.0.0.1::${containerPort}`], volumes: [`state:${volumeTarget}`] } }, volumes: { state: { external: true, name: volumeName } }, networks: { default: { external: true, name: `${project}_default` } } };
    if (mongodb) {
      config.services.probe.command = databaseCommand;
      config.services.probe.volumes.push('config:/data/configdb');
      config.volumes.config = { external: true, name: `${project}_config` };
    }
    const recreation = await new Promise((resolve, reject) => {
      const child = execFile(wsl, ['--distribution', 'DockSlate', '--user', 'root', '--exec', ...guest, 'compose', '--ansi', 'never', '--env-file', '/dev/null', '--project-name', project, '--file', '-', 'up', '-d', '--force-recreate', '--no-build', '--pull', 'never'], { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr, exitCode: 0 }));
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(config));
    });
    const recreated = await waitFor('recreated fixture service running', async () => { const value = await service(); return value.container.id !== container.id && value.inspect.State.Running ? value : null; });
    assert(recreated.inspect.Mounts.length === (mongodb ? 2 : 1) && recreated.inspect.Mounts.some(mount => mount.Name === volumeName && mount.Destination === volumeTarget), 'Recreated service did not reattach the same volume');
    const secondPort = publishedPort(recreated.inspect);
    const persisted = await waitFor('persisted data after recreation', async () => { try { return mongodb ? JSON.stringify(await mongo(secondPort, databaseRead)) : await httpBody(secondPort); } catch { return null; } }, mongodb ? 90000 : 60000);
    assert(persisted === body, 'Persisted data changed after container recreation');
    const sameVolume = (await c.invoke('volumes_list')).find(row => row.name === volumeName);
    assert(sameVolume?.createdAt === volume.createdAt && sameVolume?.mountpoint === volume.mountpoint, 'Named volume identity changed');
    check(mongodb ? 'Official Compose CLI recreates the MongoDB container; the same database document and Windows access persist' : 'Official Compose CLI recreates only the test service; volume UUID/file and HTTP access persist', { originalContainerId: container.id, recreatedContainerId: recreated.container.id, volumeName, firstPort, secondPort, bodyBefore: body, bodyAfter: persisted, recreation });
    report.retainedVolume = { name: volumeName, reason: mongodb ? 'Test database preserved; no drop/delete/reset was executed.' : 'Preserved per project policy; contains only the fixture marker and random UUID, no database.' };
    if (mongodb) report.retainedConfigVolume = `${project}_config`;
    report.limits = ['First creation/build/run uses the actual app UI; same-project recreation uses the official guest Compose CLI because the app import flow intentionally blocks existing project replacement.', mongodb ? 'One isolated standalone MongoDB, loopback access and journaled insert/read/update; no user database, authentication/TLS, replication, transaction or migration tested.' : 'One HTTP service, one new named volume and one dynamic IPv4 loopback TCP port; no user database or external/LAN exposure tested.'];
  } else {
    const inspect = await waitFor('hello-world service exits', async () => { const value = await c.invoke('container_inspect', { id: container.id }); return value.State?.Status === 'exited' ? value : null; });
    assert(inspect.State.ExitCode === 0 && inspect.Image === fixtureImage.id && inspect.Mounts.length === 0, 'Service did not execute built image cleanly without mounts');
    const logs = await c.invoke('container_logs', { id: container.id });
    assert(JSON.stringify(logs).includes('Hello from Docker!'), 'Actual executable output missing');
    check('Approved service executes the built image with exit 0 and real hello-world output', { containerId: container.id, imageId: inspect.Image, exitCode: inspect.State.ExitCode, noMounts: true });
  }
  fs.writeFileSync(`.analysis/compose-${mongodb ? 'mongodb' : volumePort ? 'volume-port' : 'smoke'}-result.png`, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert(c.exceptions.length === 0, 'Unhandled WebView JavaScript exceptions');
  report.completed = true;
} catch (error) { report.failure = String(error.stack ?? error); console.error(report.failure); }
finally {
  try {
    if (baseline) {
      if (project) {
        const image = fixtureImage ?? (await c.invoke('images_list')).find(row => row.tags.includes(`${project}-probe:import`));
        if (image) {
          assert(!baseline.images.some(row => row.id === image.id), 'Cleanup refuses baseline image');
          if (volumePort) {
            for (const container of (await c.invoke('containers_list')).filter(row => row.name === `${project}-probe-1`)) {
              const inspect = await c.invoke('container_inspect', { id: container.id });
              assert(!baseline.containers.some(row => row.id === container.id) && inspect.Image === image.id && inspect.Config.Labels['com.docker.compose.project'] === project, 'Cleanup refuses unrelated fixture container');
              if (inspect.State.Running) await c.invoke('container_action', { id: container.id, action: 'stop' });
            }
          }
          const preview = await c.invoke('image_removal_preview', { id: image.id, deleteReferencingContainers: true });
          assert(preview.eligible && preview.containers.every(row => row.name === `${project}-probe-1` && ['created', 'exited', 'dead'].includes(row.state) && !baseline.containers.some(original => original.id === row.id)), 'Cleanup refuses active/non-fixture container');
          const removed = await c.invoke('image_removal_execute', { token: preview.token, approved: true });
          assert(removed.failed.length === 0 && removed.deleted.includes(image.id), 'Fixture image cleanup failed');
        }
        for (const network of (await c.invoke('networks_list')).filter(row => row.name === `${project}_default` && !baseline.networks.some(original => original.id === row.id))) {
          const preview = await c.invoke('network_delete_preview', { id: network.id });
          const removed = await c.invoke('network_delete_execute', { token: preview.token, approved: true });
          assert(removed.failed.length === 0 && removed.deleted.includes(network.id), 'Fixture network cleanup failed');
        }
      }
      const after = await snapshot();
      const originalAfter = volumePort ? { ...after, volumes: after.volumes.filter(row => row.name !== `${project}_state` && (!mongodb || row.name !== `${project}_config`)) } : after;
      assert(JSON.stringify(signature(originalAfter)) === JSON.stringify(signature(baseline)), 'Original resource ID sets changed');
      assert(baseline.containers.every(original => after.containers.some(row => row.id === original.id && row.state === original.state)), 'Original container states changed');
      check('Only new fixture image/container/network removed; original IDs and container states preserved', { original: signature(baseline), after: signature(originalAfter), buildCacheRetained: true, retainedVolume: report.retainedVolume ?? null });
    }
  } catch (error) { report.completed = false; report.cleanupFailure = String(error.stack ?? error); console.error(report.cleanupFailure); }
  c.close();
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
}
if (!report.completed) process.exitCode = 1;
