import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--publish');
if (process.argv.slice(2).some(arg => arg !== '--publish')) throw Error('Use build:site with no arguments or --publish.');
const release = JSON.parse(fs.readFileSync(path.join(root, 'site/release.json'), 'utf8'));
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (release.version !== app.version || !/^\d+\.\d+\.\d+$/.test(release.version)) throw Error('Website version must match the application version.');
const releaseBase = `https://github.com/seo-gali/dockslate/releases/download/v${release.version}/`;
const values = { VERSION: release.version };
const checksums = [];
const unavailable = new Set();
for (const key of ['installer', 'zip']) {
  const asset = release[key];
  if (!asset || !/^[A-Za-z0-9_.-]+\.(exe|zip)$/.test(asset.file) || !/^[A-F0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw Error(`Invalid release metadata: ${key}`);
  const url = releaseBase + encodeURIComponent(asset.file);
  const prefix = key.toUpperCase();
  values[`${prefix}_URL`] = production ? url : './downloads/' + encodeURIComponent(asset.file);
  values[`${prefix}_SIZE`] = (asset.bytes / 1000000).toFixed(1) + ' MB';
  values[`${prefix}_SHA256`] = asset.sha256;
  let input;
  if (production) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (response.status === 404) { unavailable.add(key); continue; }
    if (!response.ok) throw Error(`Public release asset check failed (${response.status}): ${url}`);
    input = response.body;
  } else {
    const source = path.join(root, 'downloads', asset.file);
    if (!fs.existsSync(source)) throw Error(`Missing local download: ${asset.file}`);
    input = fs.createReadStream(source);
  }
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > asset.bytes) throw Error(`Download is larger than its verified receipt: ${asset.file}`);
    hash.update(chunk);
  }
  if (bytes !== asset.bytes || hash.digest('hex').toUpperCase() !== asset.sha256) throw Error(`Download differs from its verified size or SHA-256: ${asset.file}`);
  checksums.push(`${asset.sha256}  ${asset.file}`);
}
let html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
for (const [key, value] of Object.entries(values)) html = html.replaceAll(`{{${key}}}`, value);
for (const key of unavailable) {
  const button = new RegExp(`<a class="button (primary|secondary) download-button" data-download="${key}"[^>]*>.*?</a>`);
  if (!button.test(html)) throw Error(`Missing download button: ${key}`);
  html = html.replace(button, `<button class="button secondary download-button" type="button" data-download="${key}" disabled>공개 파일 준비 중</button>`);
}
if (/\{\{[A-Z0-9_]+\}\}/.test(html)) throw Error('An unresolved website placeholder remains.');
const output = path.join(root, production ? 'docs' : 'site-dist');
if (!output.startsWith(root) || (fs.existsSync(output) && fs.realpathSync(output).toLowerCase() !== output.toLowerCase())) throw Error('Refusing to replace a website output outside the workspace.');
if (!production) fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
for (const file of ['styles.css', 'main.js', 'icon.svg']) fs.copyFileSync(path.join(root, 'site', file), path.join(output, file));
for (const file of ['guide.html', 'google474f5421d7424578.html']) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
if (!production) {
  fs.mkdirSync(path.join(output, 'downloads'));
  for (const key of ['installer', 'zip']) {
    const file = release[key].file;
    fs.copyFileSync(path.join(root, 'downloads', file), path.join(output, 'downloads', file));
  }
}
console.log(JSON.stringify({ output, version: release.version, mode: production ? 'static-pages' : 'local-preview', verifiedDownloads: checksums.length, unavailableDownloads: [...unavailable], deployed: false }));
