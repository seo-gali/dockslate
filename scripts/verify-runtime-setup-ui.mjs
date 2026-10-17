import fs from 'node:fs';
import path from 'node:path';

const [portFile, outputDirectory = '.analysis/runtime-setup-ui'] = process.argv.slice(2);
if (!portFile) throw new Error('Provide the native WebView DevToolsActivePort file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && item.url === 'http://tauri.localhost/');
if (!target) throw new Error('Native DockSlate window not found');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Only local WebView debugging is permitted');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let counter = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
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
  throw new Error('Runtime setup UI did not reach its expected state');
};
const checks = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await evaluate("Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === 'Settings').click()");
  await waitUntil("Array.from(document.querySelectorAll('main button')).some(button => button.textContent.includes('런타임 설치') && !button.disabled)");
  const before = await evaluate("window.__TAURI_INTERNALS__.invoke('runtime_status')");
  checks.push({ name: 'real backend reports runtime not installed', passed: before.state === 'not_installed' });
  await evaluate("Array.from(document.querySelectorAll('main button')).find(button => button.textContent.includes('런타임 설치')).click()");
  await waitUntil("!!document.querySelector('[role=dialog]')");
  const dialog = await evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    const checkbox = dialog.querySelector('input[type=checkbox]');
    const execute = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent.includes('설치 승인 및 실행'));
    const heading = dialog.querySelector('.dialog-heading').getBoundingClientRect();
    const footer = dialog.querySelector('footer').getBoundingClientRect();
    return { text: dialog.innerText, approvalChecked: checkbox?.checked, executionDisabled: execute?.disabled,
      headingVisible: heading.top >= 0 && heading.bottom <= innerHeight,
      footerVisible: footer.top >= 0 && footer.bottom <= innerHeight,
      startsAtTop: dialog.querySelector('.dialog-content').scrollTop === 0 };
  })()`);
  checks.push({ name: 'preview identifies the new DockSlate distribution', passed: dialog.text.includes('DockSlate') && dialog.text.includes('WSL 2'), text: dialog.text });
  checks.push({ name: 'preview identifies pinned engine and separate data', passed: dialog.text.includes('29.8.2') && dialog.text.includes('ext4.vhdx') });
  checks.push({ name: 'installation requires unchecked explicit approval', passed: dialog.approvalChecked === false && dialog.executionDisabled === true });
  checks.push({ name: 'long installation preview keeps its title and controls visible', passed: dialog.headingVisible && dialog.footerVisible && dialog.startsAtTop });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDirectory, 'runtime-install-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent.trim() === '취소').click()");
  await waitUntil("!document.querySelector('[role=dialog]')");
  const after = await evaluate("window.__TAURI_INTERNALS__.invoke('runtime_status')");
  checks.push({ name: 'cancel preserves runtime not installed', passed: after.state === 'not_installed' && !after.operation });
  const report = { observedAt: new Date().toISOString(), target: 'actual Windows Tauri runtime setup UI', mockData: false, approvedMutation: false, checks };
  fs.writeFileSync('docs/results/standalone-runtime-ui-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: checks.map(({ name, passed }) => ({ name, passed })) }));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} finally {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Verification ended')); }
  socket.close();
}
