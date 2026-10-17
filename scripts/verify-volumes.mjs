import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { connectNative } from './native-verification.mjs';

const [portFile, approval, expectedEngineId, pidText] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile || approval !== '--approved-isolated-fixtures' || !expectedEngineId || !/^[1-9][0-9]*$/.test(pidText ?? '')) {
  throw new Error('Usage: node scripts/verify-volumes.mjs PORT_FILE --approved-isolated-fixtures EXPECTED_ENGINE_ID APP_PID');
}
const appPid = Number(pidText);
const fact = (value, message) => { if (!value) throw new Error(message); };
const exec = promisify(execFile);
const namespace = `dockslate-e2e-volumes-${Date.now().toString(36)}`;
const sourceName = `${namespace}-source`;
const cloneName = `${namespace}-clone`;
const referenceName = `${namespace}-reference`;
const fixtures = new Map();
const root = path.resolve('.analysis', namespace);
const picker = path.resolve('.analysis/native-picker.exe');
const wsl = path.join(process.env.SystemRoot ?? '', 'System32/wsl.exe');
const assertWorkspace = value => {
  const absolute = path.resolve(value), relative = path.relative(process.cwd(), absolute);
  fact(/^[A-Za-z]:\\/.test(absolute) && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Fixture path leaves the local workspace');
  for (let cursor = path.dirname(absolute); ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor)) fact(fs.lstatSync(cursor).isDirectory() && !fs.lstatSync(cursor).isSymbolicLink(), 'Fixture path traverses a link');
    if (cursor === path.dirname(cursor)) break;
  }
  return absolute;
};
assertWorkspace(root);
fact(fs.existsSync(picker) && fs.lstatSync(picker).isFile() && !fs.lstatSync(picker).isSymbolicLink(), 'Root-built native picker helper is required');
fact(fs.existsSync(wsl), 'System wsl.exe is unavailable');
fs.mkdirSync(root, { recursive: true });
const native = await connectNative(portFile);
const { invoke, evaluate, nav, setInput, setSelect, waitFor, pause, calls } = native;
const page = '[data-page="Volumes"]';
const report = {
  observedAt: new Date().toISOString(), namespace, expectedEngineId, appPid,
  target: 'actual built DockSlate Tauri window, native file picker and independently owned WSL Moby engine',
  mockData: false, explicitIsolatedFixtureApproval: true, checks: [], observations: {},
  failureConditions: ['Engine or ownership changes', 'A preexisting image, container or volume changes', 'Unapproved destructive action succeeds', 'A referenced volume changes', 'Path escape or unsafe tar is accepted', 'Merge loses unrelated files', 'Replace retains unrelated files', 'Clone changes its source', 'Stale preview is accepted', 'An actual UI action does not update the shared snapshot'],
  failurePolicy: 'Stop at the first failed criterion. Preserve remaining fixture data and evidence. Never globally prune, force-delete or retry mutations.',
  completed: false, failure: null,
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const stable = value => JSON.stringify(value);
const imageIdentity = values => values.map(value => ({ id: value.id, tags: [...value.tags].sort() })).sort((a, b) => a.id.localeCompare(b.id));
const volumeIdentity = values => values.map(value => ({ name: value.name, driver: value.driver, scope: value.scope, mountpoint: value.mountpoint, createdAt: value.createdAt, labels: value.labels, options: value.options, containers: value.containers.map(item => item.id).sort() })).sort((a, b) => a.name.localeCompare(b.name));
let ownership = null, baseline = null, referenceId = null, dataRoot = null;
const own = async () => {
  const runtime = await invoke('runtime_status'), engine = await invoke('engine_status');
  fact(runtime.state === 'running' && runtime.distribution === 'DockSlate' && runtime.keeperVerified === true && runtime.blockedReasons.length === 0, 'A verified running owned runtime is required');
  fact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby' && engine.ownerPath === runtime.installPath, 'A verified independent Moby connection is required');
  const markerPath = path.join(path.dirname(runtime.installPath), 'ownership.json');
  const stat = fs.lstatSync(markerPath);
  fact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 131072, 'A regular ownership marker is required');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''));
  fact(marker.owner === 'DockSlate' && marker.state === 'installed' && marker.distribution === 'DockSlate' && marker.installPath === runtime.installPath, 'Ownership marker mismatch');
  const identity = stable([marker.installId, marker.registrationId, marker.rootfsSha256, marker.installPath]);
  if (ownership === null) ownership = identity;
  fact(identity === ownership, 'Runtime ownership changed');
};
const guest = async args => {
  await own();
  return (await exec(wsl, ['--distribution', 'DockSlate', '--user', 'root', '--exec', ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 60000 })).stdout;
};
const docker = async (kind, value) => {
  let args;
  if (kind === 'identity') args = ['info', '--format', '{{.ID}}'];
  else if (kind === 'root') args = ['info', '--format', '{{json .DockerRootDir}}'];
  else if (kind === 'mount' || kind === 'volumeLabel') {
    fact(fixtures.has(value), 'Only this run\'s exact new volume can be inspected');
    args = ['volume', 'inspect', '--format', kind === 'mount' ? '{{.Mountpoint}}' : '{{index .Labels "io.dockslate.creation"}}', value];
  } else if (kind === 'createReference') {
    fact(value === baseline.images[0]?.id && !baseline.containers.some(item => item.name === referenceName), 'A preexisting image is used read-only for an exact never-started reference fixture');
    args = ['create', '--pull', 'never', '--name', referenceName, '--label', `io.dockslate.e2e=${namespace}`, '--mount', `type=volume,src=${sourceName},dst=/fixture,volume-nocopy`, '--entrypoint', '/dockslate-e2e-never-started', value];
  } else if (kind === 'referenceLabel') {
    fact(value === referenceId && /^[a-f0-9]{64}$/.test(value), 'Only the exact new reference container can be inspected');
    args = ['container', 'inspect', '--format', '{{index .Config.Labels "io.dockslate.e2e"}}', value];
  } else if (kind === 'removeReference') {
    fact(value === referenceId && !baseline.containers.some(item => item.id === value), 'Refuse removal of a preexisting container');
    fact((await docker('referenceLabel', value)).trim() === namespace, 'Reference fixture label mismatch');
    args = ['container', 'rm', value];
  } else throw new Error('Unsupported fixture Docker command');
  return guest(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', ...args]);
};
const assertEngine = async () => { fact((await docker('identity')).trim() === expectedEngineId, 'Actual engine ID differs from the root-provided identity'); };
const reject = async (command, args) => {
  try { await invoke(command, args); } catch (error) { return String(error); }
  throw new Error(`${command} accepted a forbidden request`);
};
const click = (scope, label) => evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});const button=[...(root?.querySelectorAll('button')??[])].find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Enabled button unavailable: '+${JSON.stringify(label)});button.click();})()`);
const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText??''`);
const refresh = async () => { await click(page, '전체 새로고침'); await waitFor('global refresh finished', () => evaluate(`![...document.querySelectorAll(${JSON.stringify(page + ' .header-actions button')})].some(item=>item.textContent.includes('조회 중'))`)); };
const selectVolume = async value => {
  fact(fixtures.has(value), 'Only this run\'s exact new volume may be selected');
  await nav('Volumes');
  await setInput(`${page} .search-input input`, namespace);
  await click(`${page} table[aria-label="볼륨 목록"]`, value);
  await waitFor('selected fixture volume', () => evaluate(`document.querySelector(${JSON.stringify(page + ' .detail-panel > header h2')})?.textContent===${JSON.stringify(value)}`));
};
const register = async value => {
  const result = (await invoke('volumes_list')).find(item => item.name === value);
  fact(result && !baseline.volumes.some(item => item.name === value) && result.fileSupported && result.labels?.['io.dockslate.creation'], 'A uniquely created local fixture volume is required');
  fixtures.set(value, result.labels['io.dockslate.creation']);
};
const createUi = async value => {
  await nav('Volumes');
  await setInput(`${page} .search-input input`, namespace);
  await click(page, '볼륨 만들기');
  await setInput(`${page} #volume-name`, value);
  await click(`${page} section[aria-label="볼륨 만들기"]`, '만들기');
  await waitFor('created volume updates the real list', () => evaluate(`[...document.querySelectorAll(${JSON.stringify(page + ' table[aria-label="볼륨 목록"] button')})].some(item=>item.textContent===${JSON.stringify(value)})`));
  await register(value);
};
const seed = async (value, action) => {
  fact(fixtures.has(value) && ['seed', 'addLink', 'removeLink', 'stale'].includes(action), 'Only exact new fixture volume data can be written');
  await assertEngine();
  fact((await docker('volumeLabel', value)).trim() === fixtures.get(value), 'Fixture volume creation identity changed');
  const mount = (await docker('mount', value)).trim();
  fact(mount === `${dataRoot}/volumes/${value}/_data`, 'Fixture mount is outside its verified Docker data root');
  const program = `import os,stat,sys\np=sys.argv[1];action=sys.argv[2];marker=sys.argv[3]\nfd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)\ntry:\n for part in p.split('/'):\n  if not part:continue\n  if part in ('.','..'):raise RuntimeError('invalid path')\n  nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt\n def write(name,content):\n  out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd)\n  with os.fdopen(out,'w',encoding='utf-8') as stream:stream.write(content)\n if action=='seed':\n  if os.listdir(fd):raise RuntimeError('fixture must be empty')\n  write('keep.txt',marker+' keep\\n');write('same.txt',marker+' old\\n')\n elif action=='addLink':os.symlink('keep.txt','link.txt',dir_fd=fd)\n elif action=='removeLink':\n  item=os.stat('link.txt',dir_fd=fd,follow_symlinks=False)\n  if not stat.S_ISLNK(item.st_mode):raise RuntimeError('not fixture link')\n  os.unlink('link.txt',dir_fd=fd)\n elif action=='stale':write('stale-guard.txt',marker+' stale\\n')\n else:raise RuntimeError('unknown action')\nfinally:os.close(fd)\n`;
  await guest(['/usr/bin/python3', '-I', '-c', program, mount, action, namespace]);
};
const tar = entries => {
  const chunks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), payload = Buffer.from(entry.text ?? '');
    fact(Buffer.byteLength(entry.name) < 100, 'Fixture tar name must fit a standard header');
    const put = (offset, length, value) => header.write(value, offset, length, 'ascii');
    put(0, 100, entry.name); put(100, 8, '0000644\0'); put(108, 8, '0000000\0'); put(116, 8, '0000000\0');
    put(124, 12, payload.length.toString(8).padStart(11, '0') + '\0'); put(136, 12, '00000000000\0');
    header.fill(32, 148, 156); put(156, 1, entry.type ?? '0'); if (entry.link) put(157, 100, entry.link);
    put(257, 6, 'ustar\0'); put(263, 2, '00');
    put(148, 8, [...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, payload, Buffer.alloc((512 - payload.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
};
const writeTar = (file, entries) => { assertWorkspace(file); fact(!fs.existsSync(file), 'Never overwrite an existing fixture file'); fs.writeFileSync(file, tar(entries), { flag: 'wx' }); return file; };
const pickerSelect = async file => {
  assertWorkspace(file);
  await exec(picker, ['select', String(appPid), path.resolve(file)], { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
};
const pickToken = async file => {
  const pending = invoke('volume_pick_archive', { purpose: 'import' }).then(value => ({ value }), error => ({ error }));
  await pickerSelect(file);
  const answer = await pending;
  if (answer.error) throw answer.error;
  const result = answer.value;
  fact(!result.cancelled && result.token && path.resolve(result.path) === path.resolve(file), 'Actual native picker did not select the exact fixture archive');
  return result.token;
};
const fileText = async (volume, relative) => { fact(fixtures.has(volume), 'Only fixture file content may be read'); return (await invoke('volume_file_preview', { name: volume, path: relative })).text; };
const waitJobUi = async (volume, kind) => {
  await waitFor('actual UI file operation terminal state', async () => {
    const status = await evaluate(`(()=>{const banners=[...document.querySelectorAll(${JSON.stringify(page + ' .operation-banner')})];return {failed:banners.find(item=>item.classList.contains('danger'))?.innerText??'',completed:banners.some(item=>item.classList.contains('success')&&item.innerText.includes(${JSON.stringify(volume)})&&item.innerText.includes(${JSON.stringify(kind + ' 완료')}))};})()`);
    fact(!status.failed, `Actual UI job failed: ${status.failed}`); return status.completed;
  }, 120000);
};
const approveUi = async () => {
  await waitFor('eligible exact destructive preview', () => evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');const checkbox=dialog?.querySelector('input[type="checkbox"]');return !!checkbox&&!checkbox.disabled;})()`));
  await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');const checkbox=dialog?.querySelector('input[type="checkbox"]');if(!checkbox||checkbox.disabled)throw new Error('Approval unavailable');checkbox.click();})()`);
  await waitFor('explicit approval enables execution', () => evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');return [...(dialog?.querySelectorAll('footer button')??[])].some(item=>item.textContent.trim().endsWith('실행')&&!item.disabled);})()`));
  await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');const buttons=[...(dialog?.querySelectorAll('footer button')??[])];const action=buttons.find(item=>item.textContent.trim().endsWith('실행'));if(!action||action.disabled)throw new Error('Approved execute unavailable');action.click();})()`);
  await waitFor('approved dialog closes', () => evaluate(`!document.querySelector('[role="dialog"]')`));
};
const importUi = async (file, mode) => {
  await selectVolume(sourceName); await setSelect(`${page} #volume-import-mode`, mode);
  await click(`${page} .detail-panel`, 'tar 가져오기…'); await pickerSelect(file);
  await waitFor('import collision preview ready', () => evaluate(`!!document.querySelector('[role="dialog"] input[type="checkbox"]:not(:disabled)')`));
  const previewText = await text('[role="dialog"]');
  fact(previewText.includes(mode === 'merge' ? '병합' : '전체 교체'), 'Approval omitted the actual import mode');
  if (mode === 'merge') fact(previewText.includes('기존 파일 1개 덮어쓰기'), 'Merge approval omitted the exact overwritten-file count');
  else fact(previewText.includes('삭제 후 가져옵니다'), 'Replace approval omitted deletion impact');
  await approveUi(); await waitJobUi(sourceName, '가져오기');
  return previewText;
};
const preserve = async () => {
  const volumes = await invoke('volumes_list'), images = await invoke('images_list'), containers = await invoke('containers_list');
  fact(stable(volumeIdentity(volumes.filter(item => !fixtures.has(item.name)))) === stable(volumeIdentity(baseline.volumes)), 'A preexisting volume changed');
  fact(stable(imageIdentity(images)) === stable(imageIdentity(baseline.images)), 'A preexisting image or tag changed');
  fact(stable(containers.filter(item => item.id !== referenceId).map(item => item.id).sort()) === stable(baseline.containers.map(item => item.id).sort()), 'A preexisting container changed');
};

try {
  await assertEngine();
  const pythonVersion = JSON.parse((await guest(['/usr/bin/python3', '-I', '-c', 'import json,sys;print(json.dumps(list(sys.version_info[:3])))'])).trim());
  fact(pythonVersion[0] === 3 && pythonVersion[1] >= 11, 'The installed owned WSL must already provide Python 3.11 or newer; this script never installs dependencies');
  report.observations.pythonVersion = pythonVersion;
  dataRoot = JSON.parse((await docker('root')).trim()).replace(/\/$/, '');
  fact(dataRoot.startsWith('/') && !dataRoot.split('/').some(part => part === '..'), 'Verified Docker data root required');
  baseline = { volumes: await invoke('volumes_list'), images: await invoke('images_list'), containers: await invoke('containers_list') };
  fact(baseline.images.length > 0, 'Root must provide an existing read-only image for a never-started reference fixture');
  fact(!baseline.volumes.some(item => [sourceName, cloneName].includes(item.name)), 'A fixture name already exists');
  report.observations.baseline = { volumes: baseline.volumes.length, images: baseline.images.length, containers: baseline.containers.length };
  await reject('volume_create', { name: '../invalid' }); await reject('volume_execute', { token: 'invalid-fixture-token', approved: false });
  check('verified expected owned engine, unchanged baseline and rejection of invalid or unapproved requests');
  await createUi(sourceName); await seed(sourceName, 'seed');
  fact(await fileText(sourceName, 'keep.txt') === `${namespace} keep\n`, 'Fixture seed mismatch');
  await selectVolume(sourceName); await click(`${page} .detail-panel`, '파일');
  await waitFor('real file browser entries', () => evaluate(`document.querySelector(${JSON.stringify(page + ' table[aria-label="볼륨 파일"]')})?.innerText.includes('keep.txt')`));
  await click(`${page} table[aria-label="볼륨 파일"]`, 'keep.txt');
  await waitFor('real bounded text preview', () => evaluate(`document.querySelector(${JSON.stringify(page + ' section[aria-label="볼륨 파일 미리보기"] pre')})?.textContent===${JSON.stringify(namespace + ' keep\n')}`));
  await reject('volume_browse', { name: sourceName, path: '../' });
  await seed(sourceName, 'addLink'); await reject('volume_file_preview', { name: sourceName, path: 'link.txt' }); await seed(sourceName, 'removeLink');
  check('actual UI creation, root-confined file browser, UTF-8 preview and traversal/symlink rejection');
  await selectVolume(sourceName); await setInput(`${page} #volume-clone-name`, cloneName); await click(`${page} .detail-panel`, '새 볼륨으로 복제');
  await waitJobUi(sourceName, '복제'); await register(cloneName);
  fact(await fileText(cloneName, 'same.txt') === `${namespace} old\n`, 'Clone contents differ from the original');
  fact(await fileText(sourceName, 'same.txt') === `${namespace} old\n`, 'Clone altered its source');
  check('actual background clone creates a distinct volume without altering the source');
  referenceId = (await docker('createReference', baseline.images[0].id)).trim(); fact(/^[a-f0-9]{64}$/.test(referenceId), 'Reference container ID is invalid');
  for (const kind of ['delete', 'empty']) {
    const preview = await invoke('volume_destructive_preview', { kind, name: sourceName });
    fact(!preview.eligible && !preview.token && preview.references.some(item => item.id === referenceId), `${kind} accepted a stopped reference`);
  }
  const mergeTar = writeTar(path.join(root, 'merge-source.tar'), [{ name: 'same.txt', text: `${namespace} new\n` }, { name: 'added.txt', text: `${namespace} added\n` }, { name: 'nested/new.txt', text: `${namespace} nested\n` }]);
  const referencedImport = await invoke('volume_import_preview', { name: sourceName, archiveToken: await pickToken(mergeTar), mode: 'merge' });
  fact(!referencedImport.eligible && !referencedImport.token && referencedImport.references.some(item => item.id === referenceId), 'Import accepted a stopped reference');
  await docker('removeReference', referenceId); referenceId = null;
  check('empty, delete and import refuse references from a never-started container');
  for (const [filename, entry] of [['unsafe-parent.tar', { name: '../escape.txt', text: 'must not extract' }], ['unsafe-link.tar', { name: 'link', type: '2', link: '/outside-fixture' }]]) {
    const archive = writeTar(path.join(root, filename), [entry]);
    const preview = await invoke('volume_import_preview', { name: sourceName, archiveToken: await pickToken(archive), mode: 'replace' });
    fact(!preview.eligible && !preview.token && preview.blockedReasons.length > 0, 'Unsafe tar was accepted');
    fact(await fileText(sourceName, 'keep.txt') === `${namespace} keep\n`, 'A rejected archive changed the target');
  }
  check('real preflight rejects traversal and link tar entries before replacement can delete data');
  await selectVolume(sourceName);
  const exportFile = assertWorkspace(path.join(root, 'native-export.tar'));
  await click(`${page} .detail-panel`, 'tar 내보내기'); await pickerSelect(exportFile); await waitJobUi(sourceName, '내보내기');
  fact(fs.statSync(exportFile).size >= 1024 && fs.statSync(exportFile).size < 1024 * 1024, 'Native export did not create a bounded actual tar');
  report.observations.export = { bytes: fs.statSync(exportFile).size, sha256: createHash('sha256').update(fs.readFileSync(exportFile)).digest('hex') };
  check('actual native Save picker and background export create an archive without changing source contents');
  report.observations.mergeApproval = await importUi(mergeTar, 'merge');
  fact(await fileText(sourceName, 'same.txt') === `${namespace} new\n`, 'Merge did not overwrite the approved collision');
  fact(await fileText(sourceName, 'keep.txt') === `${namespace} keep\n`, 'Merge lost unrelated data');
  fact(await fileText(sourceName, 'nested/new.txt') === `${namespace} nested\n`, 'Merge did not create a safe implicit parent');
  check('actual native Open picker, collision disclosure and approved merge overwrite only exact archive paths');
  const stale = await invoke('volume_import_preview', { name: sourceName, archiveToken: await pickToken(mergeTar), mode: 'merge' }); fact(stale.eligible && stale.token, 'Valid stale-plan fixture preview was blocked');
  await seed(sourceName, 'stale'); const staleJob = await invoke('volume_execute', { token: stale.token, approved: true });
  const staleTerminal = await waitFor('stale preview job rejected', async () => { const value = await invoke('volume_job_status', { id: staleJob.id }); return value.state === 'running' ? false : value; });
  fact(staleTerminal.state === 'failed' && await fileText(sourceName, 'keep.txt') === `${namespace} keep\n`, 'Stale target was mutated');
  check('an approved token is rejected after its volume tree changes');
  await refresh(); report.observations.replaceApproval = await importUi(mergeTar, 'replace');
  await reject('volume_file_preview', { name: sourceName, path: 'keep.txt' }); await reject('volume_file_preview', { name: sourceName, path: 'stale-guard.txt' });
  fact(await fileText(sourceName, 'same.txt') === `${namespace} new\n`, 'Replace did not import its validated archive');
  fact(await fileText(cloneName, 'same.txt') === `${namespace} old\n`, 'Source import modified its clone');
  check('approved replace removes disclosed old contents while preserving the independent clone');
  await selectVolume(sourceName); await click(`${page} .detail-panel`, '비우기…'); await approveUi(); await waitJobUi(sourceName, '비우기');
  fact((await invoke('volume_browse', { name: sourceName, path: '' })).entries.length === 0, 'Approved empty left files behind');
  fact((await invoke('volumes_list')).some(item => item.name === sourceName), 'Empty removed the volume');
  check('actual approved UI empty removes contents while retaining the volume');
  await preserve();
  for (const value of [sourceName, cloneName]) {
    await selectVolume(value); await click(`${page} .detail-panel`, '삭제…'); await approveUi();
    await waitFor('approved volume deletion updates every cached view', () => evaluate(`![...document.querySelectorAll(${JSON.stringify(page + ' table[aria-label="볼륨 목록"] button')})].some(item=>item.textContent===${JSON.stringify(value)})`));
    fact(!(await invoke('volumes_list')).some(item => item.name === value), 'Deleted fixture volume remains in the actual engine');
  }
  await preserve(); await assertEngine();
  fact(native.exceptions.length === 0, 'Actual renderer raised an exception');
  report.observations.remainingFixtures = (await invoke('volumes_list')).filter(item => fixtures.has(item.name)).map(item => item.name);
  fact(report.observations.remainingFixtures.length === 0, 'New fixture volumes remain after exact cleanup');
  check('approved UI deletion cleans only exact new fixtures and preserves the original image/container/volume baseline');
  report.completed = true;
} catch (error) {
  report.failure = error?.stack ?? String(error); process.exitCode = 1;
  console.error(report.failure);
} finally {
  report.observations.calls = calls.map(({ command, durationMs, failed }) => ({ command, durationMs, failed }));
  report.observations.retainedReference = referenceId;
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  fs.mkdirSync('docs/results', { recursive: true }); fs.writeFileSync('docs/results/volumes-e2e.json', JSON.stringify(report, null, 2));
  native.close(); console.log(JSON.stringify({ completed: report.completed, checks: report.checks.length, report: path.join(root, 'report.json') }));
}
