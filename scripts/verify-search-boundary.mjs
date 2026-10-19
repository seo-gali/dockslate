import fs from 'node:fs';
const session = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/search-performance-session.json', 'utf8').replace(/^\uFEFF/, ''));
if (!session.frontendOnly || session.nativeBackendInjected !== false || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(session.url)) throw Error('Isolated loopback frontend required');
const port = Number(fs.readFileSync(session.portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid debugger port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(value => value.type === 'page' && value.url === session.url);
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw Error('Isolated local frontend required');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
let sequence = 0;
const pending = new Map();
ws.addEventListener('message', event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true}); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
try {
  const cases = await evaluate(`(async () => {
    if ('__TAURI_INTERNALS__' in window) throw Error('Injected backend is forbidden');
    const { backend } = await import('/src/api.ts');
    const values = [undefined, {}, {term:null}, {term:[]}, {term:''}, {term:'  '}, {term:'\\t\\n'}, {term:'\\u00a0\\u3000'}, {term:'\\u200b'}, {term:'x'.repeat(129)}, {term:'../hello'}, {term:'hello\\nworld'}, {term:'example.com/hello'}];
    const output = [];
    for (const args of values) { try { await backend('image_search', args); output.push({args, rejected:false}); } catch(error) { output.push({args, rejected:true, message:error.message ?? String(error)}); } }
    for (const term of ['hello', '  nginx  ', 'hashicorp/consul', 'library/hello-world', 'a', 'image.name']) {
      try { await backend('image_search', {term}); output.push({args:{term},valid:true,rejected:false}); }
      catch(error) { output.push({args:{term},valid:true,rejected:true,message:error.message ?? String(error)}); }
    }
    return output;
  })()`);
  const passed = cases.every(value => value.rejected && value.message.includes(value.valid ? '데스크톱 백엔드에 연결할 수 없습니다.' : 'Docker Hub 검색어는'));
  const report = {completed:passed,observedAt:new Date().toISOString(),scope:'Actual frontend API boundary in isolated Chrome; no native backend or registry response mocked',cases};
  fs.writeFileSync(process.argv[3] ?? 'docs/results/search-boundary-browser.json', JSON.stringify(report,null,2));
  console.log(JSON.stringify({completed:passed,cases:cases.length,invalidRejected:cases.filter(value => !value.valid).length,validReachedBackendCheck:cases.filter(value => value.valid).length}));
  if (!passed) process.exitCode=1;
} finally { ws.close(); }
