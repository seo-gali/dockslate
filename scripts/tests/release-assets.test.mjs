import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readPublishedRelease, stagePublishedAssets } from '../release-assets.mjs';

const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dockslate-release-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['site', 'docs/results', 'downloads', 'licenses', 'stage']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const asset = (directory, file, body) => {
    fs.writeFileSync(path.join(root, directory, file), body);
    return { file, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex').toUpperCase() };
  };
  const release = { version: '0.1.9', installer: asset('downloads', 'setup.exe', 'inert installer fixture'), zip: asset('downloads', 'portable.zip', 'inert zip fixture'), licenses: asset('downloads', 'licenses.zip', 'inert legal fixture') };
  const sums = asset('downloads', 'SHA256SUMS.txt', ['installer', 'zip', 'licenses'].map(key => release[key].sha256 + '  ' + release[key].file).join('\n') + '\n');
  const notice = asset('licenses', 'THIRD_PARTY_NOTICES.md', 'Source archive: licenses.zip');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']); git(['add', 'downloads', 'licenses']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(root, '.git/empty-hooks'), 'commit', '--quiet', '-m', 'inert fixture']);
  const sourceCommit = git(['rev-parse', 'HEAD']);
  release.notices = { ...notice, sourceCommit };
  const assets = [...['installer', 'zip', 'licenses'].map(key => release[key]), sums];
  const receipt = { published: true, version: release.version, files: assets, github: { tag: 'v0.1.9', sourceCommit, assets: assets.map(({file, ...entry}) => ({ name: file, ...entry })) }, virusTotal: { files: ['installer', 'zip'].map(key => ({ sha256: release[key].sha256, completed: true, detections: 0, totalEngines: 50 })) } };
  const save = () => { json(path.join(root, 'site/release.json'), release); json(path.join(root, 'docs/results/public-distribution-0.1.9.json'), receipt); };
  save();
  return { root, release, receipt, save, stage: path.join(root, 'stage') };
}

test('published assets survive a different development version and missing old local downloads', async t => {
  const f = fixture(t);
  json(path.join(f.root, 'package.json'), { version: '0.1.10' });
  fs.rmSync(path.join(f.root, 'downloads/setup.exe'));
  fs.writeFileSync(path.join(f.root, 'downloads/SHA256SUMS.txt'), 'different development checksums');
  const origins = await stagePublishedAssets(f.root, readPublishedRelease(f.root), f.stage);
  assert.deepEqual(origins, ['git', 'local', 'local', 'git', 'git']);
  assert.equal(fs.existsSync(path.join(f.root, 'downloads/setup.exe')), false);
});

test('unpublished, mismatched, and detected releases are refused', t => {
  const f = fixture(t);
  f.receipt.published = false; f.save(); assert.throws(() => readPublishedRelease(f.root), /already published/);
  f.receipt.published = true; f.receipt.virusTotal.files[0].detections = 1; f.save(); assert.throws(() => readPublishedRelease(f.root), /antivirus/);
  f.receipt.virusTotal.files[0].detections = 0; f.release.installer.bytes++; f.save(); assert.throws(() => readPublishedRelease(f.root), /differs/);
});

test('tampered and oversized local assets fail without falling back to older bytes', async t => {
  const f = fixture(t), published = readPublishedRelease(f.root);
  const file = path.join(f.root, 'downloads/setup.exe');
  fs.writeFileSync(file, 'x'.repeat(f.release.installer.bytes));
  await assert.rejects(stagePublishedAssets(f.root, published, f.stage), /differs/);
  assert.equal(fs.existsSync(path.join(f.stage, 'setup.exe')), false);
  fs.writeFileSync(file, 'x'.repeat(f.release.installer.bytes + 1));
  await assert.rejects(stagePublishedAssets(f.root, published, f.stage), /exceeds/);
  assert.equal(fs.existsSync(path.join(f.stage, 'setup.exe')), false);
});

test('unsafe names and unpinned notices are refused before acquiring assets', t => {
  const f = fixture(t);
  f.release.installer.file = '../setup.exe'; f.save(); assert.throws(() => readPublishedRelease(f.root), /metadata/);
  f.release.installer.file = 'setup.exe'; f.release.notices.sourceCommit = 'main'; f.save(); assert.throws(() => readPublishedRelease(f.root), /source commit/);
});
