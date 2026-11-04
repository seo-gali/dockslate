import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connectNative,waitFor,pause} from './native-verification.mjs';
const execute=promisify(execFile);
const session=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert(session.approvedByUser&&/^dockslate-events-check-[a-f0-9]{4,16}$/.test(session.testResourcePrefix));
const release=JSON.parse(fs.readFileSync('site/release.json','utf8'));
const cli=path.resolve(`downloads/DockSlate-${release.version}-windows-x64/bin/docker.exe`);
const docker=async args=>(await execute(cli,args,{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:256*1024})).stdout.trim();
const lines=text=>text.split(/\r?\n/).filter(Boolean).sort();
// Docker 기본 네트워크는 daemon 재시작 시 재생성되므로 사용자 네트워크만 ID까지 비교
const inventory=async()=>({containers:lines(await docker(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}'])),images:lines(await docker(['image','ls','-q','--no-trunc'])),volumes:lines(await docker(['volume','ls','-q'])),networks:lines(await docker(['network','ls','--no-trunc','--format','{{.Name}} {{.ID}} {{.Driver}} {{.Scope}}'])).map(line=>{const fields=line.split(' ');if(['bridge','host','none'].includes(fields[0]))fields[1]='<daemon-managed>';return fields.join(' ');})});
const c=await connectNative(session.portFile),checks=[];
const check=(name,evidence={})=>{checks.push({name,passed:true,...evidence});console.log(name);};
const button=text=>`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
const click=async expression=>{await waitFor('enabled control',()=>c.evaluate(`!!(${expression})&&!(${expression}).disabled`));await c.evaluate(`(${expression}).click()`);};
const action=async kind=>{
  await click(button(kind==='stop'?'런타임 중지…':'런타임 시작…'));
  await click(`document.querySelector('[role="dialog"] input[type="checkbox"]')`);
  await click(`[...document.querySelectorAll('[role="dialog"] footer button')].find(e=>e.textContent.trim()===${JSON.stringify(kind==='stop'?'중지 승인 및 실행':'시작 승인 및 실행')})`);
  await waitFor('runtime '+kind+' completed',async()=>{
    const status=await c.invoke('runtime_status');
    assert(!['failed','unsupported','not_installed'].includes(status.state),status.message);
    return status.state===(kind==='stop'?'stopped':'running');
  },180000);
  await waitFor('runtime confirmation closed',()=>c.evaluate(`!document.querySelector('[role="dialog"]')`));
};
let before,running=[],engineId,otherDistros;let stopAttempted=false;
try{
  const status=await c.invoke('runtime_status');assert.equal(status.distribution,'DockSlate');assert.equal(status.state,'running');assert(status.keeperVerified);
  engineId=(await c.invoke('engine_status')).id;assert(engineId);
  before=await inventory();running=before.containers.filter(line=>line.endsWith(' running')).map(line=>line.split(' ')[0]);
  assert(before.containers.length===4&&running.length===3,'Reconfirm changed user container scope before restarting.');
  const wsl=await c.invoke('wsl_inventory');otherDistros=wsl.runningDistributions.filter(name=>name!=='DockSlate').sort();
  fs.writeFileSync('.analysis/engine-restart-restore.json',JSON.stringify({observedAt:new Date().toISOString(),engineId,before,running,otherDistros},null,2)+'\n');
  await click(`[...document.querySelectorAll('nav button')].find(e=>e.textContent.trim()==='설정')`);
  await waitFor('Settings rendered',()=>c.evaluate(`!!document.querySelector('[data-page="Settings"] h1')`));
  await click(`[...document.querySelectorAll('[data-page="Settings"] [role="tab"]')].find(e=>e.textContent.trim()==='런타임')`);
  stopAttempted=true;await docker(['stop','--time','30',...running]);
  assert.equal(await docker(['ps','-q']),'');check('original three SQL containers stopped gracefully');
  await pause(2500);
  await action('stop');
  const stopped=await c.invoke('wsl_inventory');assert(!stopped.runningDistributions.includes('DockSlate'));assert.deepEqual(stopped.runningDistributions.sort(),otherDistros);
  check('actual UI stops only owned DockSlate WSL distribution');
  const subscriptions=c.calls.filter(call=>call.command==='engine_events_start').length;
  await action('start');
  assert.equal((await c.invoke('engine_status')).id,engineId);
  assert.equal(await docker(['ps','-q']),'');
  check('actual UI restarts same owned engine without starting stopped containers');
  await docker(['start',...running]);
  await waitFor('original running states restored',async()=>JSON.stringify(await inventory())===JSON.stringify(before),90000);
  await waitFor('event subscription resumed',()=>Promise.resolve(c.calls.filter(call=>call.command==='engine_events_start'&&call.durationMs!=null).length>subscriptions),30000);
  check('event subscription resumes after actual WSL restart');
  await click(`[...document.querySelectorAll('nav button')].find(e=>e.textContent.trim()==='컨테이너')`);
  await c.setInput('[data-page="Containers"] input[type="search"]','');
  await waitFor('all original SQL rows restored',()=>c.evaluate(`document.querySelector('[data-page="Containers"]').innerText.includes('sqlpvi-test-mssql-1')&&document.querySelector('[data-page="Containers"]').innerText.includes('sqlpvi-test-postgres-1')`));
  const afterWsl=await c.invoke('wsl_inventory');assert.deepEqual(afterWsl.runningDistributions.filter(name=>name!=='DockSlate').sort(),otherDistros);
  await waitFor('SQL container health restored',async()=>{for(const id of running){const health=await docker(['inspect',id,'--format','{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}']);if(!['healthy','none'].includes(health))return false;}return true;},90000);
  assert.deepEqual(await inventory(),before);check('original IDs states images volumes networks and other distributions preserved',{containers:4,running:3,volumes:before.volumes.length});
  assert.deepEqual(c.exceptions,[]);check('no renderer exceptions during owned WSL restart');
}finally{
  if(stopAttempted){
    let status=await c.invoke('runtime_status');
    if(status.state==='stopped'){await c.invoke('runtime_start',{approved:true});await waitFor('restore engine',async()=>(await c.invoke('runtime_status')).state==='running',180000);}
    const actual=lines(await docker(['ps','-q','--no-trunc']));
    const restore=running.filter(id=>!actual.includes(id));if(restore.length)await docker(['start',...restore]);
    assert.deepEqual(await inventory(),before,'Original state must be restored even on a failed check.');
  }
  fs.writeFileSync('.analysis/engine-restart-native-result.json',JSON.stringify({observedAt:new Date().toISOString(),sha256:session.sha256,checks,exceptions:c.exceptions,engineId,originalRunningContainerIds:running,scope:'Approved actual owned WSL stop/start and restoration; no global WSL shutdown, kernel update or DB writes.'},null,2)+'\n');
  c.close();
}
