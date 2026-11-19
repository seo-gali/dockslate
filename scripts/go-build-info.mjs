export function readGoBuildInfo(bytes) {
  const requireFact = (value,message) => { if (!value) throw Error(message); };
  const start = bytes.indexOf(Buffer.from('\xff Go buildinf:', 'latin1'));
  requireFact(start >= 0 && start % 16 === 0 && bytes[start + 15] & 2, 'Unsupported Go build information');
  let position = start + 32;
  const readString = () => {
    let size = 0, shift = 0, next;
    do {
      requireFact(position < bytes.length && shift < 49, 'Invalid Go build string length');
      next = bytes[position++]; size += (next & 127) * 2 ** shift; shift += 7;
    } while (next & 128);
    requireFact(position + size <= bytes.length, 'Truncated Go build string');
    const value = bytes.toString('utf8',position,position+size); position += size; return value;
  };
  const goVersion = readString(), build = readString();
  const dependencies = [];
  for (const line of build.split('\n')) {
    const [kind,name,version] = line.split('\t');
    if (kind === 'dep') dependencies.push({name,version});
    if (kind === '=>') {
      requireFact(dependencies.length > 0, 'Go replacement without a dependency');
      dependencies.at(-1).replacement = {name,version};
    }
  }
  return {goVersion,dependencies};
}
