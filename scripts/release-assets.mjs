import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const requireFact = (value, message) => { if (!value) throw Error(message); };
const validFile = file => /^[A-Za-z0-9_.-]+\.(exe|zip|txt|md)$/.test(file);
const validAsset = asset => asset && validFile(asset.file) && /^[A-F0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 512 * 1024 * 1024;

export function approvedUnverifiedPublication(version, scans, prerelease) {
  const approval = scans?.unverifiedPublicationApproval;
  const names = [`DockSlate_${version}_x64-setup.exe`, `DockSlate-${version}-windows-x64.zip`, 'DockSlate.exe', 'bin/docker.exe'];
  return ['0.1.16', '0.1.17', '0.1.18'].includes(version) && prerelease === true && scans?.status === 'blocked' &&
    approval?.userApproved === true && approval.version === version && approval.files?.length === names.length && scans.files?.length === names.length &&
    names.every(file => {
      const matches = scans.files.filter(scan => scan.file === file);
      const approvals = approval.files.filter(scan => scan.file === file);
      const scan = matches[0], approved = approvals[0];
      return matches.length === 1 && approvals.length === 1 && validAsset({ ...scan, file: path.basename(file) }) &&
        scan.completed === false && scan.detections === null && scan.totalEngines === null &&
        approved.sha256 === scan.sha256 && approved.bytes === scan.bytes;
    });
}

export function readPublishedRelease(root) {
  const release = read(path.join(root, 'site/release.json'));
  requireFact(/^\d+\.\d+\.\d+$/.test(release.version), 'Invalid public release version.');
  const receipt = read(path.join(root, `docs/results/public-distribution-${release.version}.json`));
  requireFact(receipt.published === true && receipt.version === release.version && receipt.github?.tag === `v${release.version}`, 'Only an already published release may be used by the website.');
  const unverifiedAntivirus = approvedUnverifiedPublication(release.version, receipt.virusTotal, receipt.github.prerelease);
  const approvals = [...(receipt.virusTotal?.publicationApprovals ?? []), ...(receipt.virusTotal?.publicationApproval ? [receipt.virusTotal.publicationApproval] : [])];
  const approvedDetection = scan => scan && (scan.file === 'DockSlate.exe' || (scan.file === release.zip.file && scan.sha256 === release.zip.sha256)) &&
    scan.completed === true && scan.totalEngines > 0 && receipt.github.prerelease === true &&
    approvals.some(approval => approval?.userApproved === true && /^[A-F0-9]{64}$/.test(approval.sha256) &&
      approval.sha256 === scan.sha256?.toUpperCase() && approval.detections === scan.detections &&
      scan.detectionVendors?.length === 1 && approval.vendor === scan.detectionVendors[0]);
  for (const key of ['installer', 'zip', 'licenses']) {
    const asset = release[key];
    requireFact(validAsset(asset), `Invalid release metadata: ${key}`);
    for (const records of [receipt.files, receipt.github.assets]) {
      const recorded = records?.find(entry => (entry.file ?? entry.name) === asset.file);
      requireFact(recorded && recorded.bytes === asset.bytes && recorded.sha256 === asset.sha256, `Release asset differs from its published receipt: ${key}`);
    }
    if (key !== 'licenses') {
      const scan = receipt.virusTotal?.files?.find(entry => entry.sha256?.toUpperCase() === asset.sha256);
      requireFact((unverifiedAntivirus && scan?.file === asset.file && scan.bytes === asset.bytes) || (scan?.completed === true && scan.totalEngines > 0 && (scan.detections === 0 || (key === 'zip' && approvedDetection(scan)))), `Unresolved antivirus result: ${key}`);
    }
  }
  for (const scan of receipt.virusTotal.files) {
    if (unverifiedAntivirus) continue;
    requireFact(Number.isSafeInteger(scan.detections) && scan.detections >= 0, 'Invalid antivirus detection count.');
    if (scan.detections === 0) continue;
    requireFact(approvedDetection(scan), 'Unresolved antivirus result requires explicit approval for this exact file hash.');
  }
  const sums = receipt.github.assets.find(entry => entry.name === 'SHA256SUMS.txt');
  requireFact(validAsset({ ...sums, file: sums?.name }), 'Published checksum receipt is missing.');
  const checksumSourcePath = receipt.github.checksumSourcePath ?? 'downloads/SHA256SUMS.txt';
  requireFact(checksumSourcePath === 'downloads/SHA256SUMS.txt' || /^\.github\/release[0-9]+-SHA256SUMS\.txt$/.test(checksumSourcePath), 'Invalid published checksum source path.');
  requireFact(validAsset(release.notices) && release.notices.file === 'THIRD_PARTY_NOTICES.md' && /^[a-f0-9]{40}$/.test(release.notices.sourceCommit) && release.notices.sourceCommit === receipt.github.sourceCommit, 'Published notices must identify the reviewed source commit.');
  return { release, receipt, unverifiedAntivirus, sums: { ...sums, file: sums.name, sourcePath: checksumSourcePath } };
}

async function writeVerified(source, asset, destination) {
  let bytes = 0;
  const hash = createHash('sha256');
  const handle = fs.openSync(destination, 'wx');
  try {
    for await (const data of source) {
      const chunk = Buffer.from(data);
      bytes += chunk.length;
      requireFact(bytes <= asset.bytes, `Asset exceeds its receipt: ${asset.file}`);
      hash.update(chunk);
      fs.writeSync(handle, chunk);
    }
    requireFact(bytes === asset.bytes && hash.digest('hex').toUpperCase() === asset.sha256, `Asset differs from its receipt: ${asset.file}`);
  } catch (error) {
    fs.closeSync(handle); fs.rmSync(destination, { force: true }); throw error;
  }
  fs.closeSync(handle);
}

async function fromGit(root, object, asset, destination) {
  const child = spawn('git', ['cat-file', 'blob', object], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const completed = new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('exit', resolve); });
  let failure;
  try { await writeVerified(child.stdout, asset, destination); } catch (error) { failure = error; }
  const code = await completed;
  if (code !== 0) { fs.rmSync(destination, { force: true }); return false; }
  if (failure) throw failure;
  return true;
}

async function acquire(root, asset, candidate, object, url, destination) {
  if (candidate && fs.existsSync(candidate)) {
    requireFact(fs.lstatSync(candidate).isFile(), `Asset must be a regular file: ${candidate}`);
    await writeVerified(fs.createReadStream(candidate), asset, destination); return 'local';
  }
  if (await fromGit(root, object, asset, destination)) return 'git';
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  requireFact(response.ok && response.body, `Published asset download failed: ${asset.file} (${response.status})`);
  await writeVerified(response.body, asset, destination);
  return 'published-release';
}

export async function stagePublishedAssets(root, published, destination) {
  const { release, sums } = published;
  const source = release.notices.sourceCommit;
  const base = `https://github.com/seo-gali/dockslate/releases/download/v${release.version}/`;
  const origins = [];
  for (const asset of [...['installer', 'zip', 'licenses'].map(key => release[key]), sums]) {
    const candidate = asset.file === 'SHA256SUMS.txt' ? null : path.join(root, 'downloads', asset.file);
    const sourcePath = asset.file === 'SHA256SUMS.txt' ? sums.sourcePath : `downloads/${asset.file}`;
    origins.push(await acquire(root, asset, candidate, `${source}:${sourcePath}`, base + asset.file, path.join(destination, asset.file)));
  }
  const expected = ['installer', 'zip', 'licenses'].map(key => release[key].sha256 + '  ' + release[key].file).join('\n') + '\n';
  requireFact(fs.readFileSync(path.join(destination, sums.file), 'utf8').replaceAll('\r\n', '\n') === expected, 'Published checksums differ from public release metadata.');
  const notice = release.notices;
  origins.push(await acquire(root, notice, null, `${source}:licenses/${notice.file}`, `https://raw.githubusercontent.com/seo-gali/dockslate/${source}/licenses/${notice.file}`, path.join(destination, notice.file)));
  requireFact(fs.readFileSync(path.join(destination, notice.file), 'utf8').includes(release.licenses.file), 'Published notices point to a different source archive.');
  return origins;
}
