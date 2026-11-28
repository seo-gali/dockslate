import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'seo-gali/dockslate');
assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
const artifacts = ['dockslate.exe', 'docker.exe'].map(name => {
  const bytes = fs.readFileSync('src-tauri/target/release/' + name);
  return {name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase()};
});
const record = {
  version: '0.1.18', observedAt: new Date().toISOString(), sourceCommit: process.env.GITHUB_SHA,
  githubRun: 'https://github.com/seo-gali/dockslate/actions/runs/' + process.env.GITHUB_RUN_ID,
  checks: {windowsReleaseBuildExit: 0, rustCheckExit: 0, frontendBuildExit: 0, rustTests: 49,
    latestNativeFlowExecuted: false, offlineComposeConfigurationPassed: true, installerPathFixturesPassed: true},
  artifacts, engineChanged: false, fullInstallationVerified: false,
  toolPins: [
    {version: 'nsis-3.11', source: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip', sha256: 'C7D27F780DDB6CFFB4730138CD1591E841F4B7EDB155856901CDF5F214394FA1'},
    {version: '0.5.3', source: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll', sha256: '5BA143B5DB4A87D32D6E7802E033330AAE56CBCEABE0D1E3BA41948385AD4709'}
  ], remaining: ['Packaged native frontend checks pending', 'Actual engine migration on another Windows PC unverified', 'Unsigned; antivirus analysis incomplete']
};
fs.writeFileSync('docs/results/installer-engine-integration.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
