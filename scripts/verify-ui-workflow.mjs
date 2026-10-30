import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectNative, waitFor, pause } from './native-verification.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const session=read(process.argv[2]??'.analysis/ui014-session.json');
const fixture=read(process.argv[3]??'.analysis/ui014-fixture.json');
assert.ok(session.isolatedProfile&&session.nonDatabaseFixturesOnly);
assert.match(fixture.marker,/^[a-f0-9]{32}$/);
assert.equal(path.resolve(fixture.root),path.resolve('.analysis/file-import-fixture-ui014-'+fixture.marker));
assert.equal(createHash('sha256').update(fs.readFileSync(session.artifact)).digest('hex').toUpperCase(),session.sha256);
const docker=path.resolve('src-tauri/target/release/docker.exe');
const cli=(...args)=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,timeout:90000}).trim();
assert.equal(cli('info','--format','{{.ID}}'),'12f63594-ea3a-45f9-adf2-c594dc91cbc5');
const c=await connectNative(session.portFile);
const report={observedAt:new Date().toISOString(),appVersion:'0.1.4',sha256:session.sha256,checks:[],fixtureMarker:fixture.marker,mutations:'Only owned scratch images and never-started containers; no volumes, new networks, database operations, or prune'};
if(fixture.createdContainers.length){const prior=read('docs/results/ui-workflow-0.1.4.json');assert.equal(prior.sha256,session.sha256);assert.equal(prior.fixtureMarker,fixture.marker);report.checks=prior.checks;report.resumedAfter='Corrected CDP Enter text; source-panel checks already passed on the same binary and fixture';}
const check=(name,evidence)=>{report.checks=report.checks.filter(item=>item.name!==name);report.checks.push({name,passed:true,evidence});console.log(name);};
const click=async(selector,text)=>{
  await waitFor('Enabled '+text,()=>c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.getClientRects().length&&!e.disabled&&e.textContent.trim()===${JSON.stringify(text)})`),20000);
  await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)}).click()`);
};
const present=selector=>c.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const selectFile=async(kind,file)=>{
  await click('.image-build-panel .section-heading button',kind==='dockerfile'?'Choose Dockerfile':'Choose Compose file');
  console.log(execFileSync('powershell.exe',['-NoProfile','-File','scripts/select-native-import-file.ps1','-TargetProcessId',String(session.pid),'-Path',path.join(fixture.root,file)],{encoding:'utf8',windowsHide:true,timeout:30000}).trim());
};
const completed=async attr=>{
  await waitFor(attr+' terminal state',()=>present(`[${attr}="completed"],[${attr}="failed"]`),90000);
  assert.ok(await present(`[${attr}="completed"]`),await c.evaluate(`document.querySelector('[data-page="Builds"]').innerText`));
};
const footer=async()=>{
  const value=await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.image-build-panel')].find(e=>e.querySelector('.build-panel-footer')),f=p.querySelector('.build-panel-footer'),b=f.querySelector('button');return {text:b.textContent,right:f.getBoundingClientRect().right-b.getBoundingClientRect().right,topClose:p.querySelectorAll('.section-heading>.icon-button').length}})()`);
  assert.equal(value.text,'Close file selection');assert.ok(Math.abs(value.right)<2);assert.equal(value.topClose,0);return value;
};
try {
  await c.evaluate(`localStorage.setItem('dockslate.language','en');location.reload()`);
  await waitFor('English native window',()=>c.evaluate(`document.documentElement.lang==='en'&&!!document.querySelector('nav')`));
  const engine=await c.invoke('engine_status');assert.equal(engine.appVersion,'0.1.4');assert.equal(engine.id,'12f63594-ea3a-45f9-adf2-c594dc91cbc5');
  if(!fixture.createdContainers.length){
  await c.nav('Builds');
  fs.writeFileSync(path.join(fixture.root,'compose.Dockerfile'),`FROM scratch\nLABEL dockslate.e2e.fixture="${fixture.marker}" dockslate.e2e.role="compose"\nCMD ["/not-run"]\n`);
  fs.writeFileSync(path.join(fixture.root,'compose.yaml'),'services:\n  web:\n    build:\n      context: .\n      dockerfile: compose.Dockerfile\n');
  await selectFile('dockerfile','Dockerfile');
  await completed('data-build-state');
  const tag=await c.evaluate(`document.querySelector('#build-tag').value`);fixture.dockerfileTag=tag;
  assert.equal(await c.evaluate(`document.querySelector('.image-build-panel form button[type=submit]').textContent`),'Rebuild');
  const calls=c.calls.filter(call=>call.command==='image_build_start').length;
  await click('.image-build-panel form button','Rebuild');
  await waitFor('App build running',()=>present('[data-build-state="running"]'));
  await click('[data-page="Builds"] .page-tabs button','Active builds');
  assert.ok(await c.evaluate(`document.querySelector('.build-active-summary').innerText.includes(${JSON.stringify(tag)})`));
  assert.ok(!await c.evaluate(`document.querySelector('[data-page="Builds"]').innerText.includes('There are no active builds')`));
  await click('[data-page="Builds"] button','View build logs');
  await completed('data-build-state');assert.equal(c.calls.filter(call=>call.command==='image_build_start').length,calls+1);
  check('Dockerfile auto-build, explicit Rebuild, and active-build log navigation',await footer());
  await click('.build-panel-footer button','Close file selection');
  assert.ok(!await present('#build-context'));assert.ok(!await present('[data-build-state]'));
  check('Closing Dockerfile clears selection and previous job');
  await selectFile('compose','compose.yaml');await completed('data-compose-state');
  fixture.project=await c.evaluate(`document.querySelector('.project-identity code').textContent`);
  assert.match(fixture.project,/^dockslate-import-[a-f0-9]{32}$/);
  assert.ok(await c.evaluate(`document.querySelector('.project-identity').parentElement.innerText.includes('Imported project '+${JSON.stringify(fixture.project.slice(-32,-24))})`));
  assert.ok(await c.evaluate(`document.querySelector('[data-compose-state]').innerText.includes('Compose build finished.')`));
  check('Compose short display name and retained full identity',await footer());
  await click('.build-panel-footer button','Close file selection');
  await waitFor('Compose selection discarded',()=>c.evaluate(`!document.querySelector('.project-identity')`));
  check('Compose and Dockerfile use the same bottom-right close action');
  for(const [suffix,project] of [['managed',fixture.project],['ordinary','ui014-normal-'+fixture.marker.slice(0,8)]]) {
    const id=cli('create','--name','dockslate-ui014-'+suffix+'-'+fixture.marker.slice(0,8),'--network','none','--label','dockslate.e2e.fixture='+fixture.marker,'--label','com.docker.compose.project='+project,fixture.groupTag);
    assert.match(id,/^[a-f0-9]{64}$/);fixture.createdContainers.push(id);
    fs.writeFileSync('.analysis/ui014-fixture.json',JSON.stringify(fixture,null,2)+'\n');
  }
  }
  await click('button','Refresh all');await pause(300);await c.nav('Containers');
  await waitFor('Owned fixture rows',()=>present(`[data-container-id="${fixture.createdContainers[0]}"]`));
  const groups=await c.evaluate(`[...document.querySelectorAll('.group-toggle')].map(b=>b.innerText)`);
  assert.ok(groups.some(s=>s.includes('Imported project '+fixture.project.slice(-32,-24))));
  assert.ok(groups.some(s=>s.includes('ui014-normal-'+fixture.marker.slice(0,8))));
  const groupSelector=`[data-container-id="${fixture.createdContainers[0]}"]`;
  await c.evaluate(`document.querySelector(${JSON.stringify(groupSelector)}).previousElementSibling.querySelector('button').click()`);
  assert.ok(!await present(groupSelector));
  await c.evaluate(`[...document.querySelectorAll('.group-toggle')].find(b=>b.getAttribute('aria-expanded')==='false').focus()`);
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor('Keyboard expanded group',()=>present(groupSelector));
  check('Compose groups collapse and expand by pointer and keyboard; ordinary names unchanged',groups);
  await c.nav('Disk Manager');
  await waitFor('Cleanup loaded',()=>present('.candidate-table tbody input[type=checkbox]'));
  await c.setSelect('[data-page="Disk Manager"] .table-filter','Image');await pause(150);
  const header='[data-page="Disk Manager"] .candidate-table thead input';
  await waitFor('Eligible image rows after refresh',()=>present('.candidate-table tbody input:not(:disabled)'));
  await c.evaluate(`document.querySelector('.candidate-table tbody input:not(:disabled)').click()`);
  assert.ok(await c.evaluate(`document.querySelector(${JSON.stringify(header)}).indeterminate`));
  await c.evaluate(`document.querySelector(${JSON.stringify(header)}).click()`);
  assert.ok(await c.evaluate(`document.querySelector(${JSON.stringify(header)}).checked&&[...document.querySelectorAll('.candidate-table tbody input')].every(e=>e.disabled?!e.checked:e.checked)`));
  const selected=await c.evaluate(`[...document.querySelectorAll('.candidate-table tbody input:checked')].map(e=>e.getAttribute('aria-label'))`);
  assert.ok(selected.length>=2);
  await c.setSelect('[data-page="Disk Manager"] .table-filter','Build cache');await pause(100);
  if(!await c.evaluate(`document.querySelector(${JSON.stringify(header)}).disabled`)){
    await c.evaluate(`document.querySelector(${JSON.stringify(header)}).click()`);await pause(100);
    await c.evaluate(`document.querySelector(${JSON.stringify(header)}).click()`);
  }
  await c.setSelect('[data-page="Disk Manager"] .table-filter','Image');await pause(100);
  assert.deepEqual(await c.evaluate(`[...document.querySelectorAll('.candidate-table tbody input:checked')].map(e=>e.getAttribute('aria-label'))`),selected);
  await c.setSelect('[data-page="Disk Manager"] .table-filter-field:last-child select','\uC815\uB9AC \uCC28\uB2E8');await pause(100);
  assert.ok(await c.evaluate(`document.querySelector(${JSON.stringify(header)}).disabled`));
  check('Cleanup selects only eligible filtered results, shows mixed state, retains hidden selections, disables blocked-only selection',{selectedCount:selected.length});
  await c.nav('Images');
  const ownImages=(await c.invoke('images_list')).filter(image=>image.tags.includes(fixture.dockerfileTag)||image.tags.some(t=>t.startsWith(fixture.project+'-web:')));
  assert.equal(ownImages.length,2);
  for(const image of ownImages)assert.equal(cli('image','inspect',image.id,'--format','{{index .Config.Labels "dockslate.e2e.fixture"}}'),fixture.marker);
  const mongo='sha256:dc28ed5a9d0fc616903c3f463bb1e53b92b49f441721b91926e87d90bf957ce8';
  for(const id of [...ownImages.map(i=>i.id),mongo])await c.evaluate(`(()=>{const row=[...document.querySelectorAll('[data-page="Images"] tbody tr')].find(r=>r.innerText.includes(${JSON.stringify(id)}));if(!row)throw Error('Image row missing');row.querySelector('input[type=checkbox]').click()})()`);
  await click('[data-page="Images"] button','Delete selected (3)');
  await waitFor('Image removal preview',()=>present('.image-removal-item'));
  await waitFor('Image references validated',()=>c.evaluate(`!!document.querySelector('.confirm-dialog')&&!document.querySelector('.confirm-dialog .loading-line')`));
  for(const size of [{width:1668,height:900},{width:1000,height:640}]){
    await c.send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});await pause(120);
    const geometry=await c.evaluate(`(()=>{const d=document.querySelector('.confirm-dialog'),body=d.querySelector('.dialog-content'),f=d.querySelector('footer'),a=d.querySelector('.acknowledgement'),cards=[...d.querySelectorAll('.image-removal-item')];return {width:d.getBoundingClientRect().width,height:d.getBoundingClientRect().height,top:d.getBoundingClientRect().top,bottom:d.getBoundingClientRect().bottom,footer:f.getBoundingClientRect().bottom,ack:a.getBoundingClientRect().bottom,columns:new Set(cards.map(e=>Math.round(e.getBoundingClientRect().x))).size,contentHeight:body.clientHeight,contentScroll:body.scrollHeight}})()`);
    assert.ok(geometry.width>520&&geometry.width<=size.width-40);assert.ok(geometry.top>=0&&geometry.bottom<=size.height);assert.ok(geometry.footer<=size.height&&geometry.ack<=size.height);assert.ok(geometry.height<=680);assert.ok(geometry.columns>=2);
    check('Responsive confirmation at '+size.width+'x'+size.height,geometry);
    if(size.width===1000){const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.analysis/ui014-confirmation.png',Buffer.from(shot.data,'base64'));}
  }
  assert.equal(await c.evaluate(`document.querySelector('.confirm-dialog .acknowledgement input').checked`),false);
  await click('.confirm-dialog footer button','Cancel');
  check('Image confirmation retains acknowledgement and cancellation; original images never executed');
  await c.nav('Builds');await click('[data-page="Builds"] .page-tabs button','Builder management');
  assert.ok(await c.evaluate(`document.querySelector('[data-page="Builds"]').innerText.includes('Choose the environment for your next image build.')`));
  assert.ok(!await c.evaluate(`document.querySelector('[data-page="Builds"]').innerText.includes('Recent app build')`));
  check('Builder management explains its purpose without unrelated completed-build badge');
  assert.equal(c.exceptions.length,0,JSON.stringify(c.exceptions));
  report.passed=true;
}finally{
  fs.writeFileSync('.analysis/ui014-fixture.json',JSON.stringify(fixture,null,2)+'\n');
  await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  fs.writeFileSync('docs/results/ui-workflow-0.1.4.json',JSON.stringify(report,null,2)+'\n');
  await c.close();
}
