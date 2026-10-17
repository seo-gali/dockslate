import fs from 'node:fs';
import { connectNative } from './native-verification.mjs';

const [portFile]=process.argv.slice(2);
const native=await connectNative(portFile),{evaluate,nav,pause,waitFor,calls}=native;
const report={observedAt:new Date().toISOString(),mockData:false,completed:false,timings:[],checks:[]};
try{
  await waitFor('initial snapshot and background reads settled',()=>evaluate(`![...document.querySelectorAll('.header-actions button')].some(b=>b.textContent.includes('조회 중'))`));
  await pause(4000);
  const start=calls.length;
  for(const name of ['Overview','Containers','Images','Volumes','Builds','Disk Manager','Settings','Builds','Volumes','Containers']){
    const timing=await evaluate(`new Promise(resolve=>{const b=[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${JSON.stringify(name)});const start=performance.now();b.click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})`);
    if(!await evaluate(`document.querySelector('main [data-page]:not([hidden])')?.getAttribute('data-page')===${JSON.stringify(name)}`)) throw Error('Navigation failed');
    report.timings.push({menu:name,clickToTwoFramesMs:timing});
  }
  await pause(1000);
  const dataCalls=calls.slice(start).filter(c=>!c.command.startsWith('plugin:event|'));
  report.navigationCalls=dataCalls;
  if(dataCalls.length)throw Error(`Unexpected navigation calls: ${dataCalls.map(c=>c.command).join(',')}`);
  report.checks.push({name:'Seven-menu navigation uses cached data',passed:true});
  const before=calls.length;
  await evaluate(`(()=>{const b=[...document.querySelectorAll('main [data-page]:not([hidden]) .page-header button')].find(b=>b.textContent.includes('전체 새로고침'));if(!b||b.disabled)throw Error('Refresh unavailable');b.click()})()`);
  await waitFor('global snapshot complete',()=>calls.slice(before).some(c=>c.command==='dashboard_snapshot'&&c.durationMs!=null));
  await waitFor('background reads complete',()=>calls.slice(before).filter(c=>['builds_snapshot','containers_metrics'].includes(c.command)).every(c=>c.durationMs!=null));
  const snapshots=calls.slice(before).filter(c=>c.command==='dashboard_snapshot');if(snapshots.length!==1)throw Error('Duplicate global snapshot');
  report.refreshCalls=calls.slice(before).map(({command,durationMs})=>({command,durationMs}));
  report.checks.push({name:'One global refresh updates all menus',passed:true});
  await nav('Builds');
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-page="Builds"] [role="tab"]')].find(b=>b.textContent==='진행 중');if(!b)throw Error('Active tab unavailable');b.click()})()`);
  if(!await evaluate(`!!document.querySelector('section[aria-label="앱에서 진행 중인 빌드"]')`))throw Error('Active build view unavailable');
  report.checks.push({name:'Active builds tab displays actual cached state',passed:true});
  if(native.exceptions.length)throw Error('Renderer exception');
  report.completed=true;console.log(JSON.stringify({completed:true,checks:report.checks.length}));
}catch(e){report.failure=String(e.stack??e);console.error(report.failure);process.exitCode=1}
finally{fs.writeFileSync('docs/results/navigation-e2e.json',JSON.stringify(report,null,2));native.close()}
