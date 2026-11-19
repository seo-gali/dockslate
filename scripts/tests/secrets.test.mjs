import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSecrets } from '../check-secrets.mjs';
test('secret patterns detect credentials without returning their values', () => {
  for (const [line, rule] of [
    ['gh'+'p_'+'a'.repeat(36),'github-token'],
    ['AK'+'IA'+'A'.repeat(16),'aws-access-key'],
    ['sk_'+'live_'+'a'.repeat(24),'stripe-secret'],
    ['postgres'+'://user:password@host/db','credential-url'],
    ['-----BEGIN '+'PRIVATE KEY-----','private-key'],
    ['api_key = "'+'some-secret-value'+'"','literal-secret'],
    ['password = "'+'a secret with spaces'+'"','literal-secret'],
  ]) assert.ok(detectSecrets(line).includes(rule));
  assert.deepEqual(detectSecrets('const apiKey = process.env.API_KEY'),[]);
  assert.deepEqual(detectSecrets('password: "${readFromEnvironment}"'),[]);
  assert.deepEqual(detectSecrets('sha256: "'+'A'.repeat(64)+'"'),[]);
});
