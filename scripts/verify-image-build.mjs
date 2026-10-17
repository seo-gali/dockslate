import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const [portFile, approval] = process.argv.slice(2);
if (process.platform !== 'win32' || !portFile || approval !== '--approved-isolated-fixtures') throw new Error('Usage: node scripts/verify-image-build.mjs WEBVIEW_PORT_FILE --approved-isolated-fixtures');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local debugging port');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item=>item.type==='page' && /^https?:\/\/tauri\.localhost\/$/.test(item.url));
if (!target || !['127.0.0.1','localhost','[::1]'].includes(new URL(target.webSocketDebuggerUrl).hostname)) throw new Error('Actual local DockSlate window required');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const pending=new Map(),requests=new Map(),calls=[],exceptions=[];
let sequence=0;
const dataCommands=['dashboard_snapshot','engine_status','overview','containers_list','images_list','disk_usage','runtime_status','wsl_inventory','image_search'];
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},180000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
const parseCommand=url=>{try{const value=new URL(url);return value.hostname==='ipc.localhost'?decodeURIComponent(value.pathname.slice(1)):null;}catch{return null;}};
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data);
  if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
  if(message.method==='Network.requestWillBeSent'){
    const command=message.params.request.method==='POST'?parseCommand(message.params.request.url):null;
    if(command){const call={command,requestId:message.params.requestId,observedAt:Date.now()};calls.push(call);requests.set(call.requestId,call);}
  }
  if(message.method==='Network.loadingFinished'||message.method==='Network.loadingFailed'){
    const call=requests.get(message.params.requestId);
    if(call){call.finishedAt=Date.now();call.durationMs=call.finishedAt-call.observedAt;if(message.method==='Network.loadingFailed')call.failed=true;
      if(['image_build_start','image_build_status'].includes(call.command)&&!call.failed)call.bodyRead=send('Network.getResponseBody',{requestId:call.requestId}).then(response=>{let value=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;for(let count=0;count<2&&typeof value==='string';count+=1)value=JSON.parse(value);if(value&&typeof value.id==='string'&&['running','completed','failed'].includes(value.state))call.job=value;}).catch(error=>{call.responseReadError=error.message;});
      requests.delete(call.requestId);
    }
  }
  const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);if(message.error)request.reject(new Error(message.error.message));else request.resolve(message.result);
});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(String(result.exceptionDetails.exception?.value??result.exceptionDetails.exception?.description??result.exceptionDetails.text));return result.result.value;};
const invoke=(command,args={})=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const requireFact=(value,message)=>{if(!value)throw new Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(description,query,timeout=180000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await query();if(value)return value;await pause(150);}throw new Error(`Timed out: ${description}`);};
const serialCalls=values=>values.map(({command,observedAt,finishedAt,durationMs,failed,responseReadError})=>({command,observedAt,finishedAt,durationMs,failed,responseReadError}));
const counts=values=>Object.fromEntries([...new Set([...dataCommands,'image_build_start','image_build_status','image_build_pick_context','destructive_preview','destructive_execute'])].map(command=>[command,values.filter(item=>item.command===command).length]));
const activePage='main [data-page]:not([hidden])';
const buildSection=`${activePage} section[aria-label="이미지 빌드"]`;
const logSelector=`${buildSection} pre[aria-label="이미지 빌드 로그"]`;
const nav=async name=>{await evaluate(`(()=>{const button=[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim()===${JSON.stringify(name)});if(!button||button.disabled)throw new Error('Navigation unavailable');button.click();})()`);await waitFor(`active ${name}`,()=>evaluate(`document.querySelector('${activePage}')?.getAttribute('data-page')===${JSON.stringify(name)}`));};
const setInput=(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled)throw new Error('Input unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const buildView=()=>evaluate(`(()=>{const section=document.querySelector('${buildSection}');return{context:section?.querySelector('#build-context')?.value,dockerfile:section?.querySelector('#build-dockerfile')?.value,tag:section?.querySelector('#build-tag')?.value,noCache:section?.querySelector('#build-no-cache')?.checked,logs:section?.querySelector('pre[aria-label="이미지 빌드 로그"]')?.textContent??'',text:section?.innerText??'',submitDisabled:[...(section?.querySelectorAll('button')??[])].find(item=>item.textContent.trim()==='빌드 시작')?.disabled??true};})()`);
const fixtureNamespace=`dockslate-e2e-build-${Date.now()}`;
const fixtureRoot=path.resolve('.analysis',fixtureNamespace);
const contextPath=path.join(fixtureRoot,'한글 빌드 컨텍스트');
const tag=`${fixtureNamespace}:verify`;
const payload=Buffer.from(`${fixtureNamespace} real scratch COPY evidence\n`.repeat(8192));
const payloadHash=createHash('sha256').update(payload).digest('hex');
const assertWorkspaceDirectory=value=>{
  const resolved=path.resolve(value),relative=path.relative(process.cwd(),resolved);
  requireFact(/^[A-Za-z]:\\/.test(resolved)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative),'Fixture directory leaves the local-drive workspace');
  let current=resolved;for(;;){if(fs.existsSync(current))requireFact(fs.lstatSync(current).isDirectory()&&!fs.lstatSync(current).isSymbolicLink(),'Fixture path traverses a link');const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return resolved;
};
assertWorkspaceDirectory(contextPath);
const report={
  observedAt:new Date().toISOString(),target:'actual built Windows DockSlate native window and its verified owned running Moby engine',mockData:false,explicitIsolatedFixtureApproval:true,
  fixture:{namespace:fixtureNamespace,root:fixtureRoot,contextPath,tag,payloadBytes:payload.length,payloadSha256:payloadHash},checks:[],observations:{},screenshots:[],completed:false,failure:null,
  failureConditions:['Engine ownership or identity changes','Any preexisting image/container/cache ID or image tag changes','Invalid build input starts a job instead of rejecting','Malformed Dockerfile reports success or lacks real error logs','Successful UI build does not automatically update Images/Overview/Docker Usage','CLI image identity, fixture label, COPY payload or .dockerignore evidence disagrees','Navigation or idle rereads data after terminal build state','Cleanup targets any preexisting or non-fixture image'],
  failurePolicy:'Halt at the first failed criterion. Preserve all remaining fixture images, build cache and workspace evidence for inspection. Never retry automatically or globally prune.',
  untested:['Native folder picker interaction','WSL lifecycle changes','Container runtime execution of the built scratch image']
};
const check=name=>{report.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}));};
const screenshot=async name=>{const value=await send('Page.captureScreenshot',{format:'png'});const file=path.join(fixtureRoot,`${name}.png`);fs.writeFileSync(file,Buffer.from(value.data,'base64'));report.screenshots.push(file);};
let owned=null,engineId=null,baseline=null,fixtureImageId=null;
const imageIdentities=images=>images.map(image=>({id:image.id,tags:[...image.tags].sort()})).sort((a,b)=>a.id.localeCompare(b.id));
const sameImages=(images,expected)=>JSON.stringify(imageIdentities(images))===JSON.stringify(imageIdentities(expected));
const sortedIds=items=>items.map(item=>item.id).sort();
const assertOwned=async()=>{
  const runtime=await invoke('runtime_status'),engine=await invoke('engine_status');
  requireFact(runtime.state==='running'&&runtime.distribution==='DockSlate'&&runtime.keeperVerified===true&&runtime.installPath&&!runtime.blockedReasons.length,'Verified running owned DockSlate runtime required');
  requireFact(engine.state==='connected'&&engine.provider==='DockSlate'&&engine.engine==='moby'&&engine.ownerPath===runtime.installPath&&engine.endpoint==='wsl://DockSlate/var/run/docker.sock','Independent owned Moby connection required');
  const markerFile=path.join(path.dirname(runtime.installPath),'ownership.json'),stat=fs.lstatSync(markerFile);
  requireFact(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<131072,'Verified regular ownership marker required');
  const marker=JSON.parse(fs.readFileSync(markerFile,'utf8').replace(/^\uFEFF/,''));
  requireFact(marker.owner==='DockSlate'&&marker.state==='installed'&&marker.distribution==='DockSlate'&&marker.installPath===runtime.installPath&&marker.installId&&marker.registrationId,'Ownership marker mismatch');
  const fingerprint=JSON.stringify([marker.installId,marker.registrationId,marker.rootfsSha256,runtime.installPath]);
  if(owned===null)owned=fingerprint;
  requireFact(owned===fingerprint,'Owned runtime identity changed');
  return{runtime,engine};
};
const execFileAsync=promisify(execFile);
const guest=async(kind,reference)=>{
  await assertOwned();
  let args;
  if(kind==='identity')args=['info','--format','{{.ID}}'];
  else{requireFact(kind==='inspect'||kind==='save','Unsupported guest command');requireFact(reference===fixtureImageId||reference===tag,'Only the exact fixture image may be read');args=['image',kind,reference];}
  const result=await execFileAsync(path.join(process.env.SystemRoot,'System32','wsl.exe'),['--distribution','DockSlate','--user','root','--exec','/usr/bin/docker','--host','unix:///var/run/docker.sock',...args],{windowsHide:true,encoding:kind==='save'?null:'utf8',maxBuffer:32*1024*1024,timeout:120000});
  return result.stdout;
};
const readState=async()=>({images:await invoke('images_list'),containers:await invoke('containers_list'),usage:await invoke('disk_usage')});
const assertBaselinePreserved=(state,allowFixture)=>{
  requireFact(sameImages(state.images.filter(image=>allowFixture&&image.id===fixtureImageId?false:true),baseline.images),'A preexisting image ID or tag changed');
  requireFact(JSON.stringify(sortedIds(state.containers))===JSON.stringify(sortedIds(baseline.containers)),'A preexisting container ID changed');
  const caches=new Set(state.usage.buildCache.map(item=>item.id));
  requireFact(baseline.usage.buildCache.every(item=>caches.has(item.id)),'A preexisting build cache ID disappeared');
};
const parseTar=buffer=>{
  const entries=new Map();
  for(let offset=0;offset+512<=buffer.length;){
    const header=buffer.subarray(offset,offset+512);if(header.every(value=>value===0))break;
    const text=(start,end)=>header.subarray(start,end).toString('utf8').replace(/\0.*$/s,'');
    const name=[text(345,500),text(0,100)].filter(Boolean).join('/').replace(/^\.\//,'');
    const size=parseInt(text(124,136).trim()||'0',8);
    requireFact(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=buffer.length,'Invalid actual image archive header');
    entries.set(name,buffer.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;
  }
  return entries;
};
const latestJob=async(start,state)=>{
  const relevant=calls.slice(start).filter(call=>['image_build_start','image_build_status'].includes(call.command)&&call.finishedAt);
  await Promise.all(relevant.map(call=>call.bodyRead));
  const jobs=relevant.map(call=>call.job).filter(Boolean);
  const latest=jobs.filter(job=>job.state===state).at(-1);
  if(latest?.logs===null){const actual=jobs.findLast(job=>job.id===latest.id&&job.logVersion===latest.logVersion&&typeof job.logs==='string');if(actual)return {...latest,logs:actual.logs};}
  return latest;
};
const runUiBuild=async(expected)=>{
  const start=calls.length,startedAt=Date.now(),samples=[];
  await evaluate(`(()=>{const section=document.querySelector('${buildSection}');const button=[...(section?.querySelectorAll('button')??[])].find(item=>item.textContent.trim()==='빌드 시작');if(!button||button.disabled)throw new Error('Build submit unavailable');button.click();})()`);
  let runningObserved=false,visibleLogsWhileRunning=false,activeNavigationChecked=false;
  const job=await waitFor(`real UI build ${expected}`,async()=>{
    const view=await buildView();const running=await latestJob(start,'running');const terminal=await latestJob(start,expected);
    if(running)runningObserved=true;
    if(running&&!terminal&&view.logs.trim())visibleLogsWhileRunning=true;
    if(running&&!terminal&&!activeNavigationChecked){
      activeNavigationChecked=true;
      await nav('Settings');
      const stopDisabled=await evaluate(`(()=>{const button=[...document.querySelectorAll('${activePage} button')].find(item=>item.textContent.trim()==='런타임 중지…');return !!button&&button.disabled;})()`);
      requireFact(stopDisabled,'Runtime stop remained enabled while the UI build job is active');
      const rejected=await evaluate("window.__TAURI_INTERNALS__.invoke('runtime_stop',{approved:false}).then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}))");
      requireFact(rejected.rejected,'A build-time unapproved lifecycle request was accepted');
      report.observations.activeBuildNavigation={stopDisabled,rejection:rejected,buildGuardObserved:rejected.error.includes('이미지 빌드')};
      await nav('Images');
      requireFact((await buildView()).context===contextPath,'Leaving an active build lost its form state');
      return false;
    }
    if(samples.length<80)samples.push({observedAt:Date.now(),logs:view.logs,text:view.text,submitDisabled:view.submitDisabled});
    if(!terminal)return false;
    requireFact(terminal.tag===tag&&terminal.contextPath&&terminal.dockerfile,'Actual build job target metadata missing or incorrect');
    requireFact(view.logs.trim().length>0&&view.text.includes(expected==='completed'?'빌드 완료':'빌드 실패'),'UI does not show actual terminal state and build output');
    return terminal;
  });
  requireFact(calls.slice(start).filter(call=>call.command==='image_build_start').length===1,'One UI submission must start exactly one build job');
  requireFact(runningObserved,'Actual asynchronous running build state was not observed');
  const view=await buildView();
  requireFact(job.logs&&view.logs.includes(job.logs.trim()),'Visible build output does not contain actual backend logs');
  const result={job,view,samples,runningObserved,visibleLogsWhileRunning,durationMs:Date.now()-startedAt,calls:serialCalls(calls.slice(start)),counts:counts(calls.slice(start))};
  if(!visibleLogsWhileRunning)report.untested.push(`Nonempty log rendering before ${expected} terminal state was not observed for the short scratch build; actual final output and running state were verified`);
  return result;
};
try{
  requireFact(!fs.existsSync(fixtureRoot),'Fixture workspace already exists');fs.mkdirSync(contextPath,{recursive:true});
  fs.writeFileSync(path.join(contextPath,'payload.txt'),payload,{flag:'wx'});
  fs.writeFileSync(path.join(contextPath,'ignored.txt'),'This file must not enter the actual image layer.\n',{flag:'wx'});
  fs.writeFileSync(path.join(contextPath,'.dockerignore'),'ignored.txt\nDockerfile\n.dockerignore\n',{flag:'wx'});
  fs.writeFileSync(path.join(contextPath,'Dockerfile'),'FROM scratch\nTHIS_INSTRUCTION_IS_INVALID\n',{flag:'wx'});
  await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
  const verified=await assertOwned();engineId=(await guest('identity')).trim();requireFact(engineId.length>0,'Actual owned engine ID unavailable');
  report.observations.ownership={...verified,engineId};baseline=await readState();report.observations.baseline=baseline;
  requireFact(!baseline.images.some(image=>image.tags.includes(tag)),'Fixture tag already belongs to an existing image');
  check('verified running independent engine and exact user image/container/cache baseline; unique fixture context uses Korean and spaces');

  const invalidCases=[
    {name:'nonexistent context',args:{contextPath:path.join(fixtureRoot,'missing context'),dockerfile:'Dockerfile',tag,noCache:true}},
    {name:'Dockerfile traversal',args:{contextPath,dockerfile:'..\\outside.Dockerfile',tag,noCache:true}},
    {name:'tag shell-metacharacter injection',args:{contextPath,dockerfile:'Dockerfile',tag:`${tag}; echo dockslate-e2e`,noCache:true}},
  ];
  report.observations.validation=[];
  for(const test of invalidCases){const result=await evaluate(`window.__TAURI_INTERNALS__.invoke('image_build_start',${JSON.stringify(test.args)}).then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}))`);requireFact(result.rejected&&result.error.length>0,`Invalid input started a job: ${test.name}`);report.observations.validation.push({name:test.name,args:test.args,result});}
  assertBaselinePreserved(await readState(),false);
  check('missing context, Dockerfile traversal and injected tag reject before job creation without changing user data');

  await nav('Images');
  if(!await evaluate(`!!document.querySelector('${buildSection} #build-context')`)){await evaluate(`(()=>{const button=[...document.querySelectorAll('${activePage} .header-actions button')].find(item=>item.textContent.trim()==='이미지 빌드');if(!button||button.disabled)throw new Error('Image build entry unavailable');button.click();})()`);}
  await waitFor('actual build form',()=>evaluate(`!!document.querySelector('${buildSection} #build-context')`));
  await setInput(`${buildSection} #build-context`,contextPath);await setInput(`${buildSection} #build-dockerfile`,'Dockerfile');await setInput(`${buildSection} #build-tag`,tag);
  await evaluate(`(()=>{const checkbox=document.querySelector('${buildSection} #build-no-cache');if(!checkbox||checkbox.disabled)throw new Error('No-cache control unavailable');if(!checkbox.checked)checkbox.click();})()`);
  const failed=await runUiBuild('failed');report.observations.malformedDockerfile=failed;
  requireFact(/unknown instruction|parse error|invalid/i.test(`${failed.job.logs}\n${failed.job.error??''}`),'Malformed Dockerfile lacks an actual parser failure');
  requireFact(!failed.job.imageId,'Failed build fabricated an output image ID');
  assertBaselinePreserved(await readState(),false);
  await screenshot('malformed-dockerfile-real-error');
  check('malformed Dockerfile fails through the actual UI with real Buildx error logs and no fabricated image');

  fs.writeFileSync(path.join(contextPath,'Dockerfile'),`FROM scratch\nCOPY . /dockslate-e2e-context/\nLABEL io.dockslate.e2e="${fixtureNamespace}"\n`);
  await waitFor('retry build submit',async()=>!(await buildView()).submitDisabled);
  const retryInputs=await buildView();requireFact(retryInputs.context===contextPath&&retryInputs.dockerfile==='Dockerfile'&&retryInputs.tag===tag&&retryInputs.noCache,'Failed build lost editable retry input state');
  const completed=await runUiBuild('completed');report.observations.completedBuild=completed;
  fixtureImageId=completed.job.imageId;requireFact(/^sha256:[a-f0-9]{64}$/.test(fixtureImageId??''),'Successful job lacks an actual Docker image ID');
  requireFact(!baseline.images.some(image=>image.id===fixtureImageId),'Fixture build reused a preexisting user image ID');
  await waitFor('automatic shared Images, Overview and Docker Usage refresh',()=>evaluate(`(()=>{const images=document.querySelector('main [data-page="Images"]');const overview=document.querySelector('main [data-page="Overview"]');const usage=document.querySelector('main [data-page="Disk Manager"] [data-tab="docker"]');const row=[...(images?.querySelectorAll('tbody tr')??[])].some(item=>item.innerText.includes(${JSON.stringify(tag)})&&item.querySelector('.cell-subtext')?.getAttribute('title')===${JSON.stringify(fixtureImageId)});const imageCount=overview?.querySelectorAll('.metric-value')[1]?.textContent.trim();return row&&imageCount===${JSON.stringify(String(baseline.images.length+1))}&&usage?.innerText.includes(${JSON.stringify(tag)})&&[...document.querySelectorAll('main [data-page] .header-actions button:first-child')].every(button=>!button.disabled);})()`));
  const current=await readState();assertBaselinePreserved(current,true);
  const fixture=current.images.find(image=>image.id===fixtureImageId);requireFact(fixture&&fixture.tags.length===1&&fixture.tags[0]===tag,'Actual engine does not contain the exact expected fixture image tag');
  const inspected=JSON.parse(await guest('inspect',fixtureImageId));
  requireFact(inspected.length===1&&inspected[0].Id===fixtureImageId&&inspected[0].Config?.Labels?.['io.dockslate.e2e']===fixtureNamespace&&inspected[0].RootFS?.Layers?.length>0,'Actual CLI image identity, scratch COPY layer or fixture label mismatch');
  const archive=parseTar(await guest('save',fixtureImageId));
  requireFact(archive.has('manifest.json'),'Actual docker image save manifest is missing');
  const manifest=JSON.parse(archive.get('manifest.json').toString('utf8'));requireFact(manifest.length===1&&Array.isArray(manifest[0].Layers),'Unexpected actual image archive manifest');
  const layerEntries=[];
  for(const name of manifest[0].Layers){let layer=archive.get(name.replace(/^\.\//,''));requireFact(layer,'Actual image layer archive missing');if(layer[0]===0x1f&&layer[1]===0x8b)layer=gunzipSync(layer);for(const[name,bytes]of parseTar(layer))layerEntries.push({name,bytes});}
  const copied=layerEntries.find(item=>item.name==='dockslate-e2e-context/payload.txt');
  requireFact(copied&&createHash('sha256').update(copied.bytes).digest('hex')===payloadHash,'Actual saved image layer payload does not match the copied fixture');
  requireFact(!layerEntries.some(item=>/(?:^|\/)(?:ignored\.txt|Dockerfile|\.dockerignore)$/.test(item.name)),'.dockerignore exclusions entered the actual image layer');
  report.observations.imageEvidence={id:fixtureImageId,tag,inspect:inspected[0],layerPaths:layerEntries.map(item=>item.name),copiedPayloadBytes:copied.bytes.length,copiedPayloadSha256:payloadHash,newCacheIds:current.usage.buildCache.filter(item=>!baseline.usage.buildCache.some(old=>old.id===item.id)).map(item=>item.id)};
  check('corrected Dockerfile retries successfully and automatically updates shared views; real CLI image label, COPY payload and .dockerignore exclusions match');

  await nav('Images');const retained=await buildView();const navStart=calls.length;
  for(let round=0;round<3;round+=1){for(const name of['Overview','Disk Manager','Containers','Images'])await nav(name);const value=await buildView();requireFact(value.context===retained.context&&value.dockerfile===retained.dockerfile&&value.tag===retained.tag&&value.noCache===retained.noCache&&value.logs===retained.logs,'Menu navigation lost build inputs or actual logs');}
  const idleStartedAt=Date.now();await pause(6500);const navigationCalls=calls.slice(navStart);
  requireFact(!navigationCalls.some(call=>dataCommands.includes(call.command)||call.command==='image_build_status'),'Terminal build navigation or idle time polled data again');
  report.observations.navigation={roundTrips:3,idleMs:Date.now()-idleStartedAt,calls:serialCalls(navigationCalls),counts:counts(navigationCalls),retained};
  await screenshot('completed-image-build-retained');
  check('three menu round trips retain build inputs and output with zero data or build-status reads during navigation and idle');

  await assertOwned();requireFact((await guest('identity')).trim()===engineId,'Engine identity changed before fixture cleanup');
  const beforeCleanup=await readState();assertBaselinePreserved(beforeCleanup,true);
  const cleanupFixture=beforeCleanup.images.find(image=>image.id===fixtureImageId);
  requireFact(cleanupFixture&&cleanupFixture.tags.length===1&&cleanupFixture.tags[0]===tag&&cleanupFixture.containers===0,'Exact unused fixture image required for cleanup');
  const preview=await invoke('destructive_preview',{request:{kind:'image_delete',ids:[fixtureImageId]}});
  requireFact(preview.targets.length===1&&preview.targets[0]===fixtureImageId&&preview.token&&preview.expiresAt>Date.now(),'Cleanup preview is not restricted to the exact newly built fixture image');
  const removed=await invoke('destructive_execute',{token:preview.token,approved:true});
  requireFact(removed.failed.length===0&&removed.deleted.length===1&&removed.deleted[0]===fixtureImageId,'Exact fixture cleanup failed');
  const after=await readState();assertBaselinePreserved(after,false);requireFact(!after.images.some(image=>image.id===fixtureImageId),'Fixture image remains after exact approved cleanup');
  report.observations.cleanup={target:fixtureImageId,impact:preview.impact,result:removed,remainingImages:imageIdentities(after.images),remainingContainerIds:sortedIds(after.containers),preservedBaselineCacheIds:baseline.usage.buildCache.map(item=>item.id),newRetainedCacheIds:after.usage.buildCache.filter(item=>!baseline.usage.buildCache.some(old=>old.id===item.id)).map(item=>item.id)};
  requireFact(exceptions.length===0,`Unhandled renderer exceptions: ${exceptions.join('; ')}`);
  check('approved cleanup deletes only the exact new fixture image and preserves all original images, containers and cache IDs');
  report.completed=true;
}catch(error){report.failure=error.stack??String(error);report.checks.push({name:'halt at first image-build criterion failure',passed:false,error:error.message});try{await screenshot('failure');}catch{}process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();report.exceptions=exceptions;report.observedCounts=counts(calls);report.remaining='Workspace fixture files are retained. On success only the exact newly built fixture image is deleted; all original and newly generated build cache is retained. Failure performs no cleanup.';
  fs.mkdirSync('docs/results',{recursive:true});fs.writeFileSync('docs/results/image-build-e2e.json',JSON.stringify(report,null,2));
  try{await send('Network.disable');}catch{}
  console.log(JSON.stringify({completed:report.completed,checks:report.checks,failure:report.failure,report:'docs/results/image-build-e2e.json'}));
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Verification ended'));}socket.close();
}
