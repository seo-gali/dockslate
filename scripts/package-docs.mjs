import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyPackageDocs(root, destination) {
  const files = JSON.parse(fs.readFileSync(path.join(root, 'scripts/package-docs.json'), 'utf8'));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length || files.some(file => typeof file !== 'string' || !/^(?:[\w-]+\/)*[\w.-]+\.md$/.test(file))) throw Error('Invalid package document manifest');
  const included = new Set(files.map(file => path.resolve(root, 'docs', file)));
  const sources = files.map(file => {
    const source = path.resolve(root, 'docs', file);
    if (!fs.lstatSync(source).isFile()) throw Error(`Package document must be a regular file: ${file}`);
    const text = fs.readFileSync(source, 'utf8').replace(/\]\(([^)]+)\)/g, (match, link) => {
      if (/^(?:[a-z]+:|#)/i.test(link)) return match;
      const [relative, fragment] = link.split('#');
      const target = path.resolve(path.dirname(source), decodeURIComponent(relative));
      if (included.has(target) || !path.relative(root, target).startsWith('..') && ['examples', 'licenses'].includes(path.relative(root, target).split(path.sep)[0])) return match;
      const repositoryPath = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
      if (repositoryPath.startsWith('..')) throw Error(`Package link leaves the repository: ${link}`);
      return `](https://github.com/seo-gali/dockslate/blob/main/${repositoryPath}${fragment ? '#' + fragment : ''})`;
    });
    return { file, text };
  });
  // The caller supplies a fresh directory; stale documents must never enter a package.
  fs.mkdirSync(destination);
  for (const { file, text } of sources) {
    const output = path.join(destination, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, text, { flag: 'wx' });
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!process.argv[2]) throw Error('Provide a fresh package docs directory');
  console.log(JSON.stringify({ documents: copyPackageDocs(root, path.resolve(process.argv[2])) }));
}
