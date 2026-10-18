import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { waitFor } from './native-verification.mjs';

const root = path.resolve('.');
const session = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/guide-browser-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.frontendOnly || session.nativeBackendInjected !== false || !path.resolve(session.profile).startsWith(root + path.sep + '.analysis' + path.sep + 'guide-browser-')) throw Error('Isolated guide browser required');
const port = Number(fs.readFileSync(session.portFile, 'utf8').split('\n')[0]);
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
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const downloadDir = path.join(root, '.analysis', 'guide-download-test-' + randomUUID());
fs.mkdirSync(downloadDir, {recursive:true});
try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Browser.setDownloadBehavior', {behavior:'allow', downloadPath:downloadDir, eventsEnabled:true});
  for (const entry of ['index.html', 'dist/index.html']) {
    await open(entry);
    const state = await evaluate(`({text:document.querySelector('.file-start')?.innerText,guide:document.querySelector('.file-start a')?.href,root:!!document.querySelector('#root')})`);
    assert(state.text?.includes('Windows 앱') && fs.existsSync(fileURLToPath(state.guide)), entry + ' missing real guide link');
    await evaluate(`document.querySelector('.file-start a').click()`);
    await waitFor('guide link navigation', () => evaluate(`!!document.querySelector('#save-guide')`), 10000);
    check(entry + ' shows launch guidance and opens local HTML guide', state);
  }
  for (const guide of ['guide.html', 'dist/guide.html']) {
    await open(guide);
    const artifacts = await evaluate(`[...document.querySelectorAll('[data-artifact]:not([hidden])')].map(a=>({name:a.dataset.artifact,url:a.href}))`);
    assert(artifacts.length >= 2 && artifacts.every(a => fs.existsSync(fileURLToPath(a.url))), 'Download link target missing in ' + guide);
    assert(await evaluate(`document.querySelectorAll('main section').length===8&&document.querySelectorAll('#status tbody tr').length>=24`), 'Guide sections or request audit missing');
    check(guide + ' has real EXE/ZIP links and complete guide sections', artifacts);
  }
  await open('guide.html');
  await evaluate(`document.querySelector('[data-artifact="DockSlate.exe"]').click()`);
  await waitFor('EXE download', () => fs.existsSync(path.join(downloadDir, 'DockSlate.exe')) && hash(path.join(downloadDir, 'DockSlate.exe')) === hash(path.join(root, 'downloads', 'DockSlate.exe')), 15000);
  check('EXE download button saves the exact packaged executable without running it', {sha256:hash(path.join(downloadDir, 'DockSlate.exe'))});
  const zipName = 'DockSlate-0.1.0-windows-x64.zip';
  await evaluate(`document.querySelector('[data-artifact="${zipName}"]').click()`);
  await waitFor('ZIP download', () => fs.existsSync(path.join(downloadDir, zipName)) && hash(path.join(downloadDir, zipName)) === hash(path.join(root, 'downloads', zipName)), 15000);
  check('ZIP download button saves the exact local review package', {sha256:hash(path.join(downloadDir, zipName))});
  await evaluate(`document.querySelector('#save-guide').click()`);
  const saved = path.join(downloadDir, 'DockSlate-사용안내.html');
  await waitFor('standalone HTML download', () => fs.existsSync(saved), 10000);
  const html = fs.readFileSync(saved, 'utf8');
  assert(html.startsWith('<!doctype html>') && !html.includes('class="actions download-actions"'), 'Shared guide still depends on artifact folder');
  await open(path.relative(root, saved));
  assert(await evaluate(`!!document.querySelector('#save-guide')&&document.querySelector('#download-note').textContent.includes('공유용')`), 'Downloaded guide does not open standalone');
  await evaluate(`document.querySelector('#save-guide').click()`);
  check('Guide HTML download opens independently and remains downloadable', {bytes:fs.statSync(saved).size, externalScriptOrStyles:await evaluate(`document.querySelectorAll('script[src],link[rel="stylesheet"]').length`)});
  const extractedGuide = '.analysis/portable-extract/DockSlate-0.1.0-windows-x64/guide.html';
  if (fs.existsSync(extractedGuide)) {
    await open(extractedGuide);
    const links = await evaluate(`[...document.querySelectorAll('[data-artifact]:not([hidden])')].map(a=>a.href)`);
    assert(links.length === 1 && fs.existsSync(fileURLToPath(links[0])), 'Extracted package executable link missing');
    check('Extracted ZIP guide links to its adjacent executable', links);
  }
  await open('guide.html');
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Guide overflows narrow viewport');
  check('Guide fits a 390px mobile viewport');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', {width:1280,height:960,deviceScaleFactor:1,mobile:false});
  const screenshot = await send('Page.captureScreenshot', {format:'png'});
  fs.writeFileSync(path.join(root, '.analysis', 'guide-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  assert(errors.length === 0, 'Guide JavaScript exceptions: ' + errors.join('; '));
  check('No JavaScript exceptions in local guide or downloaded standalone copy');
  report.completed = true;
} catch (error) { report.failure = String(error.stack ?? error); throw error; }
finally {
  fs.writeFileSync('docs/results/guide-delivery-e2e.json', JSON.stringify(report, null, 2) + '\n');
  for (const request of pending.values()) clearTimeout(request.timer);
  socket.close();
}
