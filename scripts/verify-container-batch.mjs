import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connectNative,waitFor,pause} from './native-verification.mjs';

if(!process.argv[2])throw Error('Provide a native session JSON with explicit scratch-container lifecycle approval.');
const session=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
assert(session.approvedByUser && session.approvalScope?.includes('scratch-container-lifecycle'));
const prefix=session.testResourcePrefix;assert.match(prefix,/^dockslate-bulk-check-[a-z0-9]{4,16}$/);
const release=JSON.parse(fs.readFileSync('site/release.json','utf8'));assert.match(release.version,/^\d+\.\d+\.\d+$/);
const cli=path.resolve(`downloads/DockSlate-${release.version}-windows-x64/bin/docker.exe`);
const execute=promisify(execFile);
const docker=async args=>(await execute(cli,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:256*1024,env:{...process.env,LOCALAPPDATA:session.appData}})).stdout.trim();
const lines=value=>value.split(/\r?\n/).filter(Boolean).sort();
const inventory=async()=>({containers:lines(await docker(['ps','-a','--no-trunc','--format','{{.ID}} {{.State}}'])),images:lines(await docker(['image','ls','-q','--no-trunc'])),volumes:lines(await docker(['volume','ls','-q'])),networks:lines(await docker(['network','ls','-q','--no-trunc']))});
const before=await inventory(),created=[],checks=[];
assert(!(await docker(['ps','-a','--format','{{.Names}}'])).split(/\r?\n/).some(name=>name.startsWith(prefix)));
const [image,volumes]=(await docker(['image','inspect','postgres:18.6-alpine','--format','{{.Id}}|{{json .Config.Volumes}}'])).split('|');
assert.match(image,/^sha256:[a-f0-9]{64}$/);assert.deepEqual(Object.keys(JSON.parse(volumes)),['/var/lib/postgresql']);
const c=await connectNative(session.portFile);
let completed=false;
const check=(name,evidence={})=>{checks.push({name,passed:true,...evidence});console.log(name);};
const click=async expression=>{await waitFor('control ready',()=>c.evaluate(`!!(${expression})&&!(${expression}).disabled`));await c.evaluate(`(${expression}).click()`);await pause(100);};
const group=`document.querySelector('[aria-label="선택한 컨테이너 작업"]')`;
const selectAll=async()=>click(`document.querySelector('.container-table thead input[type="checkbox"]')`);
const run=async(action,label,completed,skipped=0)=>{
  await selectAll();const previous=c.calls.filter(call=>call.command==='containers_action').length;
  await click(`[...${group}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`);
  await waitFor(action+' result',()=>c.evaluate(`document.querySelector('[data-page="Containers"]')?.innerText.includes(${JSON.stringify(`${label}: 완료 ${completed}개 · 대상 아님 ${skipped}개 · 실패 0개`)})`));
  await waitFor('dashboard settled',()=>c.evaluate(`!document.querySelector('.refresh-button[disabled]')&&![...document.querySelectorAll('.container-table thead input')].some(e=>e.disabled)`));
  assert.equal(c.calls.filter(call=>call.command==='containers_action').length-previous,1);
  assert.equal(c.calls.filter(call=>call.command==='container_action').length,0);
  check('one batch IPC for '+action,{completed,skipped});
};
try {
  for(const suffix of ['a','b']) {
    const id=await docker(['create','--name',prefix+'-'+suffix,'--label','io.dockslate.verification='+prefix,'--read-only','--network','none','--tmpfs','/var/lib/postgresql','--entrypoint','/bin/sh',image,'-c','sleep 3600']);
    assert.match(id,/^[a-f0-9]{64}$/);created.push(id);
    assert.equal(await docker(['inspect',id,'--format','{{len .Mounts}}']), '1');
  }
  await docker(['start',created[0]]);
  await click(`[...document.querySelectorAll('nav button')].find(e=>e.textContent.trim()==='컨테이너')`);
  await c.setInput('[data-page="Containers"] input[type="search"]',prefix);
  await waitFor('two scratch rows',()=>c.evaluate(`document.querySelectorAll('.container-table tbody tr[data-container-id]').length===2`));
  await selectAll();await click(`document.querySelector('.container-table thead th:nth-child(2) .table-sort')`);
  assert.equal(await c.evaluate(`document.querySelectorAll('.container-table tbody input:checked').length`),2);
  await c.setSelect('[data-page="Containers"] .table-filter','running');
  await waitFor('filter clears selection',()=>c.evaluate(`!${group}`));
  await c.setSelect('[data-page="Containers"] .table-filter','');
  check('selection survives sorting and clears on state filtering');
  await run('start','시작',1,1);
  for(const id of created)assert.equal(await docker(['inspect',id,'--format','{{.State.Status}}']),'running');
  await run('stop','중지',2);
  const skipped=await c.invoke('containers_action',{ids:created,action:'stop'});
  assert(skipped.results.every(item=>item.outcome==='skipped'&&item.state==='exited'));
  check('stopped containers skipped instead of restarted');
  await run('start','시작',2);
  const starts=await Promise.all(created.map(id=>docker(['inspect',id,'--format','{{.State.StartedAt}}'])));
  await run('restart','재시작',2);
  for(let index=0;index<created.length;index++)assert.notEqual(await docker(['inspect',created[index],'--format','{{.State.StartedAt}}']),starts[index]);
  const partial=await c.invoke('containers_action',{ids:[created[0],'0'.repeat(64)],action:'stop'});
  assert.equal(partial.results[0].outcome,'completed');assert.equal(partial.results[1].outcome,'failed');assert(partial.results[1].error);
  check('per-item partial failure keeps completed work and returns a reason');
  assert.deepEqual(c.exceptions,[]);
  completed=true;
} finally {
  for(const id of created) {
    assert.equal(await docker(['inspect',id,'--format','{{index .Config.Labels "io.dockslate.verification"}}']),prefix);
    await docker(['stop','--time','1',id]);await docker(['rm',id]);
  }
  await c.setInput('[data-page="Containers"] input[type="search"]','');
  c.close();
  const after=await inventory();assert.deepEqual(after,before);
  check('scratch containers removed; user states, images, volumes and networks preserved');
  fs.writeFileSync('.analysis/container-batch-verification.json',JSON.stringify({observedAt:new Date().toISOString(),artifactSha256:session.sha256,completed,checks,existingResourcesPreserved:true},null,2)+'\n');
}
