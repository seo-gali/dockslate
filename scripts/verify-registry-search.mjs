import fs from 'node:fs';
import path from 'node:path';

const [portFile] = process.argv.slice(2);
if (!portFile || process.platform !== 'win32') throw new Error('Provide the actual Windows DockSlate WebView DevToolsActivePort file');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native loopback debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && item.url === 'http://tauri.localhost/');
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Only the actual local DockSlate native window is permitted');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let counter = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native registry verification timeout: ${method}`)); }, 90000);
  pending.set(id, { timer, resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    throw new Error(exception?.value !== undefined ? String(exception.value) : exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};
const allowedCommands = new Set(['engine_status', 'images_list', 'containers_list', 'image_search']);
const invokedCommands = [];
const invoke = async (command, args = {}) => {
  if (!allowedCommands.has(command)) throw new Error('This verification only permits read-only backend commands');
  invokedCommands.push(command);
  const result = await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: typeof error === 'string' ? error : error?.message ?? JSON.stringify(error) ?? String(error) })
  )`);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const activeImages = 'main [data-page="Images"]:not([hidden])';
const pageExpression = `document.querySelector(${JSON.stringify(activeImages)})`;
const fact = (value, message) => { if (!value) throw new Error(message); };
const waitFor = async (description, query, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await query()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const setInput = async (selector, value) => evaluate(`(() => {
  const input = ${pageExpression}?.querySelector(${JSON.stringify(selector)});
  if (!input || input.disabled) throw new Error('Actual enabled native input unavailable: ' + ${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const navigate = async name => {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('nav button')].find(item => item.textContent.trim() === ${JSON.stringify(name)});
    if (!button || button.disabled) throw new Error('Native navigation unavailable: ' + ${JSON.stringify(name)});
    button.click();
  })()`);
  await waitFor(`active ${name} page`, () => evaluate(`!!document.querySelector(${JSON.stringify(`main [data-page="${name}"]:not([hidden])`)})`));
};
const identities = values => values.map(value => value.tags ? { id: value.id, tags: [...value.tags].sort() } : { id: value.id, image: value.image }).sort((left, right) => left.id.localeCompare(right.id));
const report = {
  observedAt: new Date().toISOString(), target: 'actual Windows Tauri WebView and real owned Moby Engine Docker Hub search',
  mockData: false, mutationExecuted: false, checks: [], observations: {}, completed: false,
  failurePolicy: 'Stop on actual network, engine, or UI failure; never substitute results or execute Pull/cleanup.'
};
const check = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); };
const outputDirectory = '.analysis/registry-search-e2e';
fs.mkdirSync(outputDirectory, { recursive: true });
fs.mkdirSync('docs/results', { recursive: true });
const capture = async name => {
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDirectory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
};
let previousLocalFilter = null;
try {
  await send('Runtime.enable'); await send('Page.enable');
  const engine = await invoke('engine_status');
  fact(engine.state === 'connected' && engine.provider === 'DockSlate' && engine.engine === 'moby', 'Actual owned DockSlate Moby engine is not connected');
  report.observations.engine = engine;
  const beforeImages = identities(await invoke('images_list'));
  const beforeContainers = identities(await invoke('containers_list'));
  report.observations.before = { images: beforeImages, containers: beforeContainers };
  await navigate('Images');
  await waitFor('native Images Pull button', () => evaluate(`!![...${pageExpression}.querySelectorAll('button')].find(button => button.textContent.trim() === 'Pull image' && !button.disabled)`));
  fact(await evaluate(`(() => { const input=${pageExpression}.querySelector('#registry-search'); const rect=input?.getBoundingClientRect(); return !!input && !input.disabled && rect.width>0 && rect.height>0 && !${pageExpression}.querySelector('.pull-form'); })()`), 'Connected Images must expose Hub search immediately without opening Pull');
  await waitFor('separate registry search input', () => evaluate(`!!${pageExpression}.querySelector('#registry-search')`));
  const localSelector = 'input[placeholder^="로컬 이미지"]';
  previousLocalFilter = await evaluate(`${pageExpression}.querySelector(${JSON.stringify(localSelector)})?.value ?? null`);
  fact(previousLocalFilter !== null, 'The local image filter is not clearly distinguished from Docker Hub search');
  const localFilter = 'dockslate-local-filter-preserved';
  await setInput(localSelector, localFilter);
  await setInput('#registry-search', 'hello');
  await evaluate(`(() => {
    const button = [...${pageExpression}.querySelectorAll('button')].find(item => item.textContent.trim() === 'Docker Hub 검색');
    if (!button || button.disabled) throw new Error('Real Docker Hub search action is unavailable');
    button.click();
  })()`);
  await waitFor('actual Docker Hub hello search response', async () => {
    const state = await evaluate(`(() => {
      const page = ${pageExpression};
      const error = [...page.querySelectorAll('[role="alert"]')].find(item => item.innerText.includes('Docker Hub 검색 실패'));
      return { error: error?.innerText ?? null, completed: !!page.querySelector('table[aria-label="Docker Hub 검색 결과"]') || page.innerText.includes('Docker Hub 검색 결과가 없습니다') };
    })()`);
    if (state.error) throw new Error(`Actual Docker Hub search failed: ${state.error}`);
    return state.completed;
  });
  const rows = await evaluate(`[...${pageExpression}.querySelectorAll('table[aria-label="Docker Hub 검색 결과"] tbody tr')].map(row => ({ name: row.querySelector('strong')?.textContent ?? '', official: row.innerText.includes('Official'), text: row.innerText }))`);
  report.observations.searchTerm = 'hello'; report.observations.actualResults = rows;
  fact(rows.length > 0 && rows.length <= 25 && rows.some(row => row.name === 'hello-world' && row.official), 'Real Docker Hub hello search did not return official hello-world within the bounded results');
  check('native Docker Hub search returns actual official hello-world with bounded results');
  fact(await evaluate(`${pageExpression}.querySelector(${JSON.stringify(localSelector)}).value === ${JSON.stringify(localFilter)}`), 'Registry search replaced the distinct local image filter');
  check('registry search and local image filter maintain separate values');
  const inputRect = await evaluate(`(() => { const input=${pageExpression}.querySelector('#registry-search'); input.scrollIntoView({block:'center'}); const rect=input.getBoundingClientRect(); return {x:rect.left+12,y:rect.top+rect.height/2,endX:rect.left+100}; })()`);
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:inputRect.x,y:inputRect.y});
  await send('Input.dispatchMouseEvent', {type:'mousePressed',x:inputRect.x,y:inputRect.y,button:'left',buttons:1,clickCount:1});
  for (let step=1;step<=8;step+=1) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:inputRect.x+(inputRect.endX-inputRect.x)*step/8,y:inputRect.y,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:inputRect.endX,y:inputRect.y,button:'left',buttons:0,clickCount:1});
  report.observations.inputSelection = await evaluate(`(() => { const input=${pageExpression}.querySelector('#registry-search'); return {value:input.value,start:input.selectionStart,end:input.selectionEnd,css:getComputedStyle(input).userSelect}; })()`);
  fact(report.observations.inputSelection.value==='hello' && report.observations.inputSelection.end>report.observations.inputSelection.start, 'App chrome selection policy prevented actual mouse selection in an editable search input');
  check('connected Hub search is immediately visible and editable search text remains selectable with an actual mouse drag');
  await capture('01-actual-hello-results');
  await evaluate(`(() => {
    const button = ${pageExpression}.querySelector('button[aria-label="hello-world 이미지 선택"]');
    if (!button || button.disabled) throw new Error('Official hello-world selection is unavailable');
    button.click();
  })()`);
  await waitFor('selected image reference', () => evaluate(`${pageExpression}.querySelector('#image-reference')?.value === 'hello-world:latest'`));
  fact(await evaluate(`${pageExpression}.innerText.includes('검색 결과를 선택하면 :latest')`), 'Selected latest tag is not explained explicitly');
  check('selecting hello-world fills explicit latest reference without executing Pull');
  await capture('02-selection-without-pull');
  await navigate('Containers'); await navigate('Images');
  const preserved = await evaluate(`(() => {
    const page = ${pageExpression};
    return { term: page.querySelector('#registry-search')?.value, reference: page.querySelector('#image-reference')?.value,
      localFilter: page.querySelector(${JSON.stringify(localSelector)})?.value,
      names: [...page.querySelectorAll('table[aria-label="Docker Hub 검색 결과"] tbody strong')].map(item => item.textContent) };
  })()`);
  report.observations.afterNavigation = preserved;
  fact(preserved.term === 'hello' && preserved.reference === 'hello-world:latest' && preserved.localFilter === localFilter && JSON.stringify(preserved.names) === JSON.stringify(rows.map(row => row.name)), 'Registry results, selection, or local filter were lost after native navigation');
  check('native navigation preserves registry results, selection, and local filter');
  const invalidInputs = ['https://hub.docker.com/search?q=hello', 'hello\nworld', 'example.com/hello', '../hello', 'h'.repeat(129)];
  report.observations.invalidInputs = [];
  for (const term of invalidInputs) {
    let rejection = null;
    try { await invoke('image_search', { term }); } catch (error) { rejection = String(error); }
    report.observations.invalidInputs.push({ term, rejection });
    fact(rejection?.includes('Docker Hub 검색어는'), `Invalid term was not rejected by Rust input validation: ${JSON.stringify(term)}`);
  }
  check('Rust rejects URL, embedded control character, external registry, traversal, and oversized terms before querying Hub');
  const afterImages = identities(await invoke('images_list'));
  const afterContainers = identities(await invoke('containers_list'));
  report.observations.after = { images: afterImages, containers: afterContainers };
  fact(JSON.stringify(beforeImages) === JSON.stringify(afterImages) && JSON.stringify(beforeContainers) === JSON.stringify(afterContainers), 'Image or container identities changed during read-only registry verification');
  check('registry search and selection leave actual images and containers unchanged');
  fact(exceptions.length === 0, 'Native renderer emitted an exception during registry verification');
  check('native registry UI reports no renderer exceptions');
  report.completed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  console.log(JSON.stringify({ completed: false, failure: String(error) }));
  try { await capture('failure'); } catch (captureError) { report.screenshotFailure = String(captureError); }
} finally {
  if (previousLocalFilter !== null) {
    try {
      if (await evaluate(`!!${pageExpression}`)) await setInput('input[placeholder^="로컬 이미지"]', previousLocalFilter);
    } catch (restoreError) { report.localFilterRestoreFailure = String(restoreError); }
  }
  report.observations.invokedCommands = invokedCommands;
  report.rendererExceptions = exceptions;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync('docs/results/registry-search-e2e.json', JSON.stringify(report, null, 2));
  socket.close();
}
