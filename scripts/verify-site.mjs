import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { waitFor } from './native-verification.mjs';

const root = path.resolve('.');
const output = path.join(root, 'site-dist');
const release = JSON.parse(fs.readFileSync('site/release.json', 'utf8'));
const session = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/site-browser-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.frontendOnly || session.nativeBackendInjected !== false || !path.resolve(session.profile).startsWith(path.join(root, '.analysis', 'site-browser-'))) throw Error('A fresh isolated website browser is required.');
await waitFor('Website browser port', () => fs.existsSync(session.portFile), 10000);
const browserPort = Number(fs.readFileSync(session.portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535) throw Error('Invalid local browser port.');
const targets = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && item.url === 'about:blank');
if (!target || new URL(target.webSocketDebuggerUrl).hostname !== '127.0.0.1') throw Error('An isolated blank page is required.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map(), exceptions = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const assert = (value, reason) => { if (!value) throw Error(reason); };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const report = { observedAt: new Date().toISOString(), target: 'Actual isolated Chrome, local files and HTTP /dockslate/ project path; no native backend', completed: false, checks: [], failure: null, publicDeploymentTested: false };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ name, passed: true })); };
const server = http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end(); return; }
  if (!pathname.startsWith('/dockslate/')) { response.writeHead(404).end(); return; }
  const file = path.resolve(output, pathname.slice('/dockslate/'.length) || 'index.html');
  if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
  response.setHeader('Content-Type', type);
  if (/\.(exe|zip)$/.test(file)) response.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = origin + '/dockslate/';
const navigate = async url => {
  await send('Page.navigate', { url });
  await waitFor('Website navigation', () => evaluate(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`), 10000);
};
const downloadDir = path.join(root, '.analysis', 'site-download-test-' + randomUUID());
fs.mkdirSync(downloadDir);
try {
  await send('Runtime.enable'); await send('Page.enable');
  await navigate(pathToFileURL(path.join(output, 'index.html')).href);
  assert(await evaluate(`document.title.includes('DockSlate')&&!document.querySelector('[role="tablist"]').hidden&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===1`), 'Local file preview is blank or its script failed.');
  check('Local HTML opens with working guide tabs');
  await navigate(pageUrl);
  assert(await evaluate(`['features','start','download','faq'].every(id=>document.getElementById(id))&&document.querySelectorAll('.feature').length===3&&document.querySelectorAll('[data-download]').length===2`), 'Project introduction, usage or downloads missing.');
  check('GitHub Pages project path renders introduction, features, guide, downloads and FAQ');
  const brokenAnchors = await evaluate(`[...document.querySelectorAll('a[href^="#"]')].map(a=>a.hash).filter(hash=>!document.getElementById(hash.slice(1)))`);
  assert(brokenAnchors.length === 0, 'Broken in-page links.');
  check('Navigation anchors resolve within the page');
  for (const id of ['install', 'container', 'build', 'cli']) {
    await evaluate(`document.getElementById('tab-${id}').click()`);
    assert(await evaluate(`document.getElementById('tab-${id}').getAttribute('aria-selected')==='true'&&!document.getElementById('panel-${id}').hidden&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===1`), 'Guide tab failed: ' + id);
  }
  check('All four guide tabs show only their selected panel');
  await evaluate(`document.getElementById('tab-install').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  assert(await evaluate(`document.activeElement.id==='tab-container'&&document.getElementById('tab-container').getAttribute('aria-selected')==='true'`), 'Arrow-key tab navigation failed.');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
  assert(await evaluate(`document.activeElement.id==='tab-cli'`), 'End-key tab navigation failed.');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' });
  assert(await evaluate(`document.activeElement.id==='tab-install'`), 'Home-key tab navigation failed.');
  check('Keyboard arrows, Home and End move selection and focus');
  await send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await send('Page.bringToFront');
  await evaluate(`document.querySelector('[data-copy-target="install-command"]').click()`);
  await waitFor('Command copied', () => evaluate(`document.querySelector('[data-copy-target="install-command"]').textContent==='복사됨'`), 5000);
  const copied = await evaluate(`navigator.clipboard.readText()`);
  assert(copied.replaceAll('\r\n', '\n') === 'docker ps\ndocker compose version\ndocker buildx version', 'Clipboard command differs from the displayed command.');
  check('Copy button writes the exact installation commands to the clipboard');
  await evaluate(`document.querySelector('.faq-list summary').click()`);
  assert(await evaluate(`document.querySelector('.faq-list details').open`), 'FAQ did not expand.');
  await evaluate(`document.querySelector('.faq-list summary').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert(await evaluate(`!document.querySelector('.faq-list details').open`), 'FAQ keyboard interaction failed.');
  check('FAQ expands with native mouse and keyboard support');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  for (const key of ['installer', 'zip']) {
    await evaluate(`document.querySelector('[data-download="${key}"]').click()`);
    const asset = release[key], downloaded = path.join(downloadDir, asset.file);
    await waitFor('Actual ' + key + ' download', () => fs.existsSync(downloaded) && fs.statSync(downloaded).size === asset.bytes && hash(downloaded) === asset.sha256, 20000);
    check(key + ' downloads the exact verified binary without executing it', { bytes: asset.bytes, sha256: asset.sha256 });
  }
  await evaluate(`document.querySelectorAll('.checksum').forEach(item=>item.open=true)`);
  assert(await evaluate(`document.querySelector('.security-note').textContent.includes('미서명')&&document.querySelector('.security-note').textContent.includes('미확인')&&document.querySelector('#installer-hash').textContent===${JSON.stringify(release.installer.sha256)}`), 'Unsigned notice or displayed checksum missing.');
  check('Unsigned status, unresolved alert and exact SHA-256 remain visible');
  for (const width of [1440, 1024, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Horizontal page overflow at ' + width);
    check('No page overflow at ' + width + 'px, including expanded checksums');
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert(await evaluate(`getComputedStyle(document.documentElement).scrollBehavior==='auto'`), 'Reduced-motion preference ignored.');
  check('Reduced-motion preference disables smooth scrolling');
  for (const [name, width, height] of [['desktop',1440,1000],['mobile',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, '.analysis', `site-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await send('Emulation.setScriptExecutionDisabled', { value: true });
  await navigate(pageUrl);
  assert(await evaluate(`document.querySelectorAll('[data-download][href]').length===2&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===4`), 'Downloads or guide content require JavaScript.');
  check('Downloads and complete usage guide remain available with JavaScript disabled');
  await send('Emulation.setScriptExecutionDisabled', { value: false });
  assert(exceptions.length === 0, 'Website JavaScript exceptions: ' + exceptions.join('; '));
  check('No JavaScript exceptions in actual file or HTTP pages');
  report.completed = true;
} catch (error) { report.failure = String(error.stack ?? error); throw error; }
finally {
  fs.writeFileSync('docs/results/pages-e2e.json', JSON.stringify(report, null, 2) + '\n');
  for (const request of pending.values()) clearTimeout(request.timer);
  socket.close();
  server.closeAllConnections(); server.close();
}
