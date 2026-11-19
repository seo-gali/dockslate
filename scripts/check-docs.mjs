import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','*.md'],{encoding:'utf8'}).trim().split('\n').filter(file=>fs.existsSync(file));
const missing=[];
const missingAnchors=[];
const anchors=source=>{
  const seen=new Map(),values=new Set();
  for(const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)){
    const base=match[1].trim().toLowerCase().replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}_\s-]/gu,'').replace(/\s/g,'-');
    const count=seen.get(base)??0;seen.set(base,count+1);values.add(base+(count?'-'+count:''));
  }
  for(const match of source.matchAll(/\bid=["']([^"']+)["']/g))values.add(match[1]);
  return values;
};
let checkedLinks=0,checkedAnchors=0;
for(const file of files){
  if(!fs.existsSync(file))continue;
  const text=fs.readFileSync(file,'utf8');
  for(const m of text.matchAll(/\]\(([^)]+)\)/g)){
    let target=m[1].trim().replace(/^<|>$/g,'').split(/\s+"/)[0];
    if(/^(?:https?:|mailto:)/.test(target))continue;
    const fragment=target.includes('#')?decodeURIComponent(target.slice(target.indexOf('#')+1)):null;
    target=target.split('#')[0];
    try{target=decodeURIComponent(target)}catch{}
    const resolved=target?path.resolve(path.dirname(file),target):path.resolve(file);
    checkedLinks++;
    if(!fs.existsSync(resolved))missing.push({file,target});
    else if(fragment&&/\.(md|html)$/i.test(resolved)){
      checkedAnchors++;
      if(!anchors(fs.readFileSync(resolved,'utf8')).has(fragment))missingAnchors.push({file,target,fragment});
    }
  }
}
const report={files:files.length,checkedLinks,checkedAnchors,missing,missingAnchors};
console.log(JSON.stringify(report,null,2));
if(missing.length||missingAnchors.length)process.exitCode=1;
