import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainerActionQueue } from '../../src/container-action-queue.ts';

test('unrelated rows queue while an action runs, and failures release the next row', async () => {
  let state, release;
  const calls = [], gate = new Promise(resolve => { release = resolve; });
  const queue = createContainerActionQueue(value => { state = value; });
  const first = queue.enqueue(['db'], async () => { calls.push('db'); await gate; throw Error('failed'); });
  const failed = assert.rejects(first, /failed/);
  const next = queue.enqueue(['web'], async () => { calls.push('web'); });
  await queue.enqueue(['db'], async () => { calls.push('duplicate'); });
  assert.equal(state.get('db'), 'running');
  assert.equal(state.get('web'), 'queued');
  assert.equal(state.has('unrelated'), false);
  assert.deepEqual(calls, ['db']);
  release();
  await failed; await next;
  assert.deepEqual(calls, ['db', 'web']);
  assert.equal(state.size, 0);
});

test('a project reserves every member until its sequential action finishes', async () => {
  let state, release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createContainerActionQueue(value => { state = value; });
  const project = queue.enqueue(['db', 'web'], async () => { await gate; });
  await Promise.resolve();
  assert.deepEqual([...state], [['db', 'running'], ['web', 'running']]);
  release(); await project;
  assert.equal(state.size, 0);
});
