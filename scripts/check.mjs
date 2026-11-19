import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = fs.readdirSync(new URL('./tests/', import.meta.url)).filter(file => file.endsWith('.test.mjs')).map(file => 'scripts/tests/' + file);
for (const args of [
  ['scripts/check-workflow-pins.mjs'],
  ['scripts/check-ipc.mjs'],
  ['scripts/check-secrets.mjs'],
  ['scripts/check-docs.mjs'],
  ['node_modules/typescript/bin/tsc', '--noEmit', '--noUnusedLocals', '--noUnusedParameters'],
  ['--test', ...tests],
]) {
  console.log('> node ' + args.join(' '));
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
