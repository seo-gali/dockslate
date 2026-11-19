import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const patterns = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['stripe-secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,255}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['credential-url', /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/@]+:[^\s/@]{3,}@/i],
  ['literal-secret', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*['"]?\s*[:=]\s*['"]([^'"\r\n]{8,})['"]/i],
];
export function detectSecrets(line) {
  return patterns.flatMap(([rule, expression]) => {
    const match = expression.exec(line);
    if (!match) return [];
    if (rule === 'literal-secret' && /^(?:\$|<|\{|process\.|env\.|example|placeholder|changeme)/i.test(match[1])) return [];
    return [rule];
  });
}
const firstParty = file => !/^(?:licenses|downloads|docs\/downloads|node_modules|\.tools|\.analysis|src-tauri\/target)\//.test(file) && !/(?:^|\/)(?:\.git|\.aws|\.codex|\.agents)(?:\/|$)/.test(file);
const textFile = file => /(?:\.(?:rs|tsx?|[cm]?js|json|ya?ml|md|sh|ps1|txt|ini|toml|pem|key|sql|conf|cfg|xml)|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials))$/i.test(file);
export function scanSecrets(root, { history = false, revisions = [] } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const findings = [], seen = new Set();
  const inspect = (line, file, lineNumber, revision) => {
    for (const rule of detectSecrets(line)) {
      const key = [revision,file,lineNumber,rule].join(':');
      if (!seen.has(key)) { seen.add(key); findings.push({file,line:lineNumber,revision,rule,redacted:true}); }
    }
  };
  const files = new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean));
  for (const name of fs.readdirSync(root)) if (/^\.env(?:\..*)?$/.test(name)) files.add(name);
  let checkedFiles = 0, addedHistoryLines = 0;
  for (const file of files) {
    if (!firstParty(file) || !textFile(file)) continue;
    const full = path.join(root,file);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile() || fs.statSync(full).size > 4 * 1024 * 1024) continue;
    checkedFiles++;
    fs.readFileSync(full,'utf8').split('\n').forEach((line,index)=>inspect(line,file,index+1,'working-tree'));
  }
  if (history) {
    for (const revision of revisions) if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Additional history revisions must be full commit SHAs');
    const patch = git(['log','--all',...revisions,'--format=SECURITY_COMMIT:%H','--no-ext-diff','--no-renames','-p','--','.',':(exclude)licenses/**',':(exclude)downloads/**',':(exclude)docs/downloads/**']);
    let revision, file, lineNumber = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('SECURITY_COMMIT:')) revision = line.slice(16);
      else if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('@@ ')) lineNumber = Number(line.match(/\+(\d+)/)?.[1] ?? 0);
      else if (line.startsWith('+') && file && firstParty(file) && textFile(file)) { addedHistoryLines++; inspect(line.slice(1),file,lineNumber++,revision); }
      else if (line.startsWith(' ')) lineNumber++;
    }
  }
  return { checkedFiles, history, addedHistoryLines, rules: patterns.length, findings, valuesPrinted:false, limitations:['Pattern-based first-party text scan; binaries and third-party sources excluded; runtime environment values not read.'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const args = process.argv.slice(2), revisions = args.filter(value=>/^[a-f0-9]{40}$/.test(value));
  const result = scanSecrets(root,{history:args.includes('--history'),revisions});
  console.log(JSON.stringify(result,null,2));
  if (result.findings.length) process.exitCode = 1;
}
