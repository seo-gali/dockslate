import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const [cliPath,expectedEngine,approval]=process.argv.slice(2);
assert(process.platform==='win32'&&approval==='--approved-new-migration-fixtures'&&expectedEngine,'Explicit isolated-fixture approval and engine ID required');
const cli=fs.realpathSync(cliPath),root=fs.realpathSync('.');assert(cli.startsWith(root+path.sep)&&path.basename(cli)==='docker.exe');
const prefix='dockslate-migration-bind-check-20261122',volumes=[],containers=[],checks=[];
const result={observedAt:new Date().toISOString(),scope:'Owned engine only; real bind/subpath/graceful-stop primitives, not a full Docker Desktop transfer',engine:expectedEngine,cliSha256:createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),checks,passed:false};
const published=JSON.parse(fs.readFileSync('docs/results/release-0.1.12.json','utf8'));
assert.equal(result.cliSha256.toUpperCase(),published.artifacts.find(v=>v.name==='docker.exe').sha256,'Workspace CLI changed from the recorded build');
function run(args,input,allowFailure=false){assert.equal(createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),result.cliSha256,'CLI changed before execution');const p=spawnSync(cli,args,{input,windowsHide:true,encoding:null,timeout:30000,maxBuffer:16*1024*1024});if(p.error)throw p.error;if(!allowFailure)assert.equal(p.status,0,p.stderr.toString());return p;}
const text=args=>run(args).stdout.toString('utf8').trim();
const inspect=(kind,value)=>JSON.parse(text([kind,'inspect',value]))[0];
const inventory=()=>({containers:text(['ps','-a','--no-trunc','--format','{{.ID}} {{.State}}']).split(/\r?\n/).sort(),volumes:text(['volume','ls','-q']).split(/\r?\n/).sort(),images:text(['image','ls','-q','--no-trunc']).split(/\r?\n/).sort()});
assert.equal(text(['info','--format','{{.ID}}']),expectedEngine);
const before=inventory();assert(!before.volumes.some(v=>v.startsWith(prefix)));assert.equal(text(['ps','-aq','--filter','label=io.dockslate.verification='+prefix]),'');
const image=text(['image','inspect','postgres:18.6-alpine','--format','{{.Id}}']);assert.match(image,/^sha256:[a-f0-9]{64}$/);
const data=Buffer.from('fixture-only\n한글\n');
function tar(entries){return Buffer.concat([...entries.flatMap(([name,kind,content=Buffer.alloc(0)])=>{const h=Buffer.alloc(512);h.write(name);for(const [at,n,v]of [[100,8,kind==='5'?0o750:0o640],[108,8,123],[116,8,456],[124,12,content.length],[136,12,1700000000]])h.write(v.toString(8).padStart(n-1,'0')+'\0',at);h.fill(32,148,156);h.write(kind,156);h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,v)=>a+v,0).toString(8).padStart(6,'0')+'\0 ',148);return[h,content,Buffer.alloc(Math.ceil(content.length/512)*512-content.length)];}),Buffer.alloc(1024)]);}
function readEntry(tar,expected){let offset=0;while(offset+512<=tar.length){const h=tar.subarray(offset,offset+512),name=h.subarray(0,100).toString().replace(/\0.*$/s,'').replace(/^\.\//,'');const octal=(a,b)=>parseInt(h.subarray(a,b).toString().replace(/\0.*$/s,'').trim(),8)||0;const length=octal(124,136);assert(length>=0&&offset+512+length<=tar.length);if(name===expected)return{data:tar.subarray(offset+512,offset+512+length),uid:octal(108,116),gid:octal(116,124),mode:octal(100,108)};offset+=512+Math.ceil(length/512)*512;}throw Error('Missing tar entry '+expected);}
function create(suffix,mounts,live=false){const id=text(['container','create','--name',prefix+'-'+suffix,'--network','none','--read-only','--stop-signal','SIGTERM','--label','io.dockslate.verification='+prefix,'--entrypoint',live?'/bin/sh':'/__dockslate_copy_only','--mount','type=tmpfs,dst=/var/lib/postgresql',...mounts.flatMap(v=>['--mount',v]),image,...(live?['-c',"trap 'exit 0' TERM; while :; do sleep 1; done"]:[])]);assert.match(id,/^[a-f0-9]{64}$/);containers.push(id);return id;}
try{
 for(const suffix of ['source','copy']){const name=prefix+'-'+suffix;text(['volume','create','--label','io.dockslate.verification='+prefix,name]);volumes.push(name);}
 const seed=create('seed',[`type=volume,src=${volumes[0]},dst=/seed,volume-nocopy`]);
 run(['container','cp','--archive','-',seed+':/seed'],tar([['directory/','5'],['directory/config.yaml','0',data],['file.conf','0',data]]));
 const mountpoint=inspect('volume',volumes[0]).Mountpoint;assert(mountpoint.startsWith('/var/lib/docker/volumes/'));
 const source=create('source',[`type=bind,src=${mountpoint}/directory,dst=/directory,readonly`,`type=bind,src=${mountpoint}/file.conf,dst=/file.conf,readonly`],true);
 text(['container','start',source]);assert.equal(inspect('container',source).State.Running,true);
 text(['container','stop','--timeout=-1',source]);assert.equal(inspect('container',source).State.Running,false);assert.equal(inspect('container',source).State.ExitCode,0);checks.push('Live fixture exits through its TERM handler without SIGKILL');
 const target=create('target',[`type=volume,src=${volumes[1]},dst=/copy,volume-nocopy`]);
 for(const entry of ['directory','file.conf']){const archive=run(['container','cp','--archive',source+':/'+entry,'-']).stdout;run(['container','cp','--archive','-',target+':/copy'],archive);}
 const restored=create('restored',[`type=volume,src=${volumes[1]},dst=/directory,volume-subpath=directory,volume-nocopy`,`type=volume,src=${volumes[1]},dst=/file.conf,volume-subpath=file.conf,volume-nocopy,readonly`],true);
 text(['container','start',restored]);assert.equal(inspect('container',restored).State.Running,true);
 for(const [containerPath,entry]of [['/directory/config.yaml','config.yaml'],['/file.conf','file.conf']]){const value=readEntry(run(['container','cp','--archive',restored+':'+containerPath,'-']).stdout,entry);assert.deepEqual(value.data,data);assert.equal(value.uid,123);assert.equal(value.gid,456);assert.equal(value.mode&0o777,0o640);}
 checks.push('Stopped bind directory and single file copy preserve contents, UID/GID and mode through volume subpaths');
 assert.equal(inspect('container',restored).Mounts.find(v=>v.Destination==='/file.conf').RW,false);
 assert.notEqual(run(['container','exec',restored,'/bin/sh','-c','echo forbidden >> /file.conf'],undefined,true).status,0);checks.push('Restored single-file mount remains read-only');
 text(['container','stop','--timeout=-1',restored]);result.passed=true;
}catch(error){result.error=String(error);throw error;}
finally{
 assert.equal(text(['info','--format','{{.ID}}']),expectedEngine);const cleanupErrors=[];
 for(const id of containers.reverse()){try{const info=inspect('container',id);assert.equal(info.Config.Labels['io.dockslate.verification'],prefix);if(info.State.Running)text(['container','stop','--timeout=-1',id]);text(['container','rm',id]);}catch(e){cleanupErrors.push(String(e));}}
 for(const name of volumes.reverse()){try{assert.equal(inspect('volume',name).Labels['io.dockslate.verification'],prefix);text(['volume','rm',name]);}catch(e){cleanupErrors.push(String(e));}}
 assert.deepEqual(inventory(),before,'Existing inventory or states changed');result.cleanupErrors=cleanupErrors;result.passed&&=cleanupErrors.length===0;checks.push('Only new labelled fixtures removed; previous inventory and states unchanged');fs.mkdirSync('.analysis/migration-bind-check',{recursive:true});fs.writeFileSync('.analysis/migration-bind-check/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));assert.equal(cleanupErrors.length,0);
}
