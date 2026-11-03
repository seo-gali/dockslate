import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../site/guide.html', import.meta.url), 'utf8');
writeFileSync(new URL('../dist/guide.html', import.meta.url), source);
