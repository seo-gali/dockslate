import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const fixture=JSON.parse(fs.readFileSync('.analysis/ui014-fixture.json','utf8'));
assert.match(fixture.marker,/^[a-f0-9]{32}$/);
const cli=(...args)=>execFileSync(path.resolve('src-tauri/target/release/docker.exe'),args,{encoding:'utf8',windowsHide:true,timeout:60000}).trim();
const lines=value=>value.split('\n').filter(Boolean).sort();
assert.equal(cli('info','--format','{{.ID}}'),'12f63594-ea3a-45f9-adf2-c594dc91cbc5');
const ownContainers=lines(cli('ps','-a','-q','--no-trunc','--filter','label=dockslate.e2e.fixture='+fixture.marker));
assert.deepEqual(ownContainers,[...fixture.createdContainers].sort());
for(const id of ownContainers){
  assert.ok(!fixture.baseline.containers.some(row=>row.startsWith(id+' ')));
  assert.equal(cli('inspect',id,'--format','{{index .Config.Labels "dockslate.e2e.fixture"}}'),fixture.marker);
  assert.equal(cli('inspect',id,'--format','{{.State.Status}}'),'created');
  assert.equal(cli('inspect',id,'--format','{{len .Mounts}}'),'0');
}
for(const id of ownContainers)cli('rm',id);
const ownImages=[...new Set(lines(cli('image','ls','-q','--no-trunc','--filter','label=dockslate.e2e.fixture='+fixture.marker)))];
for(const id of ownImages){
  assert.ok(!fixture.baseline.images.includes(id));
  assert.equal(cli('image','inspect',id,'--format','{{index .Config.Labels "dockslate.e2e.fixture"}}'),fixture.marker);
  assert.equal(cli('ps','-a','-q','--filter','ancestor='+id),'');
  cli('image','rm',id);
}
assert.deepEqual(lines(cli('ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}')),fixture.baseline.containers);
assert.deepEqual(lines(cli('volume','ls','-q')),fixture.baseline.volumes);
assert.deepEqual(lines(cli('network','ls','-q','--no-trunc')),fixture.baseline.networks);
const result={passed:true,removedOwnedContainers:ownContainers,removedOwnedImages:ownImages,originalContainerIdsAndStatesPreserved:true,originalVolumeAndNetworkIdsPreserved:true,prune:false,volumesDeleted:false};
fs.writeFileSync('.analysis/ui014-cleanup.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
