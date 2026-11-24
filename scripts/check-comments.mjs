import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentFiles, scanComments, compareBaseline } from './comment-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--inventory', '--ratchet'].includes(arg)) || args.length > 1) {
  throw new Error('Usage: node scripts/check-comments.mjs [--inventory|--ratchet]');
}
const files = commentFiles(root);
const comments = files.flatMap(file => scanComments(file, fs.readFileSync(path.join(root, file), 'utf8')));
if (args.includes('--inventory')) {
  console.log(JSON.stringify({ files: files.length, comments }, null, 2));
} else {
  const baselineFile = path.join(root, 'scripts/comment-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const seen = new Set();
  if (baseline.version !== 1 || !Array.isArray(baseline.entries)) throw new Error('Invalid comment baseline.');
  for (const entry of baseline.entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.id) || seen.has(entry.id) || !Number.isInteger(entry.count) || entry.count < 1 ||
        typeof entry.reason !== 'string' || !entry.reason.trim() || typeof entry.file !== 'string' ||
        !/^docs\/adr\/[\w-]+\.md$/.test(entry.adr) || !fs.existsSync(path.join(root, entry.adr))) {
      throw new Error('Invalid comment baseline entry.');
    }
    seen.add(entry.id);
  }
  const result = compareBaseline(comments, baseline);
  if (result.added.length) {
    for (const comment of result.added) console.error(`${comment.file}:${comment.line}:${comment.column}: new or changed comment`);
    console.error(`${result.added.length} comment(s) exceed the ratchet. Move decisions to docs/adr/.`);
    process.exitCode = 1;
  } else {
    if (args.includes('--ratchet')) {
      const counts = new Map();
      for (const comment of comments) counts.set(comment.id, (counts.get(comment.id) ?? 0) + 1);
      baseline.entries = baseline.entries.filter(entry => counts.has(entry.id)).map(entry => ({ ...entry, count: counts.get(entry.id) }));
      fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    }
    console.log(`Comment policy: ${files.length} files, ${comments.length} existing directives/comments, ${result.removed} removed, no additions.`);
  }
}
