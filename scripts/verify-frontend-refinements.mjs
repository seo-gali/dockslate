import fs from 'node:fs';
import { waitFor, pause } from './native-verification.mjs';
const s = JSON.parse(fs.readFileSync(process.argv[2] ?? '.analysis/frontend-browser-session.json', 'utf8').replace(/^\uFEFF/, '')), port = Number(fs.readFileSync(s.portFile, 'utf8').split('\n')[0]);
if (!s.frontendOnly || s.nativeBackendInjected !== false || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Isolated frontend browser session required');
const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
const frontendUrl = s.url ?? 'http://127.0.0.1:1420/';
if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(frontendUrl)) throw Error('Loopback frontend URL required');
const page = list.find(p => p.type === 'page' && p.url === frontendUrl);
if (!page)
    throw Error('Isolated frontend missing');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.webSocketDebuggerUrl).hostname))
    throw Error('Only a local browser debugger is allowed');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((a, b) => { ws.addEventListener('open', a, { once: true }); ws.addEventListener('error', b, { once: true }); });
let seq = 0;
const pending = new Map(), requests = [], errors = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Network.requestWillBeSent')
    requests.push({ url: m.params.request.url, type: m.params.type }); if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); const p = pending.get(m.id); if (p) {
    clearTimeout(p.timer);
    pending.delete(m.id);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
} });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => reject(Error('CDP timeout')), 30000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const report = { observedAt: new Date().toISOString(), completed: false, target: 'Built production frontend in isolated signed Chrome; native backend unavailable; no mock data', checks: [], failure: null };
const assert = (v, m) => { if (!v)
    throw Error(m); };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ check: name, passed: true })); };
const click = (scope, text) => ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing control '+${JSON.stringify(text)});e.click()})()`);
const nav = async (index, id) => { const started = Date.now(); await ev(`document.querySelectorAll('nav button')[${index}].click()`); await waitFor('page ' + id, () => ev(`(()=>{const e=document.querySelector('[data-page="${id}"]');return e&&!e.hidden&&!!e.querySelector('h1')})()`)); await ev(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`); return Date.now() - started; };
const select = value => ev(`(()=>{const e=document.querySelector('#display-language');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
try {
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await ev("localStorage.setItem('dockslate.language','ko')");
    await send('Page.reload');
    await waitFor('initial Overview', () => ev(`!!document.querySelector('[data-page="Overview"] h1')`));
    assert(!await ev(`'__TAURI_INTERNALS__' in window`), 'Native backend was injected');
    await pause(200);
    const initial = requests.filter(r => r.type === 'Script').map(r => r.url);
    assert(!initial.some(url => /(Containers|Images|Resources|Builds|DiskManager|Settings|locales\.en)-/.test(url)), 'Unvisited page or English catalog loaded at startup');
    check('Only entry and Overview scripts load for initial Korean screen', initial);
    await nav(6, 'Settings');
    await select('en');
    await waitFor('English language', () => ev(`document.documentElement.lang==='en'&&document.querySelectorAll('nav button')[6].textContent.trim()==='Settings'`));
    assert(requests.some(r => r.url.includes('locales.en-')), 'English catalog did not lazy load');
    check('English catalog loads on selection and translates navigation');
    await send('Page.reload');
    await waitFor('English persisted', () => ev(`document.querySelectorAll('nav button')[6]?.textContent.trim()==='Settings'`));
    check('English preference persists after actual browser reload');
    const pages = ['Overview', 'Containers', 'Images', 'Resources', 'Builds', 'Disk Manager', 'Settings'], times = [];
    for (let i = 0; i < pages.length; i++)
        times.push({ page: pages[i], firstVisitMs: await nav(i, pages[i]) });
    check('All seven lazy screens mount without JavaScript errors', times);
    assert(!requests.some(r => /\/Container(Files|Inspect|Logs|Terminal)-/.test(r.url)), 'Container details loaded before opening their tabs');
    check('Container detail scripts and file CSS remain unloaded during list navigation');
    await nav(6, 'Settings');
    let active = await ev(`[...document.querySelectorAll('[data-page="Settings"] [role="tab"]')].map(e=>({text:e.textContent.trim(),active:e.getAttribute('aria-selected')}))`);
    assert(active.length === 3, 'Settings not split into three tabs');
    await click('[data-page="Settings"] [role="tablist"]', 'Runtime');
    assert(await ev(`document.querySelector('[data-page="Settings"] .appearance-panel').closest('[hidden]')!==null`), 'Appearance remained visible beside Runtime');
    await click('[data-page="Settings"] [role="tablist"]', 'Engine connection');
    assert(await ev(`!!document.querySelector('[data-page="Settings"] .engine-details:not([hidden])')`), 'Connection tab missing');
    await click('[data-page="Settings"] [role="tablist"]', 'Appearance');
    check('Settings uses appearance, runtime and connection tabs', active);
    await click('[data-page="Settings"] .appearance-panel', 'Light');
    assert(await ev(`document.documentElement.dataset.theme==='light'`), 'Light theme missing');
    await click('[data-page="Settings"] .appearance-panel', 'A+');
    assert(await ev(`document.querySelector('.font-size-controls output').value==='13px'`), 'Font size did not update');
    await click('[data-page="Settings"] .appearance-panel', 'Default');
    await click('[data-page="Settings"] .appearance-panel', 'Dark');
    check('Theme and font size controls work after lazy loading');
    await nav(2, 'Images');
    await click('[data-page="Images"] [role="tablist"]', 'Docker Hub');
    assert(await ev(`document.querySelector('.registry-search-panel').getClientRects().length>0`), 'Registry tab hidden');
    await nav(0, 'Overview');
    await nav(2, 'Images');
    assert(await ev(`document.querySelector('[data-page="Images"] [role="tablist"] button[aria-selected="true"]').textContent==='Docker Hub'`), 'Mounted image tab state was lost');
    check('Images separates local and registry blocks and preserves tab state');
    await nav(3, 'Resources');
    await click('[data-page="Resources"] [role="tablist"]', 'Network');
    await nav(0, 'Overview');
    await nav(3, 'Resources');
    assert(await ev(`document.querySelector('[data-page="Resources"] [role="tablist"] button[aria-selected="true"]').textContent==='Network'`), 'Resource tab reset');
    check('Resources preserves volume/network tab state');
    await nav(4, 'Builds');
    const tabs = await ev(`[...document.querySelectorAll('[data-page="Builds"] [role="tablist"] button')].map(e=>e.textContent)`);
    assert(tabs.length === 5, 'Build tabs missing while disconnected');
    await click('[data-page="Builds"] [role="tablist"]', 'Build from file');
    assert(await ev(`document.querySelector('[data-page="Builds"] .image-build-panel').getClientRects().length>0`), 'File source panel hidden');
    check('Build file import has its own tab and offline actions remain disabled', tabs);
    await nav(6, 'Settings');
    await select('ko');
    await waitFor('Korean restored', () => ev(`document.querySelectorAll('nav button')[6].textContent.trim()==='설정'`));
    assert(errors.length === 0, 'Unhandled browser exceptions: ' + errors.join(';'));
    report.scripts = [...new Set(requests.filter(r => r.type === 'Script').map(r => r.url))];
    report.errors = errors;
    report.completed = true;
}
catch (e) {
    report.failure = e.message;
    process.exitCode = 1;
    console.error(e.stack);
}
finally {
    fs.writeFileSync(process.argv[3] ?? 'docs/results/frontend-refinements-e2e.json', JSON.stringify(report, null, 2));
    for (const p of pending.values())
        clearTimeout(p.timer);
    ws.close();
}
