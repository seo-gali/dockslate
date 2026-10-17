import fs from 'node:fs';
import path from 'node:path';

const [activePortFile, outputDirectory = '.analysis/native-ui', mode = 'native'] = process.argv.slice(2);
if (!['native', 'frontend'].includes(mode)) throw new Error('Verification mode must be native or frontend');
const native = mode === 'native';
if (!activePortFile) throw new Error('Usage: node scripts/verify-native-ui.mjs WEBVIEW_DEVTOOLS_ACTIVE_PORT [OUTPUT_DIRECTORY]');
const port = Number(fs.readFileSync(activePortFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && (native ? /^https?:\/\/tauri\.localhost\//.test(item.url) : /^http:\/\/127\.0\.0\.1:1420\//.test(item.url)));
if (!target) throw new Error('The built Tauri window is not available');
const wsUrl = new URL(target.webSocketDebuggerUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(wsUrl.hostname)) throw new Error('Only local WebView debugging is permitted');
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let counter = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitUntil = async expression => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('UI did not reach the expected state');
};
fs.mkdirSync(outputDirectory, { recursive: true });
const checks = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await waitUntil("!!document.querySelector('nav button')");
  const hasTauri = await evaluate("!!window.__TAURI_INTERNALS__");
  checks.push({ name: native ? 'native Tauri backend available' : 'browser has no injected Tauri backend', passed: native ? hasTauri : !hasTauri });
  await waitUntil(native ? "document.body.innerText.includes('Disconnected') || document.body.innerText.includes('Connected') || document.body.innerText.includes('지원하지 않는 엔진') || document.body.innerText.includes('권한 부족')" : "document.body.innerText.includes('백엔드 연결 실패') && document.body.innerText.includes('데스크톱 백엔드에 연결할 수 없습니다')");
  for (const name of ['Overview', 'Containers', 'Images', 'Disk Manager', 'Settings']) {
    await evaluate(`Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
    await waitUntil(`document.querySelector('nav button[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(name)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = await evaluate('document.querySelector("main").innerText');
    if (!text.trim()) throw new Error(`Empty page: ${name}`);
    checks.push({ name: `${name} ${native ? 'native' : 'browser'} navigation`, passed: true, text });
    if (name === 'Images') {
      const unsafeEnabled = await evaluate("Array.from(document.querySelectorAll('main button')).some(button => /Pull|삭제/.test(button.textContent) && !button.disabled)");
      checks.push({ name: 'image mutations disabled when offline', passed: !unsafeEnabled });
    }
    if (name === 'Disk Manager') {
      await evaluate("Array.from(document.querySelectorAll('button[role=tab]')).find(button => button.textContent.includes('WSL Disks')).click()");
      await waitUntil("!document.querySelector('main [aria-busy=true]')");
      const wslText = await evaluate('document.querySelector("main").innerText');
      checks.push({ name: native ? 'WSL disk native inventory result' : 'WSL browser reports desktop backend unavailable', passed: native ? !wslText.includes('조회 중') : wslText.includes('데스크톱 백엔드에 연결할 수 없습니다'), text: wslText });
    }
  }
  await evaluate("Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === 'Overview').click()");
  for (const [width, height] of [[1200, 780], [1000, 640]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 200));
    const layout = await evaluate('({viewportWidth:innerWidth,viewportHeight:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})');
    checks.push({ name: `layout ${width}×${height}`, passed: layout.scrollWidth <= width, ...layout });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDirectory, `dockslate-${width}x${height}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  checks.push({ name: 'unhandled renderer exceptions', passed: exceptions.length === 0, exceptions });
  const report = { target: native ? 'built Windows Tauri WebView2' : 'React frontend in Chrome; Tauri is unavailable; not native app E2E', url: target.url, mockData: false, destructiveActions: false, checks };
  fs.writeFileSync(path.join(outputDirectory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: checks.map(({ name, passed }) => ({ name, passed })), exceptions }));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} finally {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Verification ended')); }
  socket.close();
}
