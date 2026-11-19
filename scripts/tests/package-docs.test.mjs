import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyPackageDocs } from '../package-docs.mjs';

test('EXE and ZIP share a small document list with working local or online links', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dockslate-docs-check-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const destination = path.join(temporary, 'docs');
  const files = copyPackageDocs(root, destination);
  assert.deepEqual(files, JSON.parse(fs.readFileSync(path.join(root, 'scripts/package-docs.json'))));
  for (const file of files) {
    const output = path.join(destination, file);
    for (const [, link] of fs.readFileSync(output, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(link)) continue;
      const target = path.resolve(path.dirname(output), decodeURIComponent(link.split('#')[0]));
      const relative = path.relative(temporary, target).replaceAll(path.sep, '/');
      assert.ok(fs.existsSync(target) || /^(?:examples|licenses)\//.test(relative), `${file}: ${link}`);
    }
  }
  assert.throws(() => copyPackageDocs(root, destination), /EEXIST/);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.installer.conf.json')));
  assert.equal(config.bundle.resources['target/installer-resources/docs/'], 'docs/');
  assert.equal(Object.keys(config.bundle.resources).some(key => key.startsWith('../docs/')), false);
});

test('document traversal is rejected before the output directory is created', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dockslate-docs-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/package-docs.json'), '["../outside.md"]');
  assert.throws(() => copyPackageDocs(root, path.join(root, 'output')), /manifest/);
  assert.equal(fs.existsSync(path.join(root, 'output')), false);
});
