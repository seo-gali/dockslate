import test from 'node:test';
import assert from 'node:assert/strict';
import { readGoBuildInfo } from '../go-build-info.mjs';
test('Go metadata reader bounds lengths and records module replacements', () => {
  const header=Buffer.alloc(32);Buffer.from('\xff Go buildinf:','latin1').copy(header);header[15]=2;
  const string=value=>Buffer.concat([Buffer.from([Buffer.byteLength(value)]),Buffer.from(value)]);
  const bytes=Buffer.concat([header,string('go1.26.8'),string('dep\texample.org/a\tv1.0.0\n=>\texample.org/b\tv1.0.1\n')]);
  assert.deepEqual(readGoBuildInfo(bytes),{goVersion:'go1.26.8',dependencies:[{name:'example.org/a',version:'v1.0.0',replacement:{name:'example.org/b',version:'v1.0.1'}}]});
  assert.throws(()=>readGoBuildInfo(Buffer.from('not a binary')),/Unsupported/);
  assert.throws(()=>readGoBuildInfo(Buffer.concat([header,Buffer.from([255,255,255])])),/length/);
  assert.throws(()=>readGoBuildInfo(bytes.subarray(0,40)),/Truncated/);
});
