import fs from 'node:fs';
import { connectNative, waitFor, pause } from './native-verification.mjs';
const s=JSON.parse(fs.readFileSync('.analysis/workflow-native-session.json','utf8').replace(/^\uFEFF/,''));
if(!s.explicitRiskApproval||!s.isolatedProfile)throw Error('Approved native session required');
const c=await connectNative(s.portFile), ev=c.evaluate;
const report={observedAt:new Date().toISOString(),artifactSha256:s.sha256,native:true,readOnly:true,completed:false,checks:[],failure:null};
const check=(name,evidence)=>{report.checks.push({name,passed:true,evidence});console.log(JSON.stringify({name,passed:true}));};
const assert=(value,message)=>{if(!value)throw Error(message);};
const tab=async label=>{await ev(`(()=>{const b=[...document.querySelectorAll('.detail-tabs button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing tab');b.click()})()`);await pause(150);};
try{
 await ev(`(()=>{const b=[...document.querySelectorAll('nav button')].find(b=>b.textContent==='컨테이너');b.click()})()`);
 await waitFor('containers visible',()=>ev(`document.querySelector('[data-page="Containers"]')?.hidden===false`));
 await ev(`(()=>{const b=[...document.querySelectorAll('.container-table .name-button')].find(b=>b.textContent==='trusting_feistel');if(!b)throw Error('Existing Mongo container missing');b.click()})()`);
 await waitFor('real details popup',()=>ev(`!!document.querySelector('.container-dialog')`));
 const initial=await ev(`(()=>{const r=document.querySelector('.container-dialog').getBoundingClientRect();return{width:r.width,height:r.height}})()`);
 const names=await ev(`[...document.querySelectorAll('.detail-tabs button')].map(e=>e.textContent.trim())`);
 assert(names.length===6&&names[0]==='상세'&&!names.includes('통계'),'Stats not merged into localized Details');
 await waitFor('details statistics',()=>ev(`!!document.querySelector('.container-stats')||document.querySelector('.detail-content')?.textContent.includes('리소스 사용량')`));
 check('Native Details includes statistics with six localized detail tabs',names);
 await tab('로그');
 await waitFor('actual log text received',()=>ev(`document.querySelector('.log-pane .logs')?.textContent.includes('"msg"')&&document.querySelector('.log-status')?.textContent.includes('새 로그 감지 중')`),30000);
 const afterInitial=c.calls.filter(call=>call.command==='container_logs').length;
 await pause(3300);
 assert(c.calls.filter(call=>call.command==='container_logs').length===afterInitial,'Old full log polling still occurs');
 assert(await ev(`!document.querySelector('.log-status').textContent.includes('2초')&&!document.querySelector('.log-status').textContent.includes('갱신 중')`),'Polling status still shown');
 check('Native log tab receives real stream data with no 2-second full log requests',{idleMs:3300,fullLogRequests:afterInitial,status:await ev(`document.querySelector('.log-status span').textContent`)});
 const sizes=[];
 for(const name of names){
  await tab(name);
  const size=await ev(`(()=>{const r=document.querySelector('.container-dialog').getBoundingClientRect();return{width:r.width,height:r.height}})()`);
  assert(Math.abs(size.width-initial.width)<1&&Math.abs(size.height-initial.height)<1,'Detail popup changed size at '+name);sizes.push({tab:name,...size});
 }
 check('Actual detail popup retains size across all six tabs',sizes);
 await tab('로그');
 await waitFor('log stream reconnected',()=>ev(`document.querySelector('.log-status')?.textContent.includes('새 로그 감지 중')`));
 const padding=await ev(`(()=>{const e=document.querySelector('.log-pane .logs');const s=getComputedStyle(e);return{left:s.paddingLeft,right:s.paddingRight,top:s.paddingTop}})()`);
 assert(parseFloat(padding.left)>=12&&parseFloat(padding.right)>=12,'Log text lacks inner padding');
 check('Actual logs have consistent inner padding',padding);
 await ev(`document.querySelector('.container-dialog .detail-heading button').click()`);
 await waitFor('detail closed',()=>ev(`!document.querySelector('.container-dialog')`));
 await pause(500);
 assert(c.calls.some(call=>call.command==='container_logs_stop'),'Closing/hiding log tab did not stop its stream');
 check('Hiding and closing native log tab sends stream stop');
 assert(c.exceptions.length===0,'Native JS errors: '+c.exceptions.join(';'));
 report.completed=true;
}catch(error){report.failure=String(error.stack??error);throw error;}
finally{fs.writeFileSync('docs/results/log-ui-native-e2e.json',JSON.stringify(report,null,2)+'\n');c.close();}
