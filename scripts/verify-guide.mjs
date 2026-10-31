import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitFor } from './native-verification.mjs';

const root = path.resolve('.');
const session = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/guide-browser-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.frontendOnly || session.nativeBackendInjected !== false || !path.resolve(session.profile).startsWith(root + path.sep + '.analysis' + path.sep + 'guide-browser-')) throw Error('Isolated guide browser required');
const port = await waitFor('Guide browser debugging port', () => {
  try { return Number(fs.readFileSync(session.portFile, 'utf8').split('\n')[0]); }
  catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error; }
}, 10000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid browser port');
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = pages.find(p => p.type === 'page' && (p.url === 'about:blank' || p.url === 'http://127.0.0.1:1420/' || p.url.startsWith(pathToFileURL(root + path.sep).href)));
if (!target || new URL(target.webSocketDebuggerUrl).hostname !== '127.0.0.1') throw Error('Local guide page required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
let seq = 0;
const pending = new Map(), errors = [], downloads = [];
socket.addEventListener('message', event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Browser.downloadWillBegin') downloads.push(m.params);
  const request = pending.get(m.id);
  if (request) { clearTimeout(request.timer); pending.delete(m.id); m.error ? request.reject(Error(m.error.message)) : request.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
  pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
});
const evaluate = async expression => { const r = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true}); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const assert = (value, description) => { if (!value) throw Error(description); };
const report = {observedAt:new Date().toISOString(), target:'Actual file:// pages in isolated signed Chrome; no native backend, no engine calls', completed:false, checks:[], failure:null};
const check = (name, evidence) => { report.checks.push({name, passed:true, evidence}); console.log(JSON.stringify({name, passed:true})); };
const open = async relative => {
  const url = pathToFileURL(path.join(root, relative)).href;
  await send('Page.navigate', {url});
  await waitFor(relative, () => evaluate(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`), 15000);
};
try {
  await send('Runtime.enable'); await send('Page.enable');
  for (const guide of ['guide.html', 'dist/guide.html']) {
    await open(guide);
    const state = await evaluate(`({steps:document.querySelectorAll('#quickstart li').length,details:document.querySelectorAll('details').length,open:document.querySelectorAll('details[open]').length,buttons:document.querySelectorAll('button,#site-download,[data-artifact]').length,external:document.querySelectorAll('script[src],link[rel="stylesheet"]').length})`);
    assert(state.steps===3 && state.details===4 && state.open===0 && state.buttons===0 && state.external===0, 'Guide still contains controls or lacks standalone usage: '+guide);
    check(guide+' opens as a compact standalone usage page without download/print/export controls', state);
  }
  await open('index.html');
  assert(await evaluate(`document.querySelectorAll('[data-download]').length===2&&!document.querySelector('.file-start')&&!!document.getElementById('features')`), 'Root index is still an application fallback');
  await evaluate(`document.querySelector('.footer a[href="./guide.html"]').click()`);
  await waitFor('Root website opens usage directly',()=>evaluate(`!!document.querySelector('#quickstart')&&!document.querySelector('#site-download')`),10000);
  check('Root index is the complete website and opens usage without a download redirect');
  const application=fs.readFileSync('src/index.html','utf8');
  const built=fs.readFileSync('dist/index.html','utf8');
  assert(application.includes('id="root"')&&application.includes('src="./main.tsx"')&&built.includes('src="./assets/')&&!built.includes('data-download='),'Desktop application bootstrap was mixed with website markup');
  check('Desktop React entry remains separate in src/index.html and dist/index.html');
  await evaluate(`document.querySelector('details summary').focus()`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});
  assert(await evaluate(`document.querySelector('details').open&&document.querySelector('details').innerText.includes('docker ps')`),'Keyboard help expansion failed');
  await evaluate(`document.querySelector('details summary').click()`);
  assert(await evaluate(`!document.querySelector('details').open`),'Help did not collapse');
  check('Usage help opens and closes with keyboard and mouse');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Guide overflows mobile viewport');
  check('Usage page fits a 390px viewport');
  for (const [name,width,height] of [['desktop',1280,960],['mobile',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(root,'.analysis',`guide-${name}.png`),Buffer.from(screenshot.data,'base64'));
  }
  assert(errors.length===0,'Guide JavaScript exceptions: '+errors.join('; '));
  check('No JavaScript exceptions in website or standalone usage pages');
  report.completed=true;
} catch(error) { report.failure=String(error.stack??error); throw error; }
finally {
  fs.writeFileSync('docs/results/guide-delivery-e2e.json',JSON.stringify(report,null,2)+'\n');
  for(const request of pending.values())clearTimeout(request.timer);
  socket.close();
}
