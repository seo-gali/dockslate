import assert from 'node:assert/strict';
import test from 'node:test';
import {dependencyQueries,advisoryFindings} from '../check-dependency-advisories.mjs';
test('dependency review includes registry crates, deduplicates modules and refuses incomplete results',()=>{
 const lock='[[package]]\nname = "example"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname = "local"\nversion = "0.1.0"\n';
 const module={ecosystem:'go',name:'example.org/module',version:'v1.2.3'};
 const queries=dependencyQueries(lock,{components:[module,module,{ecosystem:'support',name:'Go standard library and vendored support',version:'go1.27.4'}]});
 assert.equal(queries.length,3);assert.equal(queries[0].package.name,'example');assert.equal(queries[2].version,'1.27.4');
 assert.deepEqual(advisoryFindings(queries,{results:[{},{},{}]}),[]);
 const flagged=advisoryFindings(queries,{results:[{},{vulns:[{id:'GO-EXAMPLE'},{id:'GO-EXAMPLE'}]},{}]});
 assert.equal(flagged[0].package.name,'example.org/module');assert.deepEqual(flagged[0].advisories,['GO-EXAMPLE']);
 assert.throws(()=>advisoryFindings(queries,{results:[]}),/Incomplete/);
 assert.throws(()=>advisoryFindings(queries,{results:[{vulns:[{}]},{},{}]}),/Invalid/);
});
