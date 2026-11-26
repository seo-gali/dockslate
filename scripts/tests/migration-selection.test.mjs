import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMigrationInventory, selectMigrationItems } from '../../src/migration-selection.ts';

test('projects include actual image and volume dependencies without guessing from names', () => {
  const image = {id:'image',name:'web:latest',detail:''}, volume = {id:'data',name:'data',detail:''};
  const inventory = {sourceEngine:'source',targetEngine:'target',images:[image,{...image,name:'web:stable'},{id:'unused',name:'old',detail:''}],volumes:[volume,{id:'not-a-dependency',name:'alpha-db',detail:''}],containers:[
    {id:'a',name:'alpha-web',detail:'running',project:'alpha',image:'image',volumes:['data']},
    {id:'b',name:'beta-web',detail:'exited',project:'beta',image:'image',volumes:['data']},
  ]};
  const groups = groupMigrationInventory(inventory);
  assert.deepEqual(groups.map(g=>g.id),['project:alpha','project:beta','resources']);
  for (const group of groups.slice(0,2)) { assert.equal(group.images.length,2); assert.deepEqual(group.volumes,[volume]); }
  assert.deepEqual(groups[2].images.map(v=>v.id),['unused']);
  assert.deepEqual(groups[2].volumes.map(v=>v.id),['not-a-dependency']);
  const empty = {images:[],containers:[],volumes:[],stopRunning:true,startAfterImport:false};
  const first = selectMigrationItems(empty, groups[0], true), both = selectMigrationItems(first, groups[1], true);
  assert.deepEqual(both.images,['image']);assert.deepEqual(both.volumes,['data']);assert.deepEqual(both.containers,['a','b']);assert.equal(both.startAfterImport,false);
  assert.deepEqual(selectMigrationItems(both, inventory, false),empty);
});

test('standalone containers and resource-only projects remain selectable', () => {
  const groups = groupMigrationInventory({sourceEngine:'source',targetEngine:'target',images:[],volumes:[{id:'store',name:'store',detail:'local',project:'storage'}],containers:[{id:'a',name:'manual',detail:'exited'}]});
  assert.deepEqual(groups.map(g=>g.id),['project:storage','standalone']);
  assert.equal(groups[0].volumes[0].id,'store');assert.equal(groups[1].containers[0].id,'a');
});
