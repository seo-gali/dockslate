import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connectNative, waitFor, pause } from './native-verification.mjs';
const session=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
if(!session.isolatedProfile)throw Error('An isolated native session is required.');
const c=await connectNative(session.portFile);
const report={observedAt:new Date().toISOString(),artifactSha256:session.sha256,native:true,backendInjected:false,checks:[],completed:false};
const check=(name,evidence)=>{report.checks.push({name,passed:true,evidence});console.log(JSON.stringify({name,passed:true}));};
const click=async(selector,text)=>{await waitFor(text,()=>c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(b=>b.getClientRects().length&&!b.disabled&&b.textContent.trim()===${JSON.stringify(text)})`));await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)}).click()`);};
const assertBounds=async(selector)=>{
  const result=await c.evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(selector)});return{columns:t.tHead.rows[0].cells.length,handles:t.querySelectorAll('[role="separator"]').length,overflow:[...t.querySelectorAll('td .status-badge,td .button,td .icon-button')].filter(e=>{const cell=e.closest('td');if(cell.colSpan!==1)return false;const a=e.getBoundingClientRect(),b=cell.getBoundingClientRect();return a.left<b.left-1||a.right>b.right+1;}).map(e=>e.textContent),resizeTooltips:t.querySelectorAll('.column-resize-handle[data-tooltip],.column-resize-handle[title]').length}})()`);
  assert.ok(result.handles>=result.columns-1);assert.deepEqual(result.overflow,[]);assert.equal(result.resizeTooltips,0);return result;
};
try{
  const baseline=(await c.invoke('containers_list')).map(value=>[value.id,value.name,value.state]);
  await c.nav('Images');await click('[data-page="Images"] .page-tabs button','Docker Hub');
  await waitFor('Hub field',()=>c.evaluate(`!!document.querySelector('#registry-search')`));
  await c.setInput('#registry-search','busybox');await c.evaluate(`document.querySelector('.registry-search-panel form button[type="submit"]').click()`);
  await waitFor('actual Hub results',()=>c.evaluate(`!!document.querySelector('.registry-search-panel table')`),90000);
  check('Actual Docker Hub result table uses the shared column controls',await assertBounds('.registry-search-panel table'));
  await c.nav('Builds');await click('[data-page="Builds"] .page-tabs button','Build from file');
  const fixture=path.resolve('.analysis/file-import-fixture-ui011');fs.mkdirSync(fixture,{recursive:true});
  const file=path.join(fixture,'compose.yaml');fs.writeFileSync(file,'name: dockslate-ui011-preview\nservices:\n  sample:\n    image: busybox:1.37.0\n    command: ["true"]\n    volumes: ["fixture:/data:ro"]\nvolumes:\n  fixture: {}\n');
  const picker=spawn('powershell.exe',['-NoProfile','-File','scripts/select-native-import-file.ps1','-TargetProcessId',String(session.pid),'-Path',file],{windowsHide:true});
  let pickerOutput='';picker.stdout.on('data',bytes=>pickerOutput+=bytes);picker.stderr.on('data',bytes=>pickerOutput+=bytes);
  const selected=new Promise((resolve,reject)=>picker.on('exit',code=>code===0?resolve():reject(Error(pickerOutput))));
  await click('.image-build-panel button','Choose Compose file');await selected;
  await waitFor('Compose summary table',()=>c.evaluate(`!!document.querySelector('[data-page="Builds"] .image-build-panel table')`));
  check('Actual native Compose file selection renders its resizable summary without creating services',await assertBounds('[data-page="Builds"] .image-build-panel table'));
  const summary=await c.evaluate(`document.querySelector('[data-page="Builds"] .image-build-panel table').innerText`);
  assert.ok(summary.includes('Read-only')||summary.includes('Read only')||summary.includes('read-only'));
  await click('.image-build-panel button','Close file selection');
  check('Compose summary labels follow the selected English language');
  for(const [language,fontSize,width]of[['en',12,1000],['ko',12,1000],['en',16,1200],['ko',16,1200]]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    await c.evaluate(`localStorage.setItem('dockslate.language',${JSON.stringify(language)});localStorage.setItem('dockslate.appearance',JSON.stringify({theme:'dark',fontSize:${fontSize}}));for(const key of Object.keys(localStorage))if(key.includes('.columns.'))localStorage.removeItem(key);location.reload()`);
    await waitFor('reload language',()=>c.evaluate(`document.documentElement.lang===${JSON.stringify(language)}&&!!document.querySelector('nav')`));
    await click('nav button',language==='ko'?'이미지':'Images');
    await waitFor('local images',()=>c.evaluate(`!!document.querySelector('[data-page="Images"] table')`));
    await c.evaluate(`for(const h of document.querySelectorAll('[data-page="Images"] table [role="separator"]'))h.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);await pause(100);
    const result=await assertBounds('[data-page="Images"] table');
    const dates=await c.evaluate(`Array.from(document.querySelectorAll('[data-page="Images"] td.date-cell')).map(td=>({width:td.getBoundingClientRect().width,break:getComputedStyle(td).overflowWrap,text:td.innerText}))`);
    assert.ok(dates.length);for(const date of dates){assert.ok(date.width>=189);assert.equal(date.break,'normal');assert.match(date.text,/\d+:\d+:\d+/);}
    check(`Image column minimums and full timestamps fit at ${language}/${fontSize}px/${width}px`,{...result,dates});
  }
  assert.deepEqual((await c.invoke('containers_list')).map(value=>[value.id,value.name,value.state]),baseline);
  report.serviceCreationExecuted=false;report.imageBuildExecuted=false;report.completed=true;
}catch(error){report.failure=String(error.stack??error);console.error(error.stack);process.exitCode=1;}
finally{fs.writeFileSync('docs/results/ui-extra-0.1.1.json',JSON.stringify(report,null,2)+'\n');c.close();}
