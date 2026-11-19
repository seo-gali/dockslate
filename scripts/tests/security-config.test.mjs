import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const read = file => fs.readFileSync(new URL('../../' + file, import.meta.url),'utf8');
test('desktop origin and permissions keep remote pages out of system access', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.ok(config.app.windows.every(window => window.devtools === false));
  assert.equal(config.app.security.headers['X-Content-Type-Options'],'nosniff');
  assert.match(config.app.security.csp,/frame-ancestors 'none'/);
  assert.match(read('src/index.html'),/<meta name="referrer" content="no-referrer"/);
  assert.ok(!/script-src[^;]*(?:unsafe-eval|unsafe-inline|\*)/.test(config.app.security.csp));
  const capability = JSON.parse(read('src-tauri/capabilities/main.json'));
  assert.deepEqual(capability.windows,['main']);
  assert.equal(capability.remote,undefined);
  assert.ok(!capability.permissions.some(permission=>/^(?:shell|fs|http):/.test(permission)));
});
test('all public HTML entry points block form submission and suppress referrers', () => {
  for(const file of ['site/index.html','site/guide.html','site/404.html']) {
    const html=read(file);
    assert.match(html,/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+form-action 'none'/);
    assert.match(html,/<meta name="referrer" content="no-referrer">/);
    assert.doesNotMatch(html,/<form\b/i);
  }
});
