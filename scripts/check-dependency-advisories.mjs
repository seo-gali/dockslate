import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function dependencyQueries(lock, inventory) {
  const packages = lock.split('[[package]]').slice(1).filter(block=>/^source = "registry\+/m.test(block)).map(block=>{
    const name=/^name = "([^"]+)"/m.exec(block)?.[1], version=/^version = "([^"]+)"/m.exec(block)?.[1];
    if(!name || !version) throw Error('Incomplete Cargo registry package');
    return {package:{name,ecosystem:'crates.io'},version};
  });
  for(const component of inventory.components) {
    if(component.ecosystem==='go') packages.push({package:{name:component.name,ecosystem:'Go'},version:component.version});
    if(component.ecosystem==='support'&&component.name==='Go standard library and vendored support') packages.push({package:{name:'stdlib',ecosystem:'Go'},version:component.version.replace(/^go/,'')});
  }
  if(!packages.some(item=>item.package.name==='stdlib')) throw Error('Go runtime version is missing');
  return [...new Map(packages.map(item=>[`${item.package.ecosystem}:${item.package.name}@${item.version}`,item])).values()];
}

export function advisoryFindings(queries, response) {
  if(!Array.isArray(response.results)||response.results.length!==queries.length) throw Error('Incomplete OSV response');
  return response.results.flatMap((result,index)=>{
    if(result.vulns===undefined) return [];
    if(!Array.isArray(result.vulns)||result.vulns.some(item=>typeof item.id!=='string')) throw Error('Invalid OSV advisory list');
    return result.vulns.length?[{...queries[index],advisories:[...new Set(result.vulns.map(item=>item.id))]}]:[];
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const queries=dependencyQueries(fs.readFileSync(path.join(root,'src-tauri/Cargo.lock'),'utf8'),JSON.parse(fs.readFileSync(path.join(root,'licenses/inventory.json'),'utf8')));
  const response=await fetch('https://api.osv.dev/v1/querybatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({queries}),signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw Error('OSV query failed: HTTP '+response.status);
  const findings=advisoryFindings(queries,await response.json());
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),queries:queries.length,findings,scope:'All Cargo registry versions, Windows CLI/plugin vendor modules and Go runtime; version matches require target and code-path review. npm is checked separately by npm audit.'},null,2));
  if(findings.length) process.exitCode=1;
}
