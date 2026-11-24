import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const input = JSON.parse(fs.readFileSync('.github/comment-review-issue.json', 'utf8'));
const marker = '<!-- dockslate-comment-review-tray-probe-20261124 -->';
const digest = text => createHash('sha256').update(text).digest('hex');
assert.equal(input.repository, 'seo-gali/dockslate');
assert.equal(digest(input.body), input.sha256);
assert(input.body.endsWith(marker) && input.title.length > 0 && input.title.length < 256);
if (process.argv.includes('--check-only')) {
  console.log(JSON.stringify({ inputVerified: true, sha256: input.sha256, networkUsed: false }));
} else {
  assert.equal(process.env.GITHUB_REPOSITORY, input.repository);
  assert(process.env.GH_TOKEN);
  async function request(method, suffix, data) {
    const response = await fetch('https://api.github.com/repos/' + input.repository + suffix, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GH_TOKEN, 'X-GitHub-Api-Version': '2022-11-28' },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}; no automatic write retry`);
    return response.json();
  }
  const matches = [];
  for (let page = 1; ; page++) {
    assert(page <= 10, 'Too many issues; stop instead of risking a duplicate');
    const issues = await request('GET', `/issues?state=all&per_page=100&page=${page}`);
    matches.push(...issues.filter(issue => !issue.pull_request && issue.body?.includes(marker)));
    if (issues.length < 100) break;
  }
  assert(matches.length <= 1, 'Ambiguous existing issues');
  if (matches.length) assert.equal(digest(matches[0].body), input.sha256, 'Existing issue differs; do not overwrite');
  const issue = matches[0] ?? await request('POST', '/issues', { title: input.title, body: input.body });
  assert.equal(digest(issue.body), input.sha256);
  const result = { number: issue.number, url: issue.html_url, created: !matches.length, sha256: input.sha256 };
  console.log(JSON.stringify(result));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Issue: [#${issue.number}](${issue.html_url})\n\nBody SHA-256: ${input.sha256}\n`);
}
