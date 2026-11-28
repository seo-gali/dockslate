import fs from 'node:fs';
import assert from 'node:assert/strict';
import {approvedUnverifiedPublication} from '../scripts/release-assets.mjs';
import {createHash} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const input=read('.github/release017-publish-input.json');
assert.equal(input.version,'0.1.17');
for(const entry of input.required){assert(/^(docs\/|downloads\/)[A-Za-z0-9_./-]+$/.test(entry.path)&&!entry.path.includes('..'));assert.equal(hash(fs.readFileSync(entry.path)),entry.sha256);}
const build=read('docs/results/release-0.1.17.json'),scans=read('docs/results/virustotal-0.1.17.json');
assert.equal(build.version,input.version);assert.equal(scans.version,input.version);assert.equal(build.files.length,3);assert.equal(scans.files.length,4);
const unverifiedAntivirus=approvedUnverifiedPublication(input.version,scans,true);
for(const scan of scans.files){
 if(unverifiedAntivirus)continue;
 assert(scan.completed&&scan.totalEngines>0&&Number.isInteger(scan.detections)&&scan.detections>=0);
 if(!scan.detections)continue;
 assert(scan.file==='DockSlate.exe'||scan.file==='DockSlate-0.1.17-windows-x64.zip');
 assert(scans.publicationApprovals.some(a=>a.userApproved===true&&a.sha256===scan.sha256&&a.detections===scan.detections&&scan.detectionVendors.length===1&&a.vendor===scan.detectionVendors[0]));
}
for(const artifact of build.artifacts)assert(scans.files.some(s=>s.sha256===artifact.sha256));
const sums=fs.readFileSync('.github/release017-SHA256SUMS.txt');
assert.equal(sums.toString(),build.files.map(f=>f.sha256+'  '+f.file).join('\n')+'\n');
const files=[...build.files,{file:'SHA256SUMS.txt',bytes:sums.length,sha256:hash(sums)}];
for(const file of files){
 assert(/^(DockSlate_0\.1\.17_x64-setup\.exe|DockSlate-0\.1\.17-(windows-x64|third-party-licenses)\.zip|SHA256SUMS\.txt)$/.test(file.file));
 const bytes=fs.readFileSync(file.file==='SHA256SUMS.txt'?'.github/release017-SHA256SUMS.txt':'downloads/'+file.file);assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256);
 if(file.file.includes('setup'))assert(scans.files.some(s=>s.sha256===file.sha256&&(unverifiedAntivirus||s.detections===0)));
 if(file.file.includes('windows-x64'))assert(scans.files.some(s=>s.sha256===file.sha256));
}
const notes=fs.readFileSync('docs/releases/v0.1.17.md','utf8');
if(unverifiedAntivirus)assert(notes.includes('백신 검사 미완료')&&notes.includes('미서명'));
if(process.argv.includes('--check-only')){
 console.log(JSON.stringify({preflightPassed:true,unverifiedAntivirus,files:files.length,scans:scans.files.length,approvedDetectedFiles:scans.publicationApprovals.length,networkUsed:false}));
}else{
 assert.equal(process.env.GITHUB_REPOSITORY,'seo-gali/dockslate');assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA));assert(process.env.GH_TOKEN);
 const sourceCommit=process.env.GITHUB_SHA,base='https://api.github.com/repos/seo-gali/dockslate',tag='v0.1.17';
 const headers={Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'};
 const api=async(path,method='GET',body,allow404=false)=>{
  const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  if(response.status===404&&allow404)return null;
  if(!response.ok)throw Error(`GitHub ${method} ${path} HTTP ${response.status}; no automatic write retry`);
  return response.status===204?null:response.json();
 };
 const previous=await api('/releases/tags/v0.1.16');
 const previousAssets=previous.assets.map(a=>[a.id,a.name,a.digest]);
 let ref=await api('/git/ref/tags/'+tag,'GET',undefined,true);
 if(!ref)ref=await api('/git/refs','POST',{ref:'refs/tags/'+tag,sha:sourceCommit});
 assert.equal(ref.object.type,'commit');assert.equal(ref.object.sha,sourceCommit);
 let release=await api('/releases/tags/'+tag,'GET',undefined,true);
 if(!release)release=await api('/releases','POST',{tag_name:tag,target_commitish:sourceCommit,name:'DockSlate 0.1.17',draft:true,prerelease:true,make_latest:'false',body:notes});
 assert(release.prerelease);assert(release.assets.every(a=>files.some(f=>f.file===a.name)));
 for(const file of files){
  let asset=release.assets.find(a=>a.name===file.file);
  if(!asset){
   assert(release.draft,'Published release must already contain every verified file');
   const url=new URL(release.upload_url.split('{')[0]);assert.equal(url.hostname,'uploads.github.com');assert(url.pathname.startsWith('/repos/seo-gali/dockslate/'));url.searchParams.set('name',file.file);
   const bytes=fs.readFileSync(file.file==='SHA256SUMS.txt'?'.github/release017-SHA256SUMS.txt':'downloads/'+file.file);assert.equal(hash(bytes),file.sha256);
   const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(180000)});
   if(!response.ok)throw Error(`Asset upload HTTP ${response.status}; no automatic write retry`);asset=await response.json();
  }
  assert.equal(asset.size,file.bytes);assert.equal(asset.digest,'sha256:'+file.sha256.toLowerCase());
 }
 if(release.draft)await api('/releases/'+release.id,'PATCH',{draft:false,prerelease:true,make_latest:'false',body:notes});
 release=await api('/releases/'+release.id);assert(!release.draft&&release.prerelease&&release.assets.length===4);
 const after=await api('/releases/tags/v0.1.16');assert.equal(after.id,previous.id);assert.deepEqual(after.assets.map(a=>[a.id,a.name,a.digest]),previousAssets);
 console.log(JSON.stringify({published:true,url:release.html_url,releaseId:release.id,tag,sourceCommit,assets:release.assets.map(a=>({name:a.name,bytes:a.size,digest:a.digest})),previousReleasePreserved:true}));
 fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Published [DockSlate 0.1.17](${release.html_url}) as an unsigned prerelease. Exact SHA-256 antivirus findings and any required user approvals are recorded in the release notes. Four asset digests verified.\n`);
}
