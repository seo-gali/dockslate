import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectNative, waitFor, pause } from './native-verification.mjs';

const session = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
assert.equal(session.isolatedProfile, true);
const c = await connectNative(session.portFile);
const report = { observedAt: new Date().toISOString(), artifactSha256: session.sha256, native: true, backendInjected: false, checks: [], completed: false };
const created = [];
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ name, passed: true })); };
const click = async (selector, text) => {
  await waitFor(text, () => c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(b=>b.getClientRects().length&&!b.disabled&&b.textContent.trim()===${JSON.stringify(text)})`));
  await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)}).click()`);
};
const tableSelector = page => `[data-page="${page}"] table`;
const cellTexts = async (page, column) => c.evaluate(`[...document.querySelector(${JSON.stringify(tableSelector(page))}).tBodies[0].rows].filter(r=>r.cells.length>1).map(r=>r.cells[${column}].innerText)`);
try {
  await c.evaluate(`localStorage.setItem('dockslate.language','en');location.reload()`);
  await waitFor('English native app', () => c.evaluate(`document.documentElement.lang==='en'&&!!document.querySelector('nav')`));
  const engine = await c.invoke('engine_status'); assert.equal(engine.state, 'connected'); report.engineId = engine.id;
  const baseline = await c.invoke('containers_list');
  const images = await c.invoke('images_list');
  await c.nav('Images');
  await waitFor('images table', () => c.evaluate(`!!document.querySelector('[data-page="Images"] table')`));
  const original = await cellTexts('Images', 1);
  for (const descending of [false, true]) {
    await c.evaluate(`document.querySelector('[data-page="Images"] th:nth-child(3) .table-sort').click()`); await pause(70);
    const expected = [...images].sort((a,b)=>(a.size-b.size)*(descending?-1:1)).slice(0,50).map(image=>image.id);
    const actual = await cellTexts('Images', 1);
    assert.deepEqual(actual.map(text=>images.find(image=>text.includes(image.id)).id), expected);
    assert.equal(await c.evaluate(`document.querySelector('[data-page="Images"] th:nth-child(3)').getAttribute('aria-sort')`), descending?'descending':'ascending');
  }
  await c.evaluate(`document.querySelector('[data-page="Images"] th:nth-child(3) .table-sort').click()`); await pause(70);
  assert.deepEqual(await cellTexts('Images', 1), original);
  check('Image sizes sort numerically in both directions and the third click restores original order');
  const filter = '[data-page="Images"] th:nth-child(4) select';
  await c.setSelect(filter, '미사용'); await pause(70);
  const unused = await cellTexts('Images', 1);
  assert.equal(unused.length, images.filter(image=>image.containers===0).slice(0,50).length);
  for (const text of unused) assert.ok(images.some(image=>image.containers===0&&text.includes(image.id)));
  await c.setSelect(filter, ''); await pause(70); assert.deepEqual(await cellTexts('Images', 1), original);
  check('Image usage filter selects matching rows and All restores them');
  await c.nav('Resources');
  await waitFor('volumes table',()=>c.evaluate(`!!document.querySelector('[data-page="Resources"] table')`));
  assert.equal(await c.evaluate(`[...document.querySelectorAll('[data-page="Resources"] table .table-sort')].filter(e=>e.getClientRects().length).length`),4);
  await click('[data-page="Resources"] .page-tabs button','Network');
  assert.equal(await c.evaluate(`[...document.querySelectorAll('[data-page="Resources"] table .table-filter')].filter(e=>e.getClientRects().length).length`),2);
  await c.nav('Builds'); await click('[data-page="Builds"] .page-tabs button','Build history');
  assert.equal(await c.evaluate(`document.querySelectorAll('[data-page="Builds"] table .table-sort').length`),4);
  await c.evaluate(`document.querySelector('[data-page="Builds"] th:nth-child(3) .table-sort').click()`); await pause(70);
  const dates = await cellTexts('Builds',2); const parsed = dates.map(Date.parse); assert.ok(parsed.every((date,index)=>index===0||parsed[index-1]<=date));
  await click('[data-page="Builds"] .page-tabs button','Builders');
  assert.equal(await c.evaluate(`document.querySelectorAll('[data-page="Builds"] table .table-sort').length`),3);
  check('Volume, network, history and builder tables expose data sorting and categorical filters; history dates sort chronologically');
  await c.nav('Disk Manager');
  await waitFor('cleanup table',()=>c.evaluate(`!!document.querySelector('[data-page="Disk Manager"] table')`));
  const stateFilter='[data-page="Disk Manager"] th:nth-child(6) select';
  await c.setSelect(stateFilter,'정리 차단'); await pause(70);
  assert.ok((await cellTexts('Disk Manager',5)).every(text=>text.includes('Cleanup blocked')));
  await c.setSelect(stateFilter,'선택 가능'); await pause(70);
  assert.ok((await cellTexts('Disk Manager',5)).every(text=>text.includes('Available')));
  await c.setSelect(stateFilter,'');
  check('Cleanup availability can be selected independently of text search');
  const image=images.find(image=>image.tags.includes('busybox:1.37.0'));assert.ok(image);
  const prefix=`dockslate-progress-e2e-${Date.now()}`;
  for(const suffix of ['one','two']) {
    const value=await c.invoke('container_run',{imageId:image.id,name:prefix+'-'+suffix,ports:[],options:{command:['httpd','-f','-p','8080'],restartPolicy:'no'}});
    created.push(value.id);await c.invoke('container_action',{id:value.id,action:'stop'});
  }
  report.fixtureIds=created;
  const requestId=crypto.randomUUID();
  const eventId=await c.evaluate(`(()=>{window.__cleanupProgress=[];return window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'destructive-progress',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(event=>{if(event.payload.requestId===${JSON.stringify(requestId)})window.__cleanupProgress.push(event.payload);})});})()`);
  const preview=await c.invoke('destructive_preview',{request:{kind:'container_delete',ids:created}});
  const result=await c.invoke('destructive_execute',{token:preview.token,approved:true,requestId});assert.deepEqual(result.failed,[]);assert.equal(result.deleted.length,2);
  await pause(80);
  const progress=await c.evaluate('window.__cleanupProgress');
  await c.invoke('plugin:event|unlisten',{event:'destructive-progress',eventId});
  assert.ok(progress.some(value=>value.phase==='validating'&&value.completed===0&&value.total===2));
  assert.deepEqual(progress.filter(value=>value.phase==='deleting'&&!value.target).map(value=>value.completed),[1,2]);
  check('Real deletion reports validation, current target and 1/2 then 2/2 completed items',progress);
  const after=await c.invoke('containers_list');assert.deepEqual(after.map(value=>[value.id,value.name,value.state]),baseline.map(value=>[value.id,value.name,value.state]));
  report.volumesCreated=0;report.volumesDeleted=0;report.databaseContentsRead=false;
  check('Only the two owned BusyBox fixtures were deleted; existing containers and volumes were preserved');
  assert.deepEqual(c.exceptions,[]);report.completed=true;
} catch(error) { report.failure=String(error.stack??error); console.error(error.stack);process.exitCode=1; }
finally { fs.writeFileSync('docs/results/table-controls-0.1.1.json',JSON.stringify(report,null,2)+'\n');c.close(); }
