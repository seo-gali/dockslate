import fs from 'node:fs';
import { connectNative, waitFor, pause } from './native-verification.mjs';

if (!process.argv.includes('--isolated-fixture')) throw Error('Explicit isolated-fixture mode required');
const session = JSON.parse(fs.readFileSync('.analysis/workflow-native-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.explicitRiskApproval || !session.isolatedProfile || session.sha256 !== 'A746B364F516DC39B05A65D47FBE727B57F27CD4D35CD068F5ABF02D149F8A02') throw Error('Approved isolated native session required');
const c = await connectNative(session.portFile);
const report = { observedAt: new Date().toISOString(), artifactSha256: session.sha256, native: true, mockBackend: false, completed: false, checks: [], cleanup: null, failure: null };
const assert = (value, message) => { if (!value) throw Error(message); };
const check = (name, evidence) => { report.checks.push({name, passed:true, evidence}); console.log(JSON.stringify({name, passed:true})); };
const ev = c.evaluate;
const nav = async (page, label) => {
  await ev(`(()=>{const button=[...document.querySelectorAll('nav button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Navigation unavailable');button.click()})()`);
  await waitFor(page, () => ev(`document.querySelector('[data-page="${page}"]')?.hidden===false`));
};
const fixtureName = 'dockslate-interaction-e2e-' + Date.now().toString(36);
let fixtureId = null, baseline = null;
const click = async selector => {
  const point = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
};
const snapshot = async () => {
  const [containers, images, volumes, networks] = await Promise.all([c.invoke('containers_list'), c.invoke('images_list'), c.invoke('volumes_list'), c.invoke('networks_list')]);
  return {containers, images, volumes, networks};
};
const signature = (rows, key) => rows.map(row => row[key]).sort();
try {
  await c.send('Page.bringToFront');
  baseline = await snapshot();
  assert(!baseline.containers.some(row => row.name === fixtureName), 'Fixture name collision');
  const hello = baseline.images.find(image => image.tags.includes('hello-world:latest'));
  const mongo = baseline.containers.find(row => row.name === 'trusting_feistel');
  assert(hello && mongo?.state === 'running', 'Expected existing images and MongoDB required');
  await nav('Containers', '컨테이너');
  await waitFor('real container table', () => ev(`document.querySelectorAll('.container-table tbody tr[data-container-id]').length>=2`));
  const initial = await ev(`(()=>{const t=document.querySelector('.container-table');return{columns:t.querySelectorAll('col').length,handles:t.querySelectorAll('[role="separator"]').length,border:getComputedStyle(t.querySelector('td')).borderRightWidth}})()`);
  assert(initial.columns === 7 && initial.handles === 6 && initial.border !== '0px', 'Resizable table not integrated');
  check('Real container list has seven columns and visible resize separators', initial);
  const handle = '.container-table th:first-child [role="separator"]';
  const widthBefore = await ev(`Number(document.querySelector(${JSON.stringify(handle)}).getAttribute('aria-valuenow'))`);
  const point = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(handle)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x+60,y:point.y,button:'left',buttons:1});
  await c.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x+60,y:point.y,button:'left',clickCount:1});
  await waitFor('persisted native resize', () => ev(`Number(document.querySelector(${JSON.stringify(handle)}).getAttribute('aria-valuenow'))>${widthBefore}`));
  check('Native pointer drag resizes and persists the Name column', await ev(`localStorage.getItem('dockslate.containers.columns.v1')`));
  const mongoRow = `.container-table tr[data-container-id="${mongo.id}"]`;
  await click(mongoRow + ' .port-endpoint');
  await waitFor('Mongo URI copied', () => ev(`document.querySelector('[data-page="Containers"] .operation-banner.success')?.textContent.includes('mongodb://127.0.0.1:32768/')`));
  check('MongoDB port copies the actual Compass connection URI rather than opening HTTP', {uri:'mongodb://127.0.0.1:32768/'});
  await click(mongoRow + ' [aria-haspopup="menu"]');
  assert(await ev(`[...document.querySelectorAll('.container-action-menu [role="menuitem"]')].find(e=>e.textContent.includes('브라우저에서 열기'))?.disabled`), 'Database browser menu should be disabled');
  await c.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape'});
  await c.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape'});
  let databaseRejected = false;
  try { const port = mongo.publishedPorts.find(port => port.privatePort === 27017); await c.invoke('container_open_port', {id:mongo.id,privatePort:27017,publicPort:port.publicPort}); }
  catch (error) { databaseRejected = String(error).includes('database or messaging client'); }
  assert(databaseRejected, 'Backend database protocol rejection missing');
  check('Database browser opening is blocked both by menu and fresh backend validation');

  await nav('Images', '이미지');
  await waitFor('images table', () => ev(`document.querySelector('[aria-controls="run-image-${hello.id.replace(/^sha256:/,'')}"]')!==null`));
  const pullButton = await ev(`(()=>{const b=[...document.querySelectorAll('[data-page="Images"] .header-actions button')].find(b=>b.textContent.includes('이미지 받기'));return b?.outerHTML})()`);
  assert(pullButton, 'Pull image button missing');
  await ev(`(()=>{const b=[...document.querySelectorAll('[data-page="Images"] .header-actions button')].find(b=>b.textContent.includes('이미지 받기'));b.click()})()`);
  await c.setInput('#image-reference', 'hello-world@sha256:11a3eb1597e864c51b3f56733cb2e8a90bf0c284bfc05f9444d81c558bc848aa');
  await click('.pull-form button[type="submit"]');
  await waitFor('real pull progress popup', () => ev(`!!document.querySelector('.image-pull-dialog')`));
  const progressStart = await ev(`({title:document.querySelector('.image-pull-dialog h2')?.textContent,bar:!!document.querySelector('.image-pull-dialog progress'),closeDisabled:document.querySelector('.image-pull-dialog footer button')?.disabled})`);
  assert(progressStart.bar && progressStart.closeDisabled, 'Pull should show a non-dismissible progress dialog');
  check('Actual pinned cached-image Pull starts with progress dialog', progressStart);
  await waitFor('actual image pull completion', () => ev(`document.querySelector('.image-pull-dialog footer button')?.disabled===false`), 120000);
  const completion = await ev(`({title:document.querySelector('.image-pull-dialog h2')?.textContent,layers:document.querySelectorAll('.pull-layer').length,error:document.querySelector('.image-pull-dialog [role="alert"]')?.textContent??null})`);
  assert(completion.title === '이미지 받기가 완료되었습니다.', 'Cached image Pull failed: ' + completion.error);
  check('Real image Pull completes in a localized popup that waits for Close', completion);
  await click('.image-pull-dialog footer button');
  await waitFor('pull popup closed', () => ev(`!document.querySelector('.image-pull-dialog')`));
  await waitFor('dashboard refresh after pull', () => ev(`!document.querySelector('[aria-controls="run-image-${hello.id.replace(/^sha256:/,'')}"]')?.disabled`));
  await click(`[aria-controls="run-image-${hello.id.replace(/^sha256:/,'')}"]`);
  await waitFor('inline image run form', () => ev(`!!document.querySelector('.image-run-row #run-name')`));
  assert(await ev(`document.querySelector('.image-run-row').previousElementSibling.textContent.includes('hello-world:latest')`), 'Run form is not directly below selected image');
  check('Run form expands directly under the selected real image row');
  await c.setInput('#run-name', fixtureName);
  await waitFor('run metadata ready', () => ev(`!document.querySelector('.image-run-row button[type="submit"]')?.disabled`));
  await click('.image-run-row button[type="submit"]');
  await waitFor('created container list navigation', () => ev(`!document.querySelector('[data-page="Containers"]').hidden&&[...document.querySelectorAll('.container-table .name-button')].some(b=>b.textContent===${JSON.stringify(fixtureName)})`), 60000);
  const afterCreate = await c.invoke('containers_list');
  const created = afterCreate.find(container => container.name === fixtureName);
  assert(created && !baseline.containers.some(container => container.id === created.id), 'Isolated fixture identity not verified');
  fixtureId = created.id;
  assert(await ev(`document.querySelectorAll('[role="dialog"]').length===0`), 'Creating a container automatically opened a detail/log dialog');
  assert(await ev(`document.querySelector('.container-table tr[data-container-id="${fixtureId}"]')?.classList.contains('selected')`), 'Created container row not highlighted');
  check('Actual fixture creation navigates to highlighted list row without auto-opening Logs', {id:fixtureId,state:created.state});
  assert(c.exceptions.length === 0, 'Native JavaScript exceptions: ' + c.exceptions.join('; '));
  check('No unhandled JavaScript exceptions throughout actual native workflows');
  report.completed = true;
} catch (error) { report.failure = String(error.stack ?? error); console.error(report.failure); }
finally {
  try {
    if (!fixtureId && baseline) {
      const rows = await c.invoke('containers_list');
      const candidate = rows.find(row => row.name === fixtureName && !baseline.containers.some(before => before.id === row.id));
      if (candidate) fixtureId = candidate.id;
    }
    if (fixtureId) {
      const rows = await c.invoke('containers_list');
      const target = rows.find(row => row.id === fixtureId);
      assert(target?.name === fixtureName && fixtureName.startsWith('dockslate-interaction-e2e-') && ['created','exited','dead'].includes(target.state), 'Refusing cleanup outside stopped isolated fixture');
      const approval = await c.invoke('destructive_preview', {request:{kind:'container_delete',ids:[fixtureId]}});
      const deleted = await c.invoke('destructive_execute', {token:approval.token,approved:true});
      assert(deleted.deleted.includes(fixtureId) && deleted.failed.length === 0, 'Fixture cleanup failed');
    }
    if (baseline) {
      const after = await snapshot();
      assert(JSON.stringify(signature(after.containers,'id')) === JSON.stringify(signature(baseline.containers,'id')), 'Baseline container set changed');
      assert(JSON.stringify(signature(after.images,'id')) === JSON.stringify(signature(baseline.images,'id')), 'Image set changed');
      assert(JSON.stringify(signature(after.volumes,'name')) === JSON.stringify(signature(baseline.volumes,'name')), 'Volume set changed');
      assert(JSON.stringify(signature(after.networks,'id')) === JSON.stringify(signature(baseline.networks,'id')), 'Network set changed');
      report.cleanup = {isolatedFixtureDeleted:!!fixtureId,baselineContainersImagesVolumesNetworksPreserved:true,mongoStillRunning:after.containers.find(row=>row.name==='trusting_feistel')?.state==='running'};
    }
  } catch (error) { report.completed = false; report.cleanup = {failure:String(error.stack ?? error)}; }
  fs.writeFileSync('docs/results/interactions-native-e2e.json', JSON.stringify(report,null,2)+'\n');
  c.close();
}
if (!report.completed) process.exitCode = 1;
