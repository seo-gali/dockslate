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
const browserPort = await waitFor('Website browser port', () => {
  try { return Number(fs.readFileSync(session.portFile, 'utf8').split('\n')[0]); }
  catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error; }
}, 10000);
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
  const rootSite = pathname.startsWith('/dockslate/root/');
  const application = pathname.startsWith('/dockslate/app/');
  const directory = application ? path.join(root, 'dist') : rootSite ? root : output;
  const prefix = application ? '/dockslate/app/' : rootSite ? '/dockslate/root/' : '/dockslate/';
  const relative = pathname.slice(prefix.length) || 'index.html';
  const notFound = () => {
    const fallback = path.join(directory, '404.html');
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.existsSync(fallback) ? fs.readFileSync(fallback) : undefined);
  };
  if (rootSite && !['index.html','guide.html','404.html','robots.txt','sitemap.xml','google474f5421d7424578.html','site/styles.css','site/main.js','site/icon.svg','downloads/THIRD_PARTY_NOTICES.md','downloads/'+release.installer.file,'downloads/'+release.zip.file,'downloads/'+release.licenses.file].includes(relative)) { notFound(); return; }
  const file = path.resolve(directory, relative);
  if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { notFound(); return; }
  const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }[path.extname(file)] ?? 'application/octet-stream';
  response.setHeader('Content-Type', type);
  if (/\.(exe|zip)$/.test(file)) response.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  if (request.method === 'HEAD') { response.end(); return; }
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
report.downloadDirectory = path.relative(root, downloadDir).replaceAll('\\', '/');
try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await navigate(pathToFileURL(path.join(output, 'index.html')).href);
  assert(await evaluate(`document.title.includes('DockSlate')&&!document.querySelector('[role="tablist"]').hidden&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===1`), 'Local file preview is blank or its script failed.');
  check('Local HTML opens with working guide tabs');
  await navigate(pageUrl);
  const publicBase = 'https://seo-gali.github.io/dockslate/';
  for (const folder of ['', 'root/']) {
    for (const page of ['', 'guide.html']) {
      const response = await fetch(pageUrl + folder + page, { redirect: 'manual', headers: { 'User-Agent': 'Googlebot' } });
      const body = await response.text();
      assert(response.status === 200 && !/noindex/i.test(response.headers.get('x-robots-tag') ?? '') && body.includes(`<link rel="canonical" href="${publicBase + page}">`) && (page ? body.includes('id="quickstart"') : body.includes('data-download="installer"') && body.includes('id="features"')), 'Crawler HTML/canonical is incomplete: ' + folder + page);
    }
    const response = await fetch(pageUrl + folder + 'sitemap.xml');
    const xml = await response.text();
    assert(response.status === 200 && response.headers.get('content-type').includes('xml'), 'Sitemap HTTP/type incorrect');
    const parsed = await evaluate(`(()=>{const d=new DOMParser().parseFromString(${JSON.stringify(xml)},'application/xml');return {invalid:!!d.querySelector('parsererror'),namespace:d.documentElement.namespaceURI,urls:[...d.querySelectorAll('loc')].map(e=>e.textContent)}})()`);
    assert(!parsed.invalid && parsed.namespace === 'http://www.sitemaps.org/schemas/sitemap/0.9' && JSON.stringify(parsed.urls) === JSON.stringify([publicBase, publicBase + 'guide.html']), 'Sitemap includes invalid, duplicate or noncanonical routes');
    const robots = await fetch(pageUrl + folder + 'robots.txt');
    const rules = await robots.text();
    assert(robots.status === 200 && /^User-agent: \*$/m.test(rules) && /^Allow: \/$/m.test(rules) && !/^Disallow:\s*\S/m.test(rules) && rules.includes('Sitemap: ' + publicBase + 'sitemap.xml'), 'Project robots has missing sitemap/blocking rules');
    const missing = await fetch(pageUrl + folder + 'missing/deep/page', { redirect: 'manual' });
    assert(missing.status === 404 && (await missing.text()).includes('<p class="code">404</p>') && !missing.headers.has('location'), 'Unknown URL must return a real branded 404 without redirecting');
  }
  check('Preview/root serve complete crawler HTML, canonical URLs, generated sitemap, permissive robots and true custom 404');
  const localLinks = await evaluate(`[...new Set([...document.querySelectorAll('a[href],link[href],script[src]')].map(e=>e.href||e.src).filter(value=>value&&new URL(value).origin===location.origin).map(value=>value.split('#')[0]))]`);
  for (const url of localLinks) {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    assert(response.status === 200 && !response.headers.has('location'), 'Broken or redirected internal link/resource: ' + url);
  }
  check('Every internal page, download and asset link resolves directly without redirect chains', { checked: localLinks.length });
  assert(await evaluate(`['features','start','download','faq'].every(id=>document.getElementById(id))&&document.querySelectorAll('.feature').length===3&&document.querySelectorAll('[data-download]').length===2`), 'Project introduction, usage or downloads missing.');
  check('GitHub Pages project path renders introduction, features, guide, downloads and FAQ');
  assert(await evaluate(`document.querySelector('#engine-license').textContent.includes('엔진 사용료가 없습니다')&&document.querySelector('.footer a[data-license-download][download]')!==null`), 'Engine license explanation or sources link missing.');
  for (const folder of ['', 'root/']) {
    const response = await fetch(pageUrl + folder + 'downloads/THIRD_PARTY_NOTICES.md');
    assert(response.status === 200 && await response.text() === fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'), 'License notices missing or outdated: ' + folder);
  }
  check('Engine usage fee explanation links to exact current notices in preview and publishing root');
  const verification = await fetch(origin + '/dockslate/google474f5421d7424578.html');
  assert(verification.status === 200 && await verification.text() === fs.readFileSync('google474f5421d7424578.html', 'utf8'), 'Google ownership file is not served unchanged');
  check('Google ownership file is served unchanged under the project URL');
  await evaluate(`document.querySelector('.footer a[href="./guide.html"]').click()`);
  await waitFor('Usage guide opens directly', () => evaluate(`!!document.querySelector('#quickstart')`), 10000);
  assert(await evaluate(`document.querySelectorAll('#quickstart li').length===3&&!document.querySelector('button,#site-download,[data-artifact]')&&[...document.querySelectorAll('footer a')].every(a=>a.href.startsWith('https://github.com/seo-gali/dockslate/blob/main/'))`), 'Guide still has export/print/download relay controls');
  check('Usage page opens directly without export, print or download relay controls');
  await navigate(pageUrl + 'root/');
  assert(await evaluate(`document.querySelectorAll('[data-download]').length===2&&!document.querySelector('script[src*="main.tsx"]')&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===1&&[...document.querySelectorAll('[data-download]')].every(a=>a.matches('a[download][href]')&&new URL(a.href).origin===location.origin)`), 'Published page does not include direct downloads');
  const publicFile = await fetch(pageUrl + 'root/google474f5421d7424578.html');
  assert(publicFile.status === 200 && await publicFile.text() === fs.readFileSync('google474f5421d7424578.html', 'utf8'), 'Published Google ownership file changed');
  check('Root static page includes direct downloads and exact Google verification');
  for (const folder of ['root']) {
    for (const key of ['installer','zip','licenses']) {
      const asset=release[key];
      const response=await fetch(pageUrl+folder+'/downloads/'+encodeURIComponent(asset.file));
      assert(response.status===200,'Bundled download is missing: '+folder+'/'+asset.file);
      const checksum=createHash('sha256');let bytes=0;
      for await (const chunk of response.body) { bytes+=chunk.length;checksum.update(chunk); }
      assert(bytes===asset.bytes&&checksum.digest('hex').toUpperCase()===asset.sha256,'Bundled download differs: '+folder+'/'+asset.file);
    }
    check(folder+' serves installer, portable and license/source downloads with exact sizes and SHA-256');
  }
  await navigate(pageUrl + 'root/');
  assert(await evaluate(`!!document.querySelector('#features')&&document.querySelectorAll('[data-download]').length===2&&!document.querySelector('.file-start')&&getComputedStyle(document.body).backgroundColor==='rgb(11, 15, 20)'&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===1`), 'Repository root still serves an empty app fallback or has broken CSS/script paths');
  await evaluate(`document.querySelector('.footer a[href="./guide.html"]').click()`);
  await waitFor('Root website usage navigation', () => evaluate(`!!document.querySelector('#quickstart')&&!document.querySelector('#site-download')`), 10000);
  check('Repository root serves the complete styled website and usage without a redirect loop');
  await navigate(pageUrl + 'app/');
  await waitFor('Built desktop React application renders', () => evaluate(`!!document.querySelector('.app-shell .sidebar')`), 10000);
  assert(await evaluate(`!!document.querySelector('#root .app-shell')&&!document.querySelector('[data-download]')`), 'Desktop build was replaced by the website');
  check('Separated desktop production build still renders the actual React application');
  await navigate(pageUrl);
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
  for (const key of ['installer', 'zip', 'licenses']) {
    const selector = key === 'licenses' ? '[data-license-download]' : `[data-download="${key}"]`;
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const asset = release[key], downloaded = path.join(downloadDir, asset.file);
    await waitFor('Actual ' + key + ' download', () => fs.existsSync(downloaded) && fs.statSync(downloaded).size === asset.bytes && hash(downloaded) === asset.sha256, 20000);
    check(key + ' downloads the exact verified binary without executing it', { bytes: asset.bytes, sha256: asset.sha256 });
  }
  await evaluate(`document.querySelectorAll('.checksum').forEach(item=>item.open=true)`);
  assert(await evaluate(`document.querySelector('.security-note').textContent.includes('미서명')&&document.querySelector('.security-note a[href="https://github.com/seo-gali/dockslate/blob/main/docs/results/code-signing.md"]')&&document.querySelector('.security-note').textContent.includes('SHA-256은 받은 파일이 공개한 배포본과 동일한지 확인하는 값입니다.')&&document.querySelector('#installer-hash').textContent===${JSON.stringify(release.installer.sha256)}`), 'Unsigned notice, security record, hash purpose or displayed checksum missing.');
  check('Unsigned status, security record link, hash purpose and exact SHA-256 remain visible');
  for (const width of [1440, 1024, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Horizontal page overflow at ' + width);
    check('No page overflow at ' + width + 'px, including expanded checksums');
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert(await evaluate(`getComputedStyle(document.documentElement).scrollBehavior==='auto'`), 'Reduced-motion preference ignored.');
  check('Reduced-motion preference disables smooth scrolling');
  await evaluate(`document.querySelectorAll('.checksum').forEach(item=>item.open=false)`);
  for (const [name, width, height] of [['desktop',1440,1000],['mobile',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, '.analysis', `site-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await send('Emulation.setScriptExecutionDisabled', { value: true });
  await navigate(pageUrl);
  assert(await evaluate(`document.querySelectorAll('[data-download][href]').length===2&&document.querySelectorAll('[role="tabpanel"]:not([hidden])').length===4`), 'Downloads or guide content require JavaScript.');
  const indexBlocked = `[...document.querySelectorAll('meta[name]')].some(m=>/^(robots|googlebot)$/i.test(m.name)&&/(^|[^a-z])noindex([^a-z]|$)/i.test(m.content))`;
  assert(!await evaluate(indexBlocked), 'Public page contains a noindex directive');
  await evaluate(`(()=>{const m=document.createElement('meta');m.name='robots';m.content='noindex, follow';m.id='seo-test-robots';document.head.append(m)})()`);
  assert(await evaluate(indexBlocked), 'Browser indexing guard failed to detect injected noindex');
  await evaluate(`document.getElementById('seo-test-robots').remove()`);
  check('Downloads and complete usage guide remain available with JavaScript disabled');
  await navigate(pageUrl + 'missing/deep/page');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert(await evaluate(`document.querySelector('h1')&&document.querySelectorAll('nav a').length===2&&[...document.querySelectorAll('nav a')].every(a=>a.href.startsWith(${JSON.stringify(publicBase)}))&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('script,meta[http-equiv="refresh"]')`), '404 recovery is broken on nested URLs or without JavaScript');
  fs.writeFileSync(path.join(root, '.analysis', 'site-404-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  check('Nested missing URL has a styled mobile 404 and absolute recovery links without JavaScript');
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
