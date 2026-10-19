import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

const directory = path.resolve('dist/assets');
const files = fs.readdirSync(directory);
const sizes = files.map(name => {
  const bytes = fs.readFileSync(path.join(directory, name));
  return { name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
});
const entry = sizes.filter(file => /^index-.*\.js$/.test(file.name)).sort((a, b) => b.bytes - a.bytes)[0];
if (!entry) throw new Error('Run npm run build first');
function staticDependencies(name, result = new Set()) {
  if (result.has(name)) return result;
  result.add(name);
  const source = ts.createSourceFile(name, fs.readFileSync(path.join(directory, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = path.basename(statement.moduleSpecifier.text);
      if (files.includes(target) && target.endsWith('.js')) staticDependencies(target, result);
    }
  }
  return result;
}
const initial = staticDependencies(entry.name);
const overview = files.find(name => /^Overview-.*\.js$/.test(name));
if (overview) staticDependencies(overview, initial);
const english = files.find(name => /^locales\.en-.*\.js$/.test(name));
const total = names => sizes.filter(file => names.has(file.name)).reduce((sum, file) => ({ bytes: sum.bytes + file.bytes, gzipBytes: sum.gzipBytes + file.gzipBytes }), { bytes: 0, gzipBytes: 0 });
const before = { bytes: 496910, gzipBytes: 146310, source: 'Observed Vite output for native artifact 8A566A2FC41CED72B1092F28CAE54773C92E9BBFF0DF1FE75E4AD79B6869B5BC; rounded to 0.01 kB' };
const report = {
  observedAt: new Date().toISOString(),
  measurement: 'Production asset file sizes and gzip; no runtime benchmark or inferred network timing',
  beforeEntry: before, entry, initialKorean: total(initial),
  initialEnglish: total(new Set([...initial, ...(english ? [english] : [])])),
  allJavaScript: total(new Set(files.filter(name => name.endsWith('.js')))),
  entryReductionPercent: Number(((1 - entry.bytes / before.bytes) * 100).toFixed(2)),
  initialKoreanFiles: [...initial].sort(),
  lazyPages: sizes.filter(file => /^(Containers|Images|Resources|Builds|DiskManager|Settings)-.*\.js$/.test(file.name)),
  englishCatalog: sizes.find(file => file.name === english),
  externalFontFiles: files.filter(name => /\.(woff2?|ttf|otf)$/i.test(name)),
  rasterImages: files.filter(name => /\.(png|jpe?g|gif|webp|avif)$/i.test(name)),
  assets: sizes,
};
fs.writeFileSync(process.argv[2] ?? 'docs/results/bundle-inspection.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ entry: report.entry, initialKorean: report.initialKorean, initialEnglish: report.initialEnglish, allJavaScript: report.allJavaScript, entryReductionPercent: report.entryReductionPercent }));
