import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connectNative, waitFor, pause } from './native-verification.mjs';

const session = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/table-layout-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.isolatedProfile || !session.readOnlyVerification) throw Error('Owned isolated read-only native session required');
assert.equal(createHash('sha256').update(fs.readFileSync(session.artifact)).digest('hex').toUpperCase(), session.sha256);
const c = await connectNative(session.portFile);
const report = { observedAt: new Date().toISOString(), artifact: session.artifact, sha256: session.sha256, checks: [], mutations: false };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(name); };
const click = async (selector, text) => {
  await waitFor(text, () => c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)})`));
  await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)}).click()`);
};
const metrics = () => c.evaluate(`(()=>{
  const page=document.querySelector('[data-page]:not([hidden])');
  const table=[...page.querySelectorAll('table')].find(e=>e.getClientRects().length);
  if(!table)return null;
  const wrap=table.parentElement, main=document.querySelector('main');
  const minima=[...table.querySelectorAll('[role=separator]')].reduce((sum,e)=>sum+Number(e.getAttribute('aria-valuemin')),0);
  return {page:page.dataset.page,viewport:innerWidth,available:wrap.clientWidth,width:table.getBoundingClientRect().width,minima,
    mainHeight:main.clientHeight,mainScroll:main.scrollHeight,height:wrap.clientHeight,scrollHeight:wrap.scrollHeight,
    filterWidths:[...page.querySelectorAll('.table-filter')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().width)};
})()`);
const fit = async name => {
  await waitFor(name, async () => !!await metrics()); await pause(150);
  const value = await metrics();
  assert.ok(value.height > 35, JSON.stringify(value));
  assert.ok(value.mainScroll <= value.mainHeight + 2, JSON.stringify(value));
  if (value.available >= value.minima) assert.ok(Math.abs(value.width - value.available) <= 2, JSON.stringify(value));
  assert.ok(value.filterWidths.every(width => width > 40 && width < 140), JSON.stringify(value));
  check(name, value); return value;
};
try {
  await c.evaluate(`localStorage.setItem('dockslate.language','en');location.reload()`);
  await waitFor('English app', () => c.evaluate(`document.documentElement.lang==='en'&&!!document.querySelector('nav')`));
  const original = await c.invoke('containers_list');
  const engine = await c.invoke('engine_status'); report.engineId = engine.id; report.appVersion = engine.appVersion;
  assert.equal(engine.state, 'connected');
  assert.equal(engine.appVersion, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
  await c.nav('Containers'); await fit('Containers at 1000x640');
  const ids = original.flatMap(row => [row.id, row.image]);
  const text = await c.evaluate(`document.querySelector('[data-page="Containers"] tbody').innerText`);
  assert.ok(ids.every(id => !text.includes(id))); check('Container and image IDs removed only from container rows');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1668, height: 900, deviceScaleFactor: 1, mobile: false });
  await fit('Existing container table refits after widening the window');
  const beforeResize = await c.evaluate(`(()=>{const handle=document.querySelector('[data-page="Containers"] [role=separator]');handle.focus();return Number(handle.getAttribute('aria-valuenow'))})()`);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  const resized = await metrics();
  const afterResize = await c.evaluate(`Number(document.querySelector('[data-page="Containers"] [role=separator]').getAttribute('aria-valuenow'))`);
  assert.equal(afterResize, beforeResize + 10);
  assert.equal(await c.evaluate(`JSON.parse(localStorage.getItem('dockslate.containers.columns.v1')).widths.name`), afterResize);
  assert.ok(resized.width >= resized.available - 2, JSON.stringify(resized));
  check('Manual column resizing keeps the full table width', resized);
  if (original.length) {
    await c.evaluate(`document.querySelector('[data-page="Containers"] tbody .name-button').click()`);
    await waitFor('Container detail ID', () => c.evaluate(`!!document.querySelector('.container-dialog .detail-meta')`));
    assert.ok(await c.evaluate(`document.querySelector('.container-dialog .detail-meta').innerText.includes(${JSON.stringify(original[0].id)})`));
    await c.evaluate(`document.querySelector('.container-dialog header .icon-button').click()`);
    check('Container detail retains its ID');
  }
  for (const size of [{width:1668,height:900}, {width:1000,height:640}]) {
    await c.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
    await c.nav('Images'); await fit('Images ' + size.width);
    const images = await c.invoke('images_list');
    const imageText = await c.evaluate(`document.querySelector('[data-page="Images"] tbody').innerText`);
    assert.ok(images.every(image=>imageText.includes(image.id)));
    if(size.width===1668) {
      await c.evaluate(`document.querySelector('[data-page="Images"] .table-filter').focus()`);
      await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',modifiers:1,windowsVirtualKeyCode:40});
      await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',modifiers:1,windowsVirtualKeyCode:40});
      await waitFor('Styled select popup',()=>c.evaluate(`document.querySelector('[data-page="Images"] .table-filter').matches(':open')`),5000);
      const popup=await c.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-page="Images"] .table-filter'),'::picker(select)');return {appearance:s.appearance,background:s.backgroundColor,radius:s.borderRadius}})()`);
      assert.equal(popup.appearance,'base-select'); assert.equal(popup.radius,'6px');
      await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      check('Native select popup uses the shared theme',popup);
    }
    await c.nav('Resources');
    await click('[data-page="Resources"] .page-tabs button', 'Volume'); await fit('Volumes ' + size.width);
    await click('[data-page="Resources"] .page-tabs button', 'Network'); await fit('Networks ' + size.width);
    await c.nav('Builds');
    await click('[data-page="Builds"] .page-tabs button', 'Build history'); const history=await fit('Build history ' + size.width);
    if(size.width===1000) assert.ok(history.scrollHeight > history.height);
    await click('[data-page="Builds"] .page-tabs button', 'Builders'); await fit('Builders ' + size.width);
    assert.ok(await c.evaluate(`(()=>{const row=document.querySelector('.builder-name'),button=row.querySelector('button').getBoundingClientRect(),badge=row.querySelector('.status-badge').getBoundingClientRect();return Math.abs(button.y+button.height/2-badge.y-badge.height/2)<2})()`));
    await c.nav('Disk Manager'); const cleanup=await fit('Cleanup ' + size.width);
    assert.ok(cleanup.scrollHeight > cleanup.height);
    const sticky=await c.evaluate(`(()=>{const t=document.querySelector('[data-page="Disk Manager"] table'),wrap=t.parentElement;wrap.scrollTop=150;return new Promise(resolve=>requestAnimationFrame(()=>resolve({top:t.tHead.getBoundingClientRect().top,cell:t.tHead.rows[0].cells[0].getBoundingClientRect().top,wrap:wrap.getBoundingClientRect().top})))})()`);
    assert.ok(Math.abs(sticky.cell-sticky.wrap-1)<2, JSON.stringify(sticky));
    check('Cleanup header stays visible when rows scroll ' + size.width, sticky);
  }
  await c.nav('Builds'); await click('[data-page="Builds"] .page-tabs button', 'In progress');
  const activeText=await c.evaluate(`document.querySelector('[data-page="Builds"]').innerText`);
  assert.ok(!activeText.includes('No app builds in progress'));
  assert.ok(!activeText.includes('BuildKit in progress')); check('Active-build empty state has no duplicate summaries');
  const after = await c.invoke('containers_list');
  assert.deepEqual(after.map(row=>[row.id,row.state]),original.map(row=>[row.id,row.state]));
  assert.equal(c.exceptions.length,0,JSON.stringify(c.exceptions));
  check('No container changes or renderer exceptions');
  report.passed=true;
} finally {
  await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  fs.writeFileSync('docs/results/table-layout.json',JSON.stringify(report,null,2)+'\n');
  await c.close();
}
