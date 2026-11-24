import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanComments, compareBaseline, inCommentScope } from '../comment-policy.mjs';

const bodies = (file, source) => scanComments(file, source).map(comment => comment.text);

test('JS syntax separates comments from URLs, regex, JSX and template data', () => {
  const source = 'const url = "https://host/#x"; const re = /[/*]+/;\n' +
    'const t = `// data ${1 /* expression */}`;\n' +
    'const view = <span>https://host/*text*/{1 /* JSX expression */}</span>;\n' +
    'try {} catch { /* empty catch */ }\n// final\n';
  assert.deepEqual(bodies('sample.tsx', source), ['/* expression */', '/* JSX expression */', '/* empty catch */', '// final']);
});

test('Rust raw strings, characters and lifetimes do not hide real nested comments', () => {
  const source = 'fn f<\'a>(x: &\'a str) { let s = br##"// data /* data */"##; let c = \'/\'; /* outer /* inner */ done */ } // real';
  assert.deepEqual(bodies('sample.rs', source), ['/* outer /* inner */ done */', '// real']);
});

test('PowerShell SQL quoting, here strings and interpolation are distinguished', () => {
  const source = '$q = \'SELECT `Name` FROM `Table` WHERE `Name` LIKE \'\'#%\'\'\'; # real\n' +
    '$data = @\'\n# data\n\'@\n' + '$expanded = "x $(1 <# expression #>) # data"\n' +
    '$single = \'`\'; # after single backtick\n<# outer <# nested #> done #>';
  assert.deepEqual(bodies('sample.ps1', source), ['# real', '<# expression #>', '# after single backtick', '<# outer <# nested #> done #>']);
});

test('shell heredoc is data and entrypoint shebang remains visible', () => {
  assert.deepEqual(bodies('sample.sh', '#!/bin/sh\ncat <<\'EOF\'\n#!/bin/sh\n# data\nEOF\necho "# data" # real\n'), ['#!/bin/sh', '# real']);
});

test('HTML scans embedded script and CSS without interpreting attributes or URLs', () => {
  const source = '<div title="<!-- data -->"></div><!-- real --><script>const x="// data"; /* js */</script>' +
    '<style>.a{background:url(https://host/x)} /* css */</style>';
  assert.deepEqual(bodies('sample.html', source), ['<!-- real -->', '/* js */', '/* css */']);
});

test('config strings and YAML block scalars are data', () => {
  assert.deepEqual(bodies('sample.yml', 'key: "# data" # real\nrun: |\n  echo "# data"\n  # script data\nother: 1 # final'), ['# real', '# final']);
  assert.deepEqual(bodies('sample.toml', 'value = "# data" # real'), ['# real']);
});

test('TOML multiline strings and adjacent hash comments remain distinct', () => {
  assert.deepEqual(bodies('sample.toml', 'value = """\n# data\n"""\ncount=42# real'), ['# real']);
});

test('NSIS and Python quotes keep comment characters as data', () => {
  assert.deepEqual(bodies('sample.nsh', 'DetailPrint "# data; $\\"quoted$\\"" ; real'), ['; real']);
  assert.deepEqual(bodies('sample.py', 'value = """# data\nmore"""\nprint("# data") # real'), ['# real']);
});

test('ratchet permits deletion but rejects addition, replacement, duplication and relocation', () => {
  const original = scanComments('check.ts', '// @ts-expect-error\nfail();');
  const baseline = { entries: original.map(comment => ({ id: comment.id, count: 1 })) };
  assert.deepEqual(compareBaseline(original, baseline), { added: [], removed: 0 });
  assert.deepEqual(compareBaseline([], baseline), { added: [], removed: 1 });
  for (const source of ['// new\nfail();', '// @ts-expect-error\nother();', '// @ts-expect-error\nfail();\n// @ts-expect-error\nfail();']) {
    assert.equal(compareBaseline(scanComments('check.ts', source), baseline).added.length, 1);
  }
  assert.equal(compareBaseline(scanComments('other.ts', '// @ts-expect-error\nfail();'), baseline).added.length, 1);
});

test('scope preserves legal documents and generated artifacts through Git exclusions', () => {
  for (const file of ['src/main.tsx', 'src-tauri/src/main.rs', '.github/workflows/check.yml', 'site/index.html', 'examples/node/Dockerfile']) assert.equal(inCommentScope(file), true);
  for (const file of ['docs/results/old.html', 'licenses/source/main.rs', 'downloads/app/main.js', 'README.md', 'package-lock.json']) assert.equal(inCommentScope(file), false);
});

test('CLI ratchet shrinks its baseline and refuses to bless additions', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = fs.mkdtempSync(path.join(root, '.analysis/comment-cli-test-'));
  const run = args => spawnSync(process.execPath, [path.join(directory, 'scripts/check-comments.mjs'), ...args], { cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true });
  try {
    const initialized = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet'], { cwd: directory, windowsHide: true });
    assert.equal(initialized.status, 0);
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'docs/adr'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'docs/adr/test.md'), '# Decision\n');
    for (const file of ['comment-policy.mjs', 'check-comments.mjs']) fs.copyFileSync(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
    const source = '// first\na();\n// second\nb();\n';
    const comments = scanComments('sample.mjs', source);
    const baseline = { version: 1, entries: comments.map(c => ({ id: c.id, file: c.file, count: 1, reason: 'Existing fixture', adr: 'docs/adr/test.md' })) };
    const baselineFile = path.join(directory, 'scripts/comment-baseline.json');
    const baselineText = JSON.stringify(baseline);
    fs.writeFileSync(baselineFile, baselineText);
    fs.writeFileSync(path.join(directory, 'sample.mjs'), source + '// added\nc();\n');
    const rejected = run(['--ratchet']);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(fs.readFileSync(baselineFile, 'utf8'), baselineText);
    fs.writeFileSync(path.join(directory, 'sample.mjs'), '// second\nb();\n');
    const accepted = run([]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const tightened = run(['--ratchet']);
    assert.equal(tightened.status, 0, tightened.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).entries.map(e => e.id), [comments[1].id]);
    fs.writeFileSync(path.join(directory, 'sample.mjs'), source);
    assert.equal(run([]).status, 1);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(path.join(root, '.analysis')));
    const plainTree = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) plainTree(path.join(folder, entry.name)); } };
    plainTree(directory);
    fs.rmSync(directory, { recursive: true });
  }
});
