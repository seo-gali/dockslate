import fs from 'node:fs';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(description, query, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await query(); if (result) return result; await pause(100); }
  throw new Error(`Timed out: ${description}`);
}

export async function connectNative(portFile) {
  if (process.platform !== 'win32') throw new Error('An actual Windows DockSlate window is required');
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local WebView port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
  if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Built local native window required');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(), calls = [], exceptions = [];
  let sequence = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      try { const url = new URL(request.url); if (url.hostname === 'ipc.localhost' && request.method === 'POST') calls.push({ command: decodeURIComponent(url.pathname.slice(1)), started: Date.now(), requestId: message.params.requestId }); } catch {}
    }
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
      const call = calls.findLast(item => item.requestId === message.params.requestId);
      if (call) { call.durationMs = Date.now() - call.started; call.failed = message.method === 'Network.loadingFailed'; }
    }
    const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.value ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result.value;
  };
  const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const nav = async name => {
    await evaluate(`(()=>{const b=[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${JSON.stringify(name)});if(!b||b.disabled)throw new Error('Menu unavailable');b.click();})()`);
    await waitFor(`active ${name}`, () => evaluate(`document.querySelector('main [data-page]:not([hidden])')?.getAttribute('data-page')===${JSON.stringify(name)}`));
  };
  const setInput = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Input unavailable');Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const setSelect = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Select unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  return { invoke, evaluate, send, nav, setInput, setSelect, waitFor, pause, calls, exceptions, close: () => { for (const request of pending.values()) clearTimeout(request.timer); pending.clear(); socket.close(); } };
}
