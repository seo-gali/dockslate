import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectNative } from './native-verification.mjs';

const session=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
if(!session.isolatedProfile)throw Error('An isolated native session is required.');
const c=await connectNative(session.portFile);
const report={observedAt:new Date().toISOString(),artifactSha256:session.sha256,native:true,backendInjected:false,checks:[],completed:false};
const created=[];
const check=name=>{report.checks.push({name,passed:true});console.log(JSON.stringify({name,passed:true}));};
try{
  const engine=await c.invoke('engine_status');assert.equal(engine.state,'connected');report.engineId=engine.id;
  const baseline=await c.invoke('containers_list');
  const image=(await c.invoke('images_list')).find(image=>image.tags.includes('busybox:1.37.0'));assert.ok(image);
  const prefix=`dockslate-recovery-e2e-${Date.now()}`;
  for(const suffix of ['blocker','source']){
    const result=await c.invoke('container_run',{imageId:image.id,name:prefix+'-'+suffix,ports:[{containerPort:8080,hostPort:null,protocol:'tcp'}],options:{command:['sh','-c','mkdir -p /www; printf recovery-ok >/www/index.html; printf root-preserved >/root/recovery-marker; exec httpd -f -p 8080 -h /www'],restartPolicy:'no'}});
    assert.equal(result.state,'running');created.push(result.id);
  }
  report.fixtureIds=created;
  const blocker=await c.invoke('container_inspect',{id:created[0]});
  const source=await c.invoke('container_edit_read',{id:created[1]});
  const port=Number(blocker.NetworkSettings.Ports['8080/tcp'][0].HostPort);assert.ok(port>0);
  const request={...source.settings,ports:source.settings.ports.map(value=>({...value,hostPort:port}))};
  const preview=await c.invoke('container_edit_preview',{request});assert.equal(preview.recreate,true);
  let error;
  try{await c.invoke('container_edit_execute',{token:preview.token,approved:true});}catch(failure){error=String(failure);}
  assert.ok(error,'A port held by another running fixture must reject recreation.');
  assert.ok(error.includes('기존 컨테이너의 이름과 실행 상태를 복구했습니다.'));
  const after=await c.invoke('container_edit_read',{id:created[1]});assert.equal(after.state,'running');assert.deepEqual(after.settings,source.settings);
  assert.equal((await c.invoke('container_inspect',{id:created[0]})).State.Running,true);
  assert.equal((await c.invoke('container_file_preview',{id:created[1],path:'/root/recovery-marker'})).content,'root-preserved');
  check('An occupied port fails recreation and restores the original container ID, name, settings, running state and files');
  await assert.rejects(c.invoke('container_edit_execute',{token:preview.token,approved:true}));
  check('A failed recreation still consumes its approval token');
  for(const id of created){const value=await c.invoke('container_inspect',{id});assert.equal(value.Image,image.id);assert.ok(value.Name.startsWith('/'+prefix+'-'));await c.invoke('container_action',{id,action:'stop'});}
  const deletion=await c.invoke('destructive_preview',{request:{kind:'container_delete',ids:created}});
  const deleted=await c.invoke('destructive_execute',{token:deletion.token,approved:true});assert.equal(deleted.failed.length,0);
  const afterList=await c.invoke('containers_list');for(const original of baseline){const actual=afterList.find(value=>value.id===original.id);assert.ok(actual);assert.equal(actual.name,original.name);assert.equal(actual.state,original.state);}
  check('Only the two verified BusyBox fixtures are removed; original containers are unchanged');
  report.databaseContentsRead=false;report.volumesCreated=0;report.volumesDeleted=0;report.savedImageRetained=true;report.completed=true;
}catch(error){report.failure=String(error.stack??error);console.error(error.stack);process.exitCode=1;}
finally{fs.writeFileSync('docs/results/container-edit-recovery-0.1.1.json',JSON.stringify(report,null,2)+'\n');c.close();}
