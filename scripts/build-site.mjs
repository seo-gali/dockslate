import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const production = process.argv.includes('--publish');
if (process.argv.slice(2).some(arg => arg !== '--publish')) throw Error('Use build:site with no arguments or --publish.');
const release = JSON.parse(fs.readFileSync(path.join(root, 'site/release.json'), 'utf8'));
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (release.version !== app.version || !/^\d+\.\d+\.\d+$/.test(release.version)) throw Error('Website version must match the application version.');
const siteUrl = 'https://seo-gali.github.io/dockslate/';
const values = { VERSION: release.version, SITE_URL: siteUrl };
let verifiedDownloads = 0;
for (const key of ['installer', 'zip', 'licenses']) {
  const asset = release[key];
  if (!asset || !/^[A-Za-z0-9_.-]+\.(exe|zip)$/.test(asset.file) || !/^[A-F0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw Error(`Invalid release metadata: ${key}`);
  const prefix = key.toUpperCase();
  values[`${prefix}_URL`] = './downloads/' + encodeURIComponent(asset.file);
  values[`${prefix}_SIZE`] = (asset.bytes / 1000000).toFixed(1) + ' MB';
  values[`${prefix}_SHA256`] = asset.sha256;
  const source = path.join(root, 'downloads', asset.file);
  if (!fs.existsSync(source)) throw Error(`Missing download: ${asset.file}`);
  const input = fs.createReadStream(source);
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > asset.bytes) throw Error(`Download is larger than its verified receipt: ${asset.file}`);
    hash.update(chunk);
  }
  if (bytes !== asset.bytes || hash.digest('hex').toUpperCase() !== asset.sha256) throw Error(`Download differs from its verified size or SHA-256: ${asset.file}`);
  verifiedDownloads++;
}
if (!fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes(release.licenses.file)) throw Error('Notices must link to the current license/source archive.');
let html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
for (const [key, value] of Object.entries(values)) html = html.replaceAll(`{{${key}}}`, value);
if (/\{\{[A-Z0-9_]+\}\}/.test(html)) throw Error('An unresolved website placeholder remains.');
const pages = new Map([
  ['index.html', html],
  ['guide.html', fs.readFileSync(path.join(root, 'guide.html'), 'utf8')],
  ['404.html', fs.readFileSync(path.join(root, 'site/404.html'), 'utf8').replaceAll('{{SITE_URL}}', siteUrl)],
]);
for (const [file, content] of pages) {
  if ((content.match(/<meta\b[^>]*>/gi) ?? []).some(tag => /\bname\s*=\s*["'](?:robots|googlebot)["']/i.test(tag) && /\bnoindex\b/i.test(tag))) throw Error(`Public page blocks indexing: ${file}`);
  if (/<meta\b[^>]*http-equiv\s*=\s*["']refresh["']/i.test(content)) throw Error(`Public page contains a redirect: ${file}`);
  if (file !== '404.html' && !content.includes(`<link rel="canonical" href="${new URL(file === 'index.html' ? '' : file, siteUrl)}">`)) throw Error(`Missing or incorrect canonical URL: ${file}`);
}
const sitemapUrls = [...pages.keys()].filter(file => file !== '404.html').map(file => new URL(file === 'index.html' ? '' : file, siteUrl).href);
const metadata = new Map([
  ['sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map(url => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`],
  ['robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`],
]);
const output = production ? root : path.join(root, 'site-dist');
if (!output.startsWith(root) || (fs.existsSync(output) && fs.realpathSync(output).toLowerCase() !== output.toLowerCase())) throw Error('Refusing to replace a website output outside the workspace.');
if (!production) fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const [file, content] of [...pages, ...metadata]) fs.writeFileSync(path.join(output, file), content);
if (!production) {
  for (const file of ['styles.css', 'main.js', 'icon.svg']) fs.copyFileSync(path.join(root, 'site', file), path.join(output, file));
  fs.copyFileSync(path.join(root, 'google474f5421d7424578.html'), path.join(output, 'google474f5421d7424578.html'));
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
if (production) {
  let homepage = html;
  for (const file of ['styles.css', 'main.js', 'icon.svg']) homepage = homepage.replaceAll(`./${file}`, `./site/${file}`);
  fs.writeFileSync(path.join(root, 'index.html'), homepage);
  fs.writeFileSync(path.join(root, '.nojekyll'), '');
}
fs.mkdirSync(path.join(output, 'downloads'), { recursive: true });
const notices = 'THIRD_PARTY_NOTICES.md';
fs.copyFileSync(path.join(root, notices), path.join(output, 'downloads', notices));
for (const key of production ? [] : ['installer', 'zip', 'licenses']) {
  const file = release[key].file;
  fs.copyFileSync(path.join(root, 'downloads', file), path.join(output, 'downloads', file));
}
console.log(JSON.stringify({ output, version: release.version, mode: production ? 'static-pages' : 'local-preview', verifiedDownloads, sitemapUrls, deployed: false }));
