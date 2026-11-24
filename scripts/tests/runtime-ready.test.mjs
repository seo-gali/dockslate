import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/sh';
const ready = fs.readFileSync(new URL('../../src-tauri/scripts/runtime-ready.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function run({ failures = 0, pid1 = 'systemd', uid = 0, schema = 1, timeout = false } = {}) {
  const script = `
id() { printf '%s\\n' '${uid}'; }
cat() { case "$1" in /etc/dockslate/schema) printf '%s\\n' '${schema}';; /proc/1/comm) printf '%s\\n' '${pid1}';; *) return 99;; esac; }
attempts=0
clock=0
date() { printf '%s\\n' "$clock"; }
systemctl() {
    [ "$*" = '--system show --property=Version --value' ] || return 99
    attempts=$((attempts + 1))
    [ "$attempts" -gt '${failures}' ]
}
timeout() { [ "$1" -ge 1 ] && [ "$1" -le 2 ] || return 99; shift; ${timeout ? 'return 124' : '"$@"'}; }
sleep() { [ "$1" = 1 ] || return 99; clock=$((clock + 1)); }
${ready}
printf 'services-ready:%s\\n' "$attempts"
`;
  return spawnSync(shell, ['-s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

test('runtime readiness accepts a reachable manager, including after delayed boot', { skip: !fs.existsSync(shell) }, () => {
  for (const failures of [0, 3, 29]) {
    const result = run({ failures });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `services-ready:${failures + 1}`);
  }
});

test('runtime readiness blocks missing or hung systemd and invalid ownership', { skip: !fs.existsSync(shell) }, () => {
  for (const options of [{ failures: 30 }, { pid1: 'init' }, { timeout: true }, { uid: 1000 }, { schema: 2 }]) {
    const result = run(options);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /did not become reachable|requires root|schema could not be verified/);
  }
});
