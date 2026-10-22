import fs from 'node:fs';
import {connectNative, waitFor} from './native-verification.mjs';

const session = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
if (!session.isolatedProfile || !session.readOnlyVerification) throw Error('Owned isolated native session required');
const c = await connectNative(session.portFile);
const report = {observedAt:new Date().toISOString(), native:true, backendInjected:false, artifactSha256:session.sha256, completed:false, checks:[], failure:null};
const assert = (condition, message) => {if (!condition) throw Error(message);};
const check = (name, evidence) => {report.checks.push({name,passed:true,evidence});console.log(JSON.stringify({name,passed:true}));};
const nav = async (page, label, selector) => {
  await c.evaluate(`(()=>{const button=[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Navigation missing');button.click()})()`);
  await waitFor(page,()=>c.evaluate(`!!document.querySelector('[data-page="${page}"]:not([hidden]) ${selector}')`),30000);
};
const fit = selector => c.evaluate(`(()=>{const table=document.querySelector(${JSON.stringify(selector)}),wrap=table.closest('.table-wrap');return{available:wrap.clientWidth,scrollWidth:wrap.scrollWidth,tableWidth:table.getBoundingClientRect().width,columns:table.querySelectorAll('col').length,handles:table.querySelectorAll('[role="separator"]').length}})()`);
const reload = async () => {
  await c.send('Page.reload');
  await waitFor('connected app',()=>c.evaluate(`!!document.querySelector('nav button')&&!document.querySelector('.page-header .refresh-button[disabled]')`),30000);
};
const resize = async (selector, distance) => {
  const before=await c.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`);
  const point=await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+distance,y:point.y,button:'left',buttons:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+distance,y:point.y,button:'left',buttons:0,clickCount:1});
  await waitFor('column resized',()=>c.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))>${before}`),5000);
  return {before,after:await c.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`)};
};
try {
  if (await c.evaluate(`document.documentElement.lang==='en'`)) {
    await nav('Settings','Settings','.appearance-panel select');
    await c.setSelect('[data-page="Settings"] .appearance-panel select','ko');
    await waitFor('Korean test baseline',()=>c.evaluate(`document.documentElement.lang==='ko'`),15000);
  }
  const [containers,images,usage]=await Promise.all([c.invoke('containers_list'),c.invoke('images_list'),c.invoke('disk_usage')]);
  const named=containers.map(container=>({container,image:images.find(image=>image.id===container.image&&image.tags.length)})).find(row=>row.image);
  assert(named,'A real container created from an image ID and a tagged local image are required');
  for (const width of [1000,1200,1480]) {
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});
    await c.evaluate(`localStorage.removeItem('dockslate.containers.columns.v1');localStorage.removeItem('dockslate.cleanup.columns.v1')`);
    await reload();
    await nav('Containers','컨테이너','.container-table');
    const containerFit=await fit('.container-table');
    assert(containerFit.scrollWidth<=containerFit.available+1,`Containers overflow at ${width}px`);
    await nav('Disk Manager','디스크 관리','.candidate-table');
    const cleanupFit=await fit('.candidate-table');
    assert(cleanupFit.scrollWidth<=cleanupFit.available+1,`Cleanup overflows at ${width}px`);
    assert(cleanupFit.columns===6&&cleanupFit.handles===5,'Cleanup columns or resize handles missing');
    check(`Both tables fit their initial viewport at ${width}px`,{containerFit,cleanupFit});
  }
  await nav('Containers','컨테이너','.container-table');
  const rowSelector=`.container-table tr[data-container-id="${named.container.id}"]`;
  const imageCell=await c.evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.cells[2].innerText`);
  assert(imageCell?.includes(named.image.tags[0])&&imageCell.includes(named.container.image.replace(/^sha256:/,'').slice(0,12)),'Repository/tag and short image ID missing');
  await c.setInput('[data-page="Containers"] .toolbar input',named.image.tags[0]);
  await waitFor('tag search',()=>c.evaluate(`document.querySelectorAll('.container-table tr[data-container-id]').length>0`),5000);
  assert(await c.evaluate(`!!document.querySelector(${JSON.stringify(rowSelector)})`),'Image-name search lost the matching container');
  assert(!c.calls.some(call=>call.command==='image_details'),'Image names caused individual image requests');
  check('Real repository/tag, short ID and local tag search without per-image requests',{imageCell});
  await c.setInput('[data-page="Containers"] .toolbar input','');
  const containerResize=await resize('.container-table th:first-child [role="separator"]',60);
  const saved=await c.evaluate(`JSON.parse(localStorage.getItem('dockslate.containers.columns.v1')).widths.name`);
  assert(saved===containerResize.after,'Container resize was not persisted');
  check('Container pointer resize remains available and saves its width',containerResize);
  await c.evaluate(`localStorage.setItem('dockslate.containers.columns.v1',JSON.stringify({version:1,widths:{name:720,status:300,image:900,ports:800,cpu:250,memory:350,actions:84}}))`);
  await c.send('Emulation.setDeviceMetricsOverride',{width:1000,height:780,deviceScaleFactor:1,mobile:false});
  await reload();await nav('Containers','컨테이너','.container-table');
  const restored=await fit('.container-table');
  assert(restored.scrollWidth<=restored.available+1,'Oversized saved widths caused initial overflow');
  check('Previously saved wide columns fit a smaller window on first display',restored);
  await nav('Disk Manager','디스크 관리','.candidate-table');
  const candidates=[...usage.images,...usage.buildCache];
  const rows=await c.evaluate(`[...document.querySelectorAll('.candidate-table tbody tr')].map(row=>({identity:row.cells[2].title,date:row.cells[3].innerText}))`);
  let datesChecked=0;
  for(const row of rows){
    const item=candidates.find(candidate=>row.identity.includes(candidate.id));
    assert(item,'Displayed cleanup item missing from the actual engine snapshot');
    const milliseconds=typeof item.createdAt==='number'?item.createdAt*1000:Date.parse(item.createdAt??'');
    if(Number.isFinite(milliseconds)&&milliseconds>0){assert(row.date!=='미확인'&&row.date.includes(String(new Date(milliseconds).getFullYear())),'Engine creation date was not displayed');datesChecked++;}
    else assert(row.date==='미확인','Unknown creation date was fabricated');
  }
  assert(datesChecked>0,'No real engine dates were checked');
  check('Cleanup creation dates match actual engine timestamps',{datesChecked,rows:rows.length});
  const cleanupResize=await resize('.candidate-table th:nth-child(3) [role="separator"]',50);
  assert(await c.evaluate(`JSON.parse(localStorage.getItem('dockslate.cleanup.columns.v1')).widths.target`)===cleanupResize.after,'Cleanup resize was not persisted');
  check('Cleanup pointer resize saves its independent column preference',cleanupResize);
  await nav('Settings','설정','.appearance-panel select');
  await c.setSelect('[data-page="Settings"] .appearance-panel select','en');
  await waitFor('English labels',()=>c.evaluate(`document.documentElement.lang==='en'`),15000);
  await c.evaluate(`localStorage.removeItem('dockslate.cleanup.columns.v1')`);
  await reload();
  await waitFor('English after reload',()=>c.evaluate(`document.documentElement.lang==='en'`),15000);
  await nav('Disk Manager','Disk Manager','.candidate-table');
  const englishFit=await fit('.candidate-table');
  assert(englishFit.scrollWidth<=englishFit.available+1,'English cleanup headings overflow at the minimum window size');
  check('English cleanup table fits the minimum window size',englishFit);
  assert(!c.calls.some(call=>/^(container_action|destructive_execute|image_pull|image_build_start|runtime_install|runtime_start|runtime_stop|volume_delete|network_delete|compose_up)$/.test(call.command)),'A mutating command was called');
  assert(c.exceptions.length===0,'Native UI exceptions: '+c.exceptions.join('; '));
  check('No destructive commands or JavaScript exceptions',{commands:[...new Set(c.calls.map(call=>call.command))]});
  const screenshot=await c.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('.analysis/cleanup-table-layout.png',Buffer.from(screenshot.data,'base64'));
  report.completed=true;
} catch(error){report.failure=String(error.stack??error);process.exitCode=1;console.error(error.stack);}
finally{fs.writeFileSync('docs/results/table-layout-e2e.json',JSON.stringify(report,null,2)+'\n');c.close();}
