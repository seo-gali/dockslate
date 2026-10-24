import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const directory = path.join(root, 'licenses');
const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireFact = (value, message) => { if (!value) throw Error(message); };
const contained = (base, relative) => {
  const file = fs.realpathSync(path.resolve(base, relative));
  requireFact(file.startsWith(base + path.sep), 'License path escapes its directory: ' + relative);
  return file;
};
requireFact(inventory.schema === 1, 'Unsupported license inventory.');
requireFact(inventory.components.length > 0 && inventory.texts.length > 0 && inventory.sources.length > 0 && inventory.nativeFiles.length === 3, 'Incomplete license inventory.');
for (const input of inventory.inputs) {
  let bytes = fs.readFileSync(contained(root, input.file));
  if (input.normalization === 'LF') bytes = bytes.toString('utf8').replaceAll('\r\n', '\n');
  requireFact(hash(bytes) === input.sha256, 'Dependencies changed; review license inventory: ' + input.file);
}
const documents = new Map();
for (const entry of [...inventory.texts, ...inventory.sources]) {
  const bytes = fs.readFileSync(contained(directory, entry.file));
  requireFact(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'Missing or changed license/source file: ' + entry.file);
  requireFact(!documents.has(entry.file), 'Duplicate license/source record: ' + entry.file);
  documents.set(entry.file, entry);
}
for (const component of inventory.components) {
  requireFact(component.texts.length > 0, 'Component has no notices: ' + component.name);
  requireFact(!component.licenseFamilies?.includes('manual review required'), 'Unreviewed license: ' + component.name);
  for (const text of component.texts) requireFact(documents.get(text.file)?.sha256 === text.sha256, 'Unlinked notice: ' + component.name);
  const needsSource = component.license?.includes('MPL-2.0') || component.license?.includes('CPL-1.0') || component.licenseFamilies?.includes('MPL-2.0');
  if (needsSource) requireFact(component.source && documents.has(component.source), 'Required source missing: ' + component.name);
}
const modules = new Set(inventory.components.filter(c => c.ecosystem === 'go').map(c => c.name + '@' + c.version));
for (const entry of inventory.vendorManifests) {
  const bytes = fs.readFileSync(contained(directory, entry.file));
  requireFact(hash(bytes) === entry.sha256, 'Vendor inventory changed: ' + entry.file);
  const declarations = [...bytes.toString('utf8').matchAll(/^# (\S+) (v\S+)/gm)];
  requireFact(declarations.length > 0, 'Empty vendor inventory: ' + entry.file);
  for (const [, name, version] of declarations) requireFact(modules.has(name + '@' + version), 'Vendored Go dependency has no notices: ' + name + '@' + version);
}
const binaries = [];
for (const entry of inventory.nativeFiles) {
  const bytes = fs.readFileSync(contained(root, entry.file));
  requireFact(hash(bytes) === entry.sha256, 'Native binary differs from reviewed license inventory: ' + entry.file);
  const start = bytes.indexOf(Buffer.from('\xff Go buildinf:', 'latin1'));
  requireFact(start >= 0 && start % 16 === 0 && bytes[start + 15] & 2, 'Unsupported Go build information.');
  let position = start + 32;
  const readString = () => {
    let size = 0, shift = 0, next;
    do {
      requireFact(position < bytes.length && shift < 49, 'Invalid Go build string length.');
      next = bytes[position++]; size += (next & 127) * 2 ** shift; shift += 7;
    } while (next & 128);
    requireFact(position + size <= bytes.length, 'Truncated Go build string.');
    const value = bytes.toString('utf8', position, position + size); position += size; return value;
  };
  const goVersion = readString(), build = readString();
  requireFact(goVersion === 'go1.26.8', 'Go standard library version changed; review its notices.');
  const dependencies = build.split('\n').filter(line => line.startsWith('dep\t'));
  for (const line of dependencies) {
    const [, name, version] = line.split('\t');
    requireFact(modules.has(name + '@' + version), 'Embedded Go dependency has no notices: ' + name + '@' + version);
  }
  requireFact(dependencies.length > 0 || entry.file.endsWith('/docker.exe'), 'Plugin dependency information is missing.');
  binaries.push({ file: entry.file, goVersion, embeddedDependencies: dependencies.length });
}
console.log(JSON.stringify({ components: inventory.components.length, noticeTexts: inventory.texts.length, sourceArchives: inventory.sources.length, missing: 0, binaries }));
