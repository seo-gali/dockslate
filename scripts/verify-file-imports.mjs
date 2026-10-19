import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connectNative,waitFor,pause} from './native-verification.mjs';

if(!process.argv.includes('--isolated-fixture')) throw Error('Explicit isolated-fixture mode required');
const expected='A746B364F516DC39B05A65D47FBE727B57F27CD4D35CD068F5ABF02D149F8A02';
const session=JSON.parse(fs.readFileSync('.analysis/file-import-native-session.json','utf8').replace(/^\uFEFF/,''));
if(!session.explicitRiskApproval||!session.isolatedProfile||session.sha256!==expected) throw Error('Specifically approved isolated native session required');
if(crypto.createHash('sha256').update(fs.readFileSync(session.artifact)).digest('hex').toUpperCase()!==expected) throw Error('Artifact changed');
const c=await connectNative(session.portFile), ev=c.evaluate, execute=promisify(execFile);
const fixtureId=crypto.randomBytes(6).toString('hex');
const fixtureRoot=path.resolve(`.analysis/file-import-fixture-${fixtureId}/샘플 프로젝트`);
const fixtureName=`dockslate-file-e2e-${fixtureId}`;
const report={observedAt:new Date().toISOString(),artifactSha256:expected,native:true,mockBackend:false,completed:false,
  failureConditions:['No real Windows file picker','Selection mismatch or unsupported source accepted','Build fails or does not create a distinct local image','Run skips explicit Compose approval','Fixture container fails to execute','Existing container/image/volume/network ID sets change','Fixture cleanup fails'],
  scope:'Actual selected isolated hello-world-based Dockerfile and Compose, not a user project',checks:[],cleanup:null,failure:null};
const check=(name,evidence)=>{report.checks.push({name,passed:true,evidence});console.log(JSON.stringify({name,passed:true}));};
const assert=(value,message)=>{if(!value)throw Error(message);};
const click=async selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control unavailable: '+${JSON.stringify(selector)});e.click()})()`);
const clickText=async (scope,text)=>ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});e.click()})()`);
const snapshot=async()=>{const[containers,images,volumes,networks]=await Promise.all([c.invoke('containers_list'),c.invoke('images_list'),c.invoke('volumes_list'),c.invoke('networks_list')]);return{containers,images,volumes,networks};};
const signatures=(state)=>Object.fromEntries(Object.entries(state).map(([kind,values])=>[kind,values.map(row=>row.id??row.name).sort()]));
const choose=async(file,cancel=false)=>{
  const args=['-NoProfile','-File',path.resolve('scripts/select-native-import-file.ps1'),'-TargetProcessId',String(session.pid)];
  args.push(...(cancel?['-Cancel']:['-Path',file]));
  const result=await execute(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args,{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536});
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
};
let baseline, dockerImage, composeProject, composeImage, dockerContainer;
try{
  baseline=await snapshot();
  assert(baseline.images.some(i=>i.tags.includes('hello-world:latest')),'Cached hello-world image required; no downloads permitted');
  assert(baseline.containers.find(row=>row.name==='trusting_feistel')?.state==='running','Existing MongoDB must be running before verification');
  fs.mkdirSync(fixtureRoot,{recursive:true});
  fs.writeFileSync(path.join(fixtureRoot,'Dockerfile'),`FROM hello-world:latest\nLABEL dockslate.e2e.fixture="${fixtureId}-dockerfile"\n`);
  fs.writeFileSync(path.join(fixtureRoot,'Dockerfile.compose'),`FROM hello-world:latest\nLABEL dockslate.e2e.fixture="${fixtureId}-compose"\n`);
  fs.writeFileSync(path.join(fixtureRoot,'compose.yaml'),'services:\n  sample:\n    build:\n      context: .\n      dockerfile: Dockerfile.compose\n    restart: "no"\n');
  fs.writeFileSync(path.join(fixtureRoot,'blocked.yaml'),'services:\n  sample:\n    image: hello-world:latest\n    environment:\n      EXAMPLE: "${DOCKSLATE_E2E_BLOCKED}"\n');
  fs.writeFileSync('.analysis/file-import-fixture-state.json',JSON.stringify({fixtureRoot,fixtureName,baseline:signatures(baseline)},null,2));
  await c.nav('Builds');
  await waitFor('Builds source tab',()=>ev(`!!document.querySelector('[data-page="Builds"] [role="tab"]')`));
  await click('[data-page="Builds"] [role="tab"]');
  await clickText('[data-page="Builds"] button','Choose Dockerfile');
  const canceled=await choose(null,true);
  await waitFor('cancel restores choose button',()=>ev(`[...document.querySelectorAll('[data-page="Builds"] button')].find(e=>e.textContent.trim()==='Choose Dockerfile')?.disabled===false`));
  assert(await ev(`!document.querySelector('[data-build-state]')`),'Cancel unexpectedly started a build');
  check('Real Windows Dockerfile picker cancellation returns without starting a build',canceled);

  await clickText('[data-page="Builds"] button','Choose Dockerfile');
  const selected=await choose(path.join(fixtureRoot,'Dockerfile'));
  await waitFor('Dockerfile build result',()=>ev(`['completed','failed'].includes(document.querySelector('[data-build-state]')?.getAttribute('data-build-state'))`),120000);
  const buildState=await ev(`({state:document.querySelector('[data-build-state]')?.getAttribute('data-build-state'),context:document.querySelector('#build-context')?.value,dockerfile:document.querySelector('#build-dockerfile')?.value,tag:document.querySelector('#build-tag')?.value,error:document.querySelector('[data-build-state] [role="alert"]')?.textContent})`);
  assert(buildState.state==='completed','Dockerfile build failed: '+buildState.error);
  assert(buildState.context.toLowerCase()===fixtureRoot.toLowerCase()&&buildState.dockerfile==='Dockerfile','Selected Dockerfile path was not preserved');
  dockerImage=(await c.invoke('images_list')).find(i=>i.tags.includes(buildState.tag));
  assert(dockerImage&&!baseline.images.some(i=>i.id===dockerImage.id),'Build did not create a distinct fixture image');
  check('Actual Dockerfile picker with Korean/spaces path automatically builds a distinct local image',{picker:selected,context:buildState.context,tag:buildState.tag,imageId:dockerImage.id});
  await waitFor('post-build refresh',()=>ev(`!document.querySelector('#build-context')?.disabled`));
  await c.nav('Images');
  const runSelector=`[aria-controls="run-image-${dockerImage.id.replace(/^sha256:/,'')}"]`;
  await waitFor('new image visible',()=>ev(`!!document.querySelector(${JSON.stringify(runSelector)})&&!document.querySelector(${JSON.stringify(runSelector)}).disabled`));
  await click(runSelector);
  await waitFor('run form ready',()=>ev(`!!document.querySelector('.image-run-row #run-name')&&!document.querySelector('.image-run-row button[type="submit"]')?.disabled`));
  await c.setInput('.image-run-row #run-name',fixtureName);
  await click('.image-run-row button[type="submit"]');
  await waitFor('Dockerfile-created container list',()=>ev(`!document.querySelector('[data-page="Containers"]').hidden&&[...document.querySelectorAll('.container-table .name-button')].some(b=>b.textContent===${JSON.stringify(fixtureName)})`));
  dockerContainer=(await c.invoke('containers_list')).find(row=>row.name===fixtureName);
  assert(dockerContainer&&!baseline.containers.some(row=>row.id===dockerContainer.id),'Fixture container identity missing');
  let inspect=await c.invoke('container_inspect',{id:dockerContainer.id});
  await waitFor('hello executable exits',async()=>{inspect=await c.invoke('container_inspect',{id:dockerContainer.id});return inspect.State?.Status==='exited';});
  assert(inspect.Image===dockerImage.id&&inspect.State.ExitCode===0&&inspect.Mounts.length===0,'Dockerfile container did not execute cleanly without mounts');
  assert(await ev(`document.querySelectorAll('[role="dialog"]').length===0`),'Create auto-opened detail modal');
  check('Dockerfile-built image runs its actual executable and navigates to list',{containerId:dockerContainer.id,imageId:inspect.Image,exitCode:inspect.State.ExitCode,noMounts:true});

  await c.nav('Builds');
  await click('[data-page="Builds"] [role="tab"]');
  await clickText('[data-page="Builds"] button','Choose Compose file');
  await choose(path.join(fixtureRoot,'blocked.yaml'));
  await waitFor('unsafe substitution rejected',()=>ev(`!!document.querySelector('[data-page="Builds"] .image-build-panel [role="alert"]')`));
  const blocked=await ev(`document.querySelector('[data-page="Builds"] .image-build-panel [role="alert"]')?.textContent`);
  assert(/환경 변수|variable|치환|substitution/i.test(blocked),'Expected explicit variable substitution rejection');
  check('Actual Compose picker rejects variable substitution before build or run',{rejection:blocked});

  await clickText('[data-page="Builds"] button','Choose Compose file');
  const composeSelected=await choose(path.join(fixtureRoot,'compose.yaml'));
  await waitFor('Compose build result',()=>ev(`['completed','failed'].includes(document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'))`),120000);
  const composeBuild=await ev(`({state:document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'),error:document.querySelector('[data-compose-state] [role="alert"]')?.textContent,project:[...document.querySelectorAll('[data-page="Builds"] .detail-grid dd')][1]?.textContent,path:[...document.querySelectorAll('[data-page="Builds"] .detail-grid dd')][0]?.textContent})`);
  composeProject=composeBuild.project;
  assert(composeBuild.state==='completed','Compose build failed: '+composeBuild.error);
  assert(composeBuild.path.toLowerCase()===path.join(fixtureRoot,'compose.yaml').toLowerCase()&&/^dockslate-import-[a-f0-9]{64}$/.test(composeProject),'Compose path/project identity mismatch');
  composeImage=(await c.invoke('images_list')).find(i=>i.tags.includes(`${composeProject}-sample:import`));
  assert(composeImage&&!baseline.images.some(i=>i.id===composeImage.id)&&composeImage.id!==dockerImage.id,'Compose did not build its distinct fixture image');
  const beforeRun=await c.invoke('containers_list');
  assert(!beforeRun.some(row=>row.name.startsWith(composeProject)),'Compose started a service without approval');
  check('Actual Compose picker builds local service image and waits for separate run approval',{picker:composeSelected,project:composeProject,imageId:composeImage.id,noServiceBeforeApproval:true});
  await waitFor('run preview ready',()=>ev(`[...document.querySelectorAll('[data-compose-state] button')].some(b=>!b.disabled&&b.textContent.includes('preview'))`));
  await clickText('[data-compose-state] button','Preview run');
  await waitFor('actual Compose approval popup',()=>ev(`!!document.querySelector('.confirm-dialog')`));
  const confirmation=await ev(`({text:document.querySelector('.confirm-dialog')?.innerText,disabled:document.querySelector('.confirm-dialog footer button:last-child')?.disabled})`);
  assert(confirmation.disabled&&confirmation.text.includes(composeProject)&&confirmation.text.includes('sample'),'Approval is missing service/project details or acknowledgment gate');
  check('Compose approval popup identifies service/project and disables Run until acknowledged',{project:composeProject,service:'sample',runInitiallyDisabled:true});
  await click('.confirm-dialog .acknowledgement input');
  await click('.confirm-dialog footer button:last-child');
  await waitFor('Compose run completes',()=>ev(`!document.querySelector('.confirm-dialog')&&['completed','failed'].includes(document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'))`),90000);
  const runState=await ev(`({state:document.querySelector('[data-compose-state]')?.getAttribute('data-compose-state'),error:document.querySelector('[data-compose-state] [role="alert"]')?.textContent})`);
  assert(runState.state==='completed','Compose run failed: '+runState.error);
  const composeContainer=(await c.invoke('containers_list')).find(row=>row.name===`${composeProject}-sample-1`);
  assert(composeContainer&&!baseline.containers.some(row=>row.id===composeContainer.id),'Compose service container identity missing');
  let composeInspect;
  await waitFor('Compose executable exits',async()=>{composeInspect=await c.invoke('container_inspect',{id:composeContainer.id});return composeInspect.State?.Status==='exited';});
  assert(composeInspect.Image===composeImage.id&&composeInspect.State.ExitCode===0&&composeInspect.Mounts.length===0,'Compose fixture did not execute cleanly');
  check('Acknowledged actual Compose run creates the built service and executes successfully',{containerId:composeContainer.id,project:composeProject,imageId:composeInspect.Image,exitCode:0,noMounts:true});
  assert(c.exceptions.length===0,'Unhandled native JavaScript exceptions');
  check('No unhandled JavaScript exceptions across actual import/build/run workflows');
  report.completed=true;
} catch(error){report.failure=String(error.stack??error);console.error(report.failure);}
finally{
  try{
    const current=await snapshot();
    const ownImages=current.images.filter(i=>[dockerImage?.id,composeImage?.id].includes(i.id));
    const ownedContainerNames=new Set([fixtureName,...(composeProject?[`${composeProject}-sample-1`]:[])]);
    for(const image of ownImages){
      assert(!baseline.images.some(i=>i.id===image.id),'Cleanup refuses a baseline image');
      const preview=await c.invoke('image_removal_preview',{id:image.id,deleteReferencingContainers:true});
      assert(preview.eligible&&preview.containers.every(row=>ownedContainerNames.has(row.name)&&['created','exited','dead'].includes(row.state)&&!baseline.containers.some(b=>b.id===row.id)),'Cleanup refuses non-fixture or active references');
      const result=await c.invoke('image_removal_execute',{token:preview.token,approved:true});
      assert(result.failed.length===0&&result.deleted.includes(image.id),'Fixture image/container cleanup failed');
    }
    const networks=(await c.invoke('networks_list')).filter(row=>composeProject&&row.name.startsWith(composeProject+'_')&&!baseline.networks.some(n=>n.id===row.id));
    for(const network of networks){const preview=await c.invoke('network_delete_preview',{id:network.id});const result=await c.invoke('network_delete_execute',{token:preview.token,approved:true});assert(result.deleted.includes(network.id)&&result.failed.length===0,'Fixture network cleanup failed');}
    const after=await snapshot();
    assert(JSON.stringify(signatures(after))===JSON.stringify(signatures(baseline)),'Existing resource ID sets changed or fixture resources remain');
    assert(after.containers.find(row=>row.name==='trusting_feistel')?.state==='running','Existing MongoDB is no longer running');
    report.cleanup={fixtureImagesRemoved:ownImages.map(i=>i.id),fixtureNetworksRemoved:networks.map(n=>n.id),baselineContainersImagesVolumesNetworksPreserved:true,mongoStillRunning:true,buildCacheAndHistoryRetained:true};
    check('Only exact isolated resources removed; all baseline resource sets preserved',report.cleanup);
  }catch(error){report.completed=false;report.cleanup={failure:String(error.stack??error)};}
  fs.writeFileSync('docs/results/file-import-native-e2e.json',JSON.stringify(report,null,2)+'\n');
  c.close();
}
if(!report.completed)process.exitCode=1;
