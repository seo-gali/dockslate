import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublishedRelease, stagePublishedAssets } from './release-assets.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (process.argv.length > 2) throw Error('Use build:site with no arguments; output is always site-dist/.');
const published = readPublishedRelease(root);
const { release } = published;
const siteUrl = 'https://seo-gali.github.io/dockslate/';
const releasesUrl = 'https://github.com/seo-gali/dockslate/releases/';
const assetUrl = releasesUrl + 'download/v' + release.version + '/';
const values = { VERSION: release.version, SITE_URL: siteUrl, RELEASE_URL: releasesUrl + 'tag/v' + release.version };
const flagged = published.receipt.virusTotal.files.filter(scan => scan.detections > 0);
values.SECURITY_NOTE = '미서명 개발 버전';
values.SECURITY_ALERT_CLASS = '';
if (flagged.length) {
  const escape = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  values.SECURITY_NOTE += ' · ' + flagged.map(scan => `${escape(scan.detectionVendors[0])}: ${scan.file === release.zip.file ? '포터블 ZIP' : '앱 EXE'} 탐지 ${scan.detections}건 · <a href="https://www.virustotal.com/gui/file/${scan.sha256.toLowerCase()}/detection">검사 결과</a>`).join(' · ') + ' · 오탐 여부 미확인.';
  values.SECURITY_ALERT_CLASS = 'has-detection';
}
if (published.unverifiedAntivirus) {
  values.SECURITY_NOTE += ' · 백신 검사 미완료';
  values.SECURITY_ALERT_CLASS = 'has-detection';
}
let verifiedDownloads = 0;
for (const key of ['installer', 'zip', 'licenses']) {
  const asset = release[key];
  if (!asset || !/^[A-Za-z0-9_.-]+\.(exe|zip)$/.test(asset.file) || !/^[A-F0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw Error(`Invalid release metadata: ${key}`);
  const prefix = key.toUpperCase();
  values[`${prefix}_URL`] = assetUrl + encodeURIComponent(asset.file);
  if (key !== 'licenses') {
    values[`${prefix}_VIRUSTOTAL_URL`] = published.unverifiedAntivirus
      ? `https://github.com/seo-gali/dockslate/blob/${published.receipt.github.sourceCommit}/docs/results/virustotal-${release.version}.json`
      : 'https://www.virustotal.com/gui/file/' + asset.sha256.toLowerCase() + '/detection';
    values[`${prefix}_SCAN_LABEL`] = published.unverifiedAntivirus ? '백신 검사 미완료 · 진행 기록' : 'VirusTotal 검사 결과';
  }
  values[`${prefix}_SIZE`] = (asset.bytes / 1000000).toFixed(1) + ' MB';
  values[`${prefix}_SHA256`] = asset.sha256;
  verifiedDownloads++;
}
values.CHECKSUMS_URL = assetUrl + 'SHA256SUMS.txt';
let html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
for (const [key, value] of Object.entries(values)) html = html.replaceAll(`{{${key}}}`, value);
if (/\{\{[A-Z0-9_]+\}\}/.test(html)) throw Error('An unresolved website placeholder remains.');
const pages = new Map([
  ['index.html', html],
  ['guide.html', fs.readFileSync(path.join(root, 'site/guide.html'), 'utf8')],
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
fs.mkdirSync(path.join(root, '.analysis'), { recursive: true });
const staging = fs.mkdtempSync(path.join(root, '.analysis/site-build-'));
try {
const assetOrigins = await stagePublishedAssets(root, published, staging);
const output = path.join(root, 'site-dist');
if (!output.startsWith(root) || (fs.existsSync(output) && fs.realpathSync(output).toLowerCase() !== output.toLowerCase())) throw Error('Refusing to replace a website output outside the workspace.');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const [file, content] of [...pages, ...metadata]) fs.writeFileSync(path.join(output, file), content);
for (const file of ['styles.css', 'main.js', 'icon.svg', 'google474f5421d7424578.html']) fs.copyFileSync(path.join(root, 'site', file), path.join(output, file));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
fs.mkdirSync(path.join(output, 'downloads'), { recursive: true });
const notices = 'THIRD_PARTY_NOTICES.md';
fs.copyFileSync(path.join(staging, notices), path.join(output, 'downloads', notices));
for (const key of ['installer', 'zip', 'licenses']) {
  const file = release[key].file;
  fs.copyFileSync(path.join(staging, file), path.join(output, 'downloads', file));
}
fs.copyFileSync(path.join(staging, 'SHA256SUMS.txt'), path.join(output, 'downloads/SHA256SUMS.txt'));
const legacyDownloads = path.join(root, 'docs/downloads');
fs.mkdirSync(path.join(output, 'docs/downloads'), { recursive: true });
fs.copyFileSync(path.join(legacyDownloads, notices), path.join(output, 'docs/downloads', notices));
const legacyLicenses = fs.readdirSync(legacyDownloads).filter(file => /^DockSlate-\d+\.\d+\.\d+-third-party-licenses\.zip$/.test(file));
for (const file of legacyLicenses) {
  for (const folder of ['downloads', 'docs/downloads']) fs.copyFileSync(path.join(legacyDownloads, file), path.join(output, folder, file));
}
console.log(JSON.stringify({ output, version: release.version, verifiedDownloads, legacyLicenseArchives: legacyLicenses.length, sitemapUrls, assetOrigins, deployed: false }));

} finally { fs.rmSync(staging, { recursive: true, force: true }); }
