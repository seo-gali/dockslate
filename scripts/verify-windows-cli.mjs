import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const build = JSON.parse(fs.readFileSync('docs/results/installer-engine-integration.json', 'utf8').replace(/^\uFEFF/, ''));
const offline = JSON.parse(fs.readFileSync('docs/results/native-cli-offline.json', 'utf8').replace(/^\uFEFF/, ''));
const executable = path.join(root, 'src-tauri/target/release/docker.exe');
const expected = build.artifacts.find(item => item.name === 'docker.exe')?.sha256;
if (!expected || createHash('sha256').update(fs.readFileSync(executable)).digest('hex').toUpperCase() !== expected) throw Error('Recorded launcher changed');
if (!path.resolve(offline.fixtureRoot).startsWith(path.join(root, '.analysis') + path.sep)) throw Error('Isolated CLI profile required');
const env = { ...process.env, LOCALAPPDATA: offline.fixtureRoot, USERPROFILE: offline.fixtureRoot, HOME: offline.fixtureRoot };
delete env.COMPOSE_ENV_FILES;
env.COMPOSE_DISABLE_ENV_FILE = '1';
env.COMPOSE_CONVERT_WINDOWS_PATHS = '0';
const report = { observedAt: new Date().toISOString(), launcherSha256: expected, completed: false, existingProfileUsed: false, checks: [] };
async function cli(args, input, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exitMs;
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.pid) spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      child.stdout.destroy(); child.stderr.destroy();
      reject(Error('CLI output did not close within its deadline: ' + args.join(' ')));
    }, timeoutMs);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('exit', () => { exitMs = Date.now() - started; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const entry = { args, code, exitMs, closeMs: Date.now() - started, stdout: stdout.trim(), stderr: stderr.trim() };
      report.checks.push(entry);
      console.log(JSON.stringify(entry));
      if (code !== 0) reject(Error('CLI failed: ' + args.join(' ') + ': ' + entry.stderr));
      else if (entry.closeMs - exitMs > 5000) reject(Error('CLI process exited but its output pipe remained open'));
      else resolve(entry.stdout);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

async function fixtures() {
  const session = JSON.parse(fs.readFileSync('.analysis/native-integration-session.json', 'utf8').replace(/^\uFEFF/, ''));
  const prefix = session.testResourcePrefix;
  if (!session.approvedByUser || !/^dockslate-verify-[0-9]+$/.test(prefix)) throw Error('Approved isolated fixture session required');
  const directory = path.join(root, '.analysis', prefix);
  const bind = path.join(directory, 'bind folder 한글');
  fs.mkdirSync(bind, { recursive: true });
  const marker = 'native-windows-bind-probe';
  fs.writeFileSync(path.join(bind, 'marker.txt'), marker);
  fs.writeFileSync(path.join(directory, 'upload.txt'), 'native-copy-probe');
  const label = 'io.dockslate.verification=' + prefix;
  const list = text => [...new Set(text.split(/\r?\n/).filter(Boolean))].sort();
  const snapshot = async () => ({
    containers: list(await cli(['ps', '-aq', '--no-trunc'])),
    networks: list(await cli(['network', 'ls', '-q', '--no-trunc'])),
    volumes: list(await cli(['volume', 'ls', '-q'])),
    images: list(await cli(['image', 'ls', '-q', '--no-trunc'])),
  });
  const before = await snapshot();
  if (await cli(['ps', '-aq', '--filter', 'label=' + label])) throw Error('Fixture ownership label already exists');
  if (await cli(['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + prefix])) throw Error('Fixture Compose project already exists');
  const volumes = JSON.parse(await cli(['image', 'inspect', 'mongo:latest', '--format', '{{json .Config.Volumes}}'])) ?? {};
  const tmpfs = Object.keys(volumes);
  if (tmpfs.some(value => !/^\/[A-Za-z0-9_./-]+$/.test(value))) throw Error('Unexpected fixture image volume path');
  const tmpfsArgs = tmpfs.flatMap(value => ['--tmpfs', value]);
  const composeFile = path.join(directory, 'compose.yaml');
  const compose = ['compose', '--project-name', prefix, '--file', composeFile];
  let composeStarted = false;
  try {
    for (const kind of ['mount', 'volume']) {
      const name = prefix + '-' + kind;
      const bindArgs = kind === 'mount'
        ? ['--mount', 'type=bind,source=' + bind + ',target=/probe,readonly']
        : ['--volume', bind + ':/probe:ro'];
      await cli(['run', '-d', '--pull=never', '--name', name, '--label', label, ...tmpfsArgs, ...bindArgs,
        '--entrypoint', '/bin/sh', 'mongo:latest', '-c', "printf 'fixture-ready\\n'; sleep 300"]);
      if (await cli(['exec', name, '/bin/cat', '/probe/marker.txt']) !== marker) throw Error(kind + ' bind failed');
    }
    const name = prefix + '-mount';
    const failures = [];
    report.fixtureChecks = { binds: { passed: true } };
    const verify = async (name, run) => {
      try {
        await run();
        report.fixtureChecks[name] = { passed: true };
      } catch (error) {
        const failure = String(error.stack ?? error);
        report.fixtureChecks[name] = { passed: false, failure };
        failures.push(name + ': ' + failure);
        console.error(name + ': ' + failure);
      }
    };
    await verify('copyToContainer', async () => {
      await cli(['cp', path.join(directory, 'upload.txt'), name + ':/tmp/upload.txt']);
      if (await cli(['exec', name, '/bin/cat', '/tmp/upload.txt']) !== 'native-copy-probe') throw Error('Windows upload failed');
    });
    await verify('copyToWindows', async () => {
      const downloaded = path.join(directory, 'download.txt');
      await cli(['cp', name + ':/probe/marker.txt', downloaded]);
      if (fs.readFileSync(downloaded, 'utf8') !== marker) throw Error('Windows download failed');
    });
    await verify('stdin', async () => {
      if (await cli(['exec', '-i', name, '/bin/sh', '-c', 'IFS= read -r value; printf "%s\\n" "$value"'], 'stdin-probe\n', 15000) !== 'stdin-probe') throw Error('Interactive input failed');
      if (await cli(['exec', '-i', name, '/bin/cat'], 'stdin-eof-probe\n', 15000) !== 'stdin-eof-probe') throw Error('Input EOF failed');
    });
    await verify('logFollowCancellation', async () => {
      const logArgs = ['logs', '--follow', name];
      const follow = spawn(executable, logArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise(resolve => follow.once('close', resolve));
      let timer;
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          timer = setTimeout(() => reject(Error('Log follow did not receive the fixture marker')), 15000);
          follow.stdout.on('data', bytes => { output += bytes; if (output.includes('fixture-ready')) resolve(); });
          follow.stderr.on('data', () => {});
          follow.once('error', reject);
        });
      } finally {
        clearTimeout(timer);
        if (follow.exitCode === null && follow.pid) {
          const killed = spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(follow.pid), '/T', '/F'], { windowsHide: true });
          if (killed.status !== 0) throw Error('Could not cancel the owned log client');
        }
        await closed;
      }
      const lockPath = path.join(path.dirname(session.before.installPath), 'mutation.lock').replaceAll("'", "''");
      const leaseCheck = `$until=[DateTime]::UtcNow.AddSeconds(10); do { try { $s=[IO.File]::Open('${lockPath}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $s.Dispose(); exit 0 } catch [IO.IOException] { Start-Sleep -Milliseconds 100 } } while ([DateTime]::UtcNow -lt $until); exit 1`;
      const released = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', leaseCheck], { windowsHide: true, timeout: 15000 });
      if (released.status !== 0) throw Error('Cancelled streaming client retained the engine lease: ' + released.stderr?.toString());
      report.logFollowCancellationPassed = true;
    });
    await verify('compose', async () => {
      fs.writeFileSync(composeFile, JSON.stringify({ services: { probe: {
        image: 'mongo:latest', entrypoint: ['/bin/sh'], command: ['-c', "printf 'compose-ready\\n'; sleep 300"],
        labels: { 'io.dockslate.verification': prefix }, tmpfs,
        volumes: [{ type: 'bind', source: bind, target: '/probe', read_only: true }],
      } } }, null, 2));
      const config = JSON.parse(await cli([...compose, 'config', '--format', 'json']));
      if (path.resolve(config.services.probe.volumes[0].source) !== path.resolve(bind)) throw Error('Native Compose did not retain the Windows source path');
      composeStarted = true;
      await cli([...compose, 'up', '-d', '--pull', 'never']);
      if (await cli([...compose, 'exec', '-T', 'probe', '/bin/cat', '/probe/marker.txt']) !== marker) throw Error('Compose bind failed');
    });
    report.fixtureChecksPassed = failures.length === 0;
    if (failures.length) throw Error(failures.join('\n'));
  } finally {
    if (composeStarted) await cli([...compose, 'down']);
    const owned = list(await cli(['ps', '-aq', '--no-trunc', '--filter', 'label=' + label]));
    for (const id of owned) {
      if (before.containers.includes(id)) throw Error('Refusing to remove a pre-existing container');
      const owner = await cli(['inspect', '--format', '{{index .Config.Labels "io.dockslate.verification"}}', id]);
      if (owner !== prefix) throw Error('Fixture ownership changed');
      await cli(['rm', '-f', id]);
    }
    const after = await snapshot();
    report.originalResourcesPreserved = JSON.stringify(before) === JSON.stringify(after);
    if (!report.originalResourcesPreserved) throw Error('Resource identities changed after fixture cleanup');
  }
}
try {
  const server = await cli(['version', '--format', '{{.Server.Version}}']);
  if (server !== '29.8.2') throw Error('Unexpected server version');
  report.engineId = await cli(['info', '--format', '{{.ID}}']);
  if (!report.engineId) throw Error('Missing engine ID');
  await cli(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}']);
  await cli(['image', 'ls', '--format', '{{.ID}}\t{{.Repository}}:{{.Tag}}']);
  await cli(['volume', 'ls', '--format', '{{.Name}}']);
  await cli(['network', 'ls', '--format', '{{.ID}}\t{{.Name}}']);
  if (process.argv.includes('--fixtures')) await fixtures();
  report.completed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  fs.writeFileSync('docs/results/native-cli-connection.json', JSON.stringify(report, null, 2) + '\n');
}
