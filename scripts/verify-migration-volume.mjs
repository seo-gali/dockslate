import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [cliPath, approval] = process.argv.slice(2);
if (process.platform !== 'win32' || approval !== '--approved-new-migration-fixtures' || !cliPath) throw Error('Usage: node scripts/verify-migration-volume.mjs WORKSPACE_CLI --approved-new-migration-fixtures');
const root = fs.realpathSync('.');
const cli = fs.realpathSync(cliPath);
assert(cli.startsWith(root + path.sep) && path.basename(cli) === 'docker.exe');
const prefix = 'dockslate-migration-check-20261121';
const volumes = [prefix + '-source', prefix + '-target'];
const createdVolumes = [], helpers = [];
const checks = [];
const result = { observedAt: new Date().toISOString(), prefix, cli, source: 'Owned DockSlate engine only; Docker Desktop is not installed', checks, passed: false, existingDataChanged: false };
const outputDirectory = path.resolve('.analysis/migration-volume-check');
fs.mkdirSync(outputDirectory, { recursive: true });
function run(args, input, expectSuccess = true) {
  const output = spawnSync(cli, args, { input, encoding: null, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (output.error) throw output.error;
  if (expectSuccess && output.status !== 0) throw Error(`Fixture Docker ${args.slice(0, 2).join(' ')} failed: ${output.stderr.toString()}`);
  return output;
}
const text = args => run(args).stdout.toString('utf8').trim();
const inspect = (kind, id) => JSON.parse(text([kind, 'inspect', id]))[0];
const sorted = value => value.split(/\r?\n/).filter(Boolean).sort();
const inventory = () => ({ containers: sorted(text(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.State}}'])), volumes: sorted(text(['volume', 'ls', '-q'])), images: sorted(text(['image', 'ls', '-q', '--no-trunc'])) });
const before = inventory();
assert(!before.volumes.some(v => v.startsWith(prefix)), 'Fixture names are already occupied');
assert.equal(text(['ps', '-aq', '--filter', 'label=io.dockslate.verification=' + prefix]), '');
const engine = text(['info', '--format', '{{.ID}}']);
assert.equal(engine, 'f67c8aad-6a74-49b1-9c44-4c2ac08a63ec', 'This validation was prepared for a different engine');
result.engine = engine;
const [image, declared] = text(['image', 'inspect', 'postgres:18.6-alpine', '--format', '{{.Id}}|{{json .Config.Volumes}}']).split('|');
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.deepEqual(Object.keys(JSON.parse(declared)), ['/var/lib/postgresql']);
const bytes = Buffer.from(Array.from({ length: 8193 }, (_, i) => i % 256));
function tarFile() {
  const header = Buffer.alloc(512);
  header.write('fixture.bin', 0);
  for (const [offset, length, value] of [[100,8,0o640],[108,8,123],[116,8,456],[124,12,bytes.length],[136,12,1700000000]]) header.write(value.toString(8).padStart(length-1,'0')+'\0',offset);
  header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263);
  header.write([...header].reduce((sum,n)=>sum+n,0).toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length/512)*512-bytes.length+1024)]);
}
function entry(tar) {
  let offset=0;
  while(offset+512<=tar.length) {
    const header=tar.subarray(offset,offset+512);
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    const octal=(start,end)=>parseInt(header.subarray(start,end).toString().replace(/\0.*$/s,'').trim(),8)||0;
    const size=octal(124,136); assert(size>=0 && offset+512+size<=tar.length);
    if(name.replace(/^\.\//,'')==='fixture.bin') return {data:tar.subarray(offset+512,offset+512+size),uid:octal(108,116),gid:octal(116,124),mode:octal(100,108)};
    offset+=512+Math.ceil(size/512)*512;
  }
  throw Error('The copied fixture was not present');
}
function helper(volume, suffix, readonly) {
  const id=text(['container','create','--name',prefix+'-'+suffix,'--network','none','--read-only','--entrypoint','/__dockslate_copy_only','--label','io.dockslate.verification='+prefix,'--mount','type=tmpfs,dst=/var/lib/postgresql','--mount',`type=volume,src=${volume},dst=/__dockslate_transfer,volume-nocopy${readonly?',readonly':''}`,image]);
  assert.match(id,/^[a-f0-9]{64}$/); helpers.push(id);
  const info=inspect('container',id); assert.equal(info.State.Status,'created');
  assert.equal(info.Mounts.filter(v=>v.Type==='volume').length,1);
  assert.equal(info.Mounts.find(v=>v.Name===volume).RW,!readonly);
  return id;
}
try {
  for(const name of volumes) { text(['volume','create','--label','io.dockslate.verification='+prefix,name]); assert.equal(inspect('volume',name).Labels['io.dockslate.verification'],prefix); createdVolumes.push(name); }
  const seed=helper(volumes[0],'seed',false);
  run(['container','cp','--archive','-',seed+':/__dockslate_transfer'],tarFile());
  const source=helper(volumes[0],'source-helper',true);
  const target=helper(volumes[1],'target-helper',false);
  assert.deepEqual(inventory().volumes,[...before.volumes,...volumes].sort()); checks.push('Image VOLUME paths do not allocate anonymous volumes');
  const archive=run(['container','cp','--archive',source+':/__dockslate_transfer/.','-']).stdout;
  const original=entry(archive); assert.deepEqual(original.data,bytes); assert.equal(original.uid,123); assert.equal(original.gid,456); assert.equal(original.mode&0o777,0o640);
  run(['container','cp','--archive','-',target+':/__dockslate_transfer'],archive);
  const copy=entry(run(['container','cp','--archive',target+':/__dockslate_transfer/.','-']).stdout);
  assert.deepEqual(copy.data,bytes); assert.equal(copy.uid,123); assert.equal(copy.gid,456); assert.equal(copy.mode&0o777,0o640); checks.push('Stopped-container volume tar round trip preserves binary content, UID, GID and mode');
  assert.notEqual(run(['container','cp','--archive','-',source+':/__dockslate_transfer'],tarFile(),false).status,0); checks.push('Read-only source mount rejects writes');
  assert(helpers.every(id=>inspect('container',id).State.Status==='created')); checks.push('No fixture process or database was started');
  result.passed=true;
} catch(error) { result.error=String(error); throw error; }
finally {
  const cleanupErrors=[];
  if(text(['info','--format','{{.ID}}'])!==engine) throw Error('Engine changed; automatic fixture cleanup is blocked');
  for(const id of helpers.reverse()) { try { const info=inspect('container',id); assert.equal(info.Config.Labels['io.dockslate.verification'],prefix); assert.equal(info.State.Status,'created'); text(['container','rm',id]); } catch(error) {cleanupErrors.push(String(error));} }
  for(const name of createdVolumes.reverse()) { try { assert.equal(inspect('volume',name).Labels['io.dockslate.verification'],prefix); text(['volume','rm',name]); } catch(error) {cleanupErrors.push(String(error));} }
  assert.deepEqual(inventory(),before,'Original containers, states, images or volumes changed');
  result.cleanupErrors=cleanupErrors; if(cleanupErrors.length) result.passed=false;
  checks.push('Original inventory restored; only labelled new fixtures removed');
  fs.writeFileSync(path.join(outputDirectory,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(cleanupErrors.length) throw Error('Fixture cleanup needs review');
}
