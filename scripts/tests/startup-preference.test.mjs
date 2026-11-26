import assert from 'node:assert/strict';
import test from 'node:test';
import {readEngineOnLaunch} from '../../src/startup-preference.ts';

test('engine starts on app launch by default while a saved opt-out and storage failure are respected', () => {
  assert.equal(readEngineOnLaunch({getItem:()=>null}),true);
  assert.equal(readEngineOnLaunch({getItem:()=> 'true'}),true);
  assert.equal(readEngineOnLaunch({getItem:()=> 'false'}),false);
  assert.equal(readEngineOnLaunch({getItem:()=> {throw Error('denied');}}),false);
});
