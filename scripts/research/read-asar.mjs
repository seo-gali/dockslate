import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Static ASAR member extraction
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node read-asar.mjs INPUT_ASAR NEW_OUTPUT');
const source = path.resolve(input);
const destination = path.resolve(output);
if (fs.existsSync(destination)) throw new Error('Output directory must be new');
const bytes = fs.readFileSync(source);
const headerSize = bytes.readUInt32LE(4);
const jsonSize = bytes.readUInt32LE(12);
const dataStart = 8 + headerSize;
if (dataStart > bytes.length || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header bounds');
const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const inventory = [];
fs.mkdirSync(destination, { recursive: true });
function visit(directory, prefix = '') {
  for (const [name, member] of Object.entries(directory.files ?? {})) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (member.files) { visit(member, relative); continue; }
    const entry = { path: relative, size: member.size ?? null, unpacked: !!member.unpacked, link: member.link ?? null, integrity: member.integrity ?? null };
    inventory.push(entry);
    if (member.link || member.unpacked) continue;
    const offset = Number(member.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(member.size) || member.size < 0 || dataStart + offset + member.size > bytes.length) throw new Error('Invalid member bounds: ' + relative);
    const content = bytes.subarray(dataStart + offset, dataStart + offset + member.size);
    entry.sha256 = sha256(content);
    if (member.integrity) {
      if (member.integrity.algorithm !== 'SHA256' || entry.sha256 !== member.integrity.hash) throw new Error('Integrity mismatch: ' + relative);
      const { blocks, blockSize } = member.integrity;
      if (blocks) {
        if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('Invalid integrity block size');
        if (blocks.length !== Math.max(1, Math.ceil(content.length / blockSize))) throw new Error('Integrity block count mismatch: ' + relative);
        for (let i = 0; i < blocks.length; i++) if (sha256(content.subarray(i * blockSize, (i + 1) * blockSize)) !== blocks[i]) throw new Error('Block integrity mismatch: ' + relative);
      }
      entry.integrity_verified = true;
    }
    const selected = relative === 'package.json' || /(^|\/)(LICENSE|NOTICE)(\.|$)|\.LICENSE\.txt$/i.test(relative) || (!relative.startsWith('node_modules/') && /\.(js|map|json)$/i.test(relative));
    if (!selected) continue;
    const target = path.resolve(destination, relative);
    if (!target.startsWith(destination + path.sep)) throw new Error('Unsafe member path: ' + relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx' });
    entry.extracted = true;
  }
}
visit(header);
fs.writeFileSync(path.join(destination, 'asar-inventory.json'), JSON.stringify({ input_path: source, root_sha256: sha256(bytes), data_start: dataStart, entries: inventory }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ root_sha256: sha256(bytes), member_count: inventory.length, extracted_count: inventory.filter(x => x.extracted).length, unpacked_count: inventory.filter(x => x.unpacked).length, first_party: inventory.filter(x => x.extracted && !x.path.startsWith('node_modules/')).map(({ path, size, sha256 }) => ({ path, size, sha256 })) }, null, 2));
