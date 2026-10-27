import fs from 'node:fs';
import {connectNative, waitFor, pause} from './native-verification.mjs';

const [sessionPath, fixturePath, output] = process.argv.slice(2);
if (!sessionPath || !fixturePath || !output) throw Error('Usage: node scripts/verify-inspect-lifecycle.mjs SESSION_JSON FIXTURE_JSON OUTPUT_JSON');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const session = read(sessionPath), fixture = read(fixturePath);
if (!session.isolatedProfile || !fixture.prepared || !/^dockslate-e2e-inspect-\d+$/.test(fixture.name) || !/^[a-f0-9]{64}$/.test(fixture.id) || fixture.baseline.containers.some(item => item.id === fixture.id)) throw Error('Isolated session and separate fixture required');
const c = await connectNative(session.portFile);
const report = {observedAt:new Date().toISOString(), artifactSha256:session.sha256, fixtureId:fixture.id, realNativeBackend:true, syntheticResponseData:false, injection:'Delay delivery of real Inspect results; one invalid-ID request to the real Rust backend per failure scenario', checks:[], completed:false};
const check = (name, passed) => { report.checks.push({name, passed:!!passed}); console.log(JSON.stringify({name, passed:!!passed})); };
const click = (selector, label) => c.evaluate(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Button unavailable');button.click();})()`);
const nav = async (page, label) => { await click('nav button', label); await waitFor(page, () => c.evaluate(`!!document.querySelector('[data-page="${page}"]:not([hidden])')`)); };
const tab = label => click('.container-dialog .detail-tabs button', label);
const visibleInspect = () => c.evaluate(`!!document.querySelector('.container-inspect .inspect-json')?.textContent.includes(${JSON.stringify(fixture.id.slice(0,12))}) && !document.querySelector('.container-inspect .notice.error') && !document.querySelector('.container-inspect [role="status"]')`);
const ready = async mode => {
  await c.send('Page.reload');
  await waitFor('app connected', () => c.evaluate(`!!document.querySelector('nav') && !document.querySelector('.page-header .header-actions button')?.disabled`));
  await nav('Containers', '컨테이너');
  await waitFor('fixture row', () => c.evaluate(`!!document.querySelector('[data-container-id="${fixture.id}"] .name-button')`));
  await c.evaluate(`document.querySelector('[data-container-id="${fixture.id}"] .name-button').click()`);
  await waitFor('container dialog', () => c.evaluate(`!!document.querySelector('.container-dialog')`));
  await c.evaluate(`(()=>{
    const original=window.fetch;
    const probe=window.__inspectLifecycle={original,mode:${JSON.stringify(mode)},requests:0,received:0,delivered:0,release:null};
    window.fetch=async (input,options)=>{
      if(!String(input instanceof Request?input.url:input).includes('ipc.localhost/container_inspect'))return original(input,options);
      const payload=JSON.parse(options.body);
      if(payload.id!==${JSON.stringify(fixture.id)})return original(input,options);
      probe.requests++;
      if(probe.mode==='reject'){probe.mode='pass';return original(input,{...options,body:JSON.stringify({...payload,id:'invalid-inspect-lifecycle-id'})});}
      const value=await original(input,options);
      if(probe.mode==='hold'){probe.received++;await new Promise(resolve=>{probe.release=resolve;});probe.delivered++;}
      return value;
    };
  })()`);
  await tab('상세 JSON');
};

try {
  const inspected = await c.invoke('container_inspect', {id:fixture.id});
  if (inspected.Name !== '/'+fixture.name || inspected.Image !== fixture.imageId || inspected.State.Running || inspected.Mounts.length || inspected.HostConfig.NetworkMode !== 'none') throw Error('Expected stopped fixture without volumes, ports or external network');
  for (const navigation of ['tab', 'menu']) {
    await ready('hold');
    await waitFor('real Inspect response held', () => c.evaluate(`window.__inspectLifecycle.received===1`));
    if (navigation === 'tab') await tab('상세'); else await nav('Overview', '개요');
    await pause(100);
    const before = await c.evaluate(`document.querySelector('.container-inspect').innerText`);
    await c.evaluate(`window.__inspectLifecycle.release()`);
    await waitFor('response delivered', () => c.evaluate(`window.__inspectLifecycle.delivered===1`));
    await pause(150);
    check(`${navigation}: late response leaves hidden Inspect unchanged`, before === await c.evaluate(`document.querySelector('.container-inspect').innerText`));
    if (navigation === 'tab') await tab('상세 JSON'); else await nav('Containers', '컨테이너');
    await waitFor('cached Inspect on return', visibleInspect);
    check(`${navigation}: return reuses real cached Inspect without another IPC`, await c.evaluate(`window.__inspectLifecycle.requests===1`));
  }
  await ready('reject');
  await waitFor('real invalid-ID rejection', () => c.evaluate(`!!document.querySelector('.container-inspect .notice.error')`));
  await tab('상세'); await pause(100); await tab('상세 JSON');
  let retried = true;
  try { await waitFor('failed revision retries on return', visibleInspect, 3000); } catch { retried = false; }
  check('failed Inspect retries when the tab is reopened', retried && await c.evaluate(`window.__inspectLifecycle.requests===2`));
  await ready('reject');
  await waitFor('real error before manual retry', () => c.evaluate(`!!document.querySelector('.container-inspect .notice.error')`));
  await click('.container-inspect .notice.error button', '다시 시도');
  await waitFor('manual retry succeeds', visibleInspect);
  check('manual retry still returns real fixture data', await c.evaluate(`window.__inspectLifecycle.requests===2`));
  check('no renderer exception', c.exceptions.length === 0);
  report.completed = report.checks.every(item => item.passed);
  if (!report.completed) process.exitCode = 1;
} catch (failure) {
  report.failure = String(failure.stack ?? failure); console.error(report.failure); process.exitCode = 1;
} finally {
  try { await c.evaluate(`if(window.__inspectLifecycle){window.__inspectLifecycle.release?.();window.fetch=window.__inspectLifecycle.original;delete window.__inspectLifecycle;}`); } catch {}
  fs.writeFileSync(output, JSON.stringify(report, null, 2)+'\n'); c.close();
}
