const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roleWorkState } = require('../dist/work-status');
const { newSession } = require('../dist/core');

test('role work distinguishes completion, approval, waiting, failure, and running precedence without changing tasks', () => {
  const s = newSession('Production');
  const owned = s.tasks.filter(t => t.roleId === 'architect');
  owned[0].status = 'review'; owned[0].result = 'Ready for review';
  let work = roleWorkState('architect', { tasks: s.tasks });
  assert.equal(work.state, 'idle', 'a future integration task is still pending');
  owned[1].status = 'approved';
  const before = JSON.stringify(s.tasks);
  work = roleWorkState('architect', { tasks: s.tasks });
  assert.equal(work.state, 'done'); assert.equal(work.label, 'Xong'); assert.match(work.detail, /Chờ duyệt/);
  assert.equal(JSON.stringify(s.tasks), before, 'green must never approve or change work');
  owned[0].status = 'blocked'; assert.equal(roleWorkState('architect', { tasks: s.tasks }).state, 'blocked');
  owned[1].status = 'running'; assert.equal(roleWorkState('architect', { tasks: s.tasks }).state, 'running');
  assert.equal(roleWorkState('art', { tasks: s.tasks }).state, 'idle', 'another engineer never inherits the running bar');
  owned[0].status = owned[1].status = 'assigned'; owned[1].startedAt = 50;
  assert.equal(roleWorkState('architect', { tasks: s.tasks, sessionState: 'paused' }).state, 'stopped');
});

test('QA/chat loading and replies are scoped to role/session, and later failure or Stop never reports an earlier success', () => {
  const messages = [{ role: 'user', at: 1, text: 'Question', delivery: 'answered' }];
  const input = { sessionId: 'a', roleChats: [{ roleId: 'qa', sessionId: 'a', messages }] };
  assert.equal(roleWorkState('qa', input).state, 'done');
  assert.equal(roleWorkState('qa', { ...input, sessionId: 'b' }).state, 'idle');
  assert.equal(roleWorkState('lead', input).state, 'idle');
  assert.equal(roleWorkState('qa', { ...input, chatBusy: [{ roleId: 'qa', sessionId: 'a' }] }).state, 'running');
  assert.equal(roleWorkState('qa', { ...input, chatBusy: [{ roleId: 'qa', sessionId: 'b' }] }).state, 'done');
  messages.push({ role: 'user', at: 2, text: 'Another', delivery: 'failed' });
  assert.equal(roleWorkState('qa', input).state, 'blocked');
  for (const delivery of ['stopped', 'interrupted', 'pending']) {
    messages.at(-1).delivery = delivery;
    assert.equal(roleWorkState('qa', input).state, 'stopped');
  }
});

test('image loading needs a verified scoped result; a feedback receipt is not a completed image', () => {
  const input = { sessionId: 'a', roleChats: [{ roleId: 'image', sessionId: 'a', messages: [
    { role: 'user', text: 'Feedback', at: 1, delivery: 'recorded' }
  ] }] };
  assert.equal(roleWorkState('image', input).state, 'idle');
  for (const [status, expected] of [['running', 'running'], ['done', 'done'], ['failed', 'blocked'], ['stopped', 'stopped']]) {
    const state = { ...input, imageWork: [{ sessionId: 'a', status, at: 2 }] };
    assert.equal(roleWorkState('image', state).state, expected);
    assert.equal(roleWorkState('image', { ...state, sessionId: 'b' }).state, 'idle');
  }
  assert.equal(roleWorkState('qa', { ...input, imageWork: [{ sessionId: 'a', status: 'running', at: 2 }] }).state, 'idle');
});

test('an older failed chat cannot cover a newer completed task', () => {
  const s = newSession('New work');
  const task = s.tasks.find(t => t.roleId === 'art'); task.status = 'review'; task.finishedAt = 30;
  const input = { sessionId: s.id, tasks: s.tasks, roleChats: [{ roleId: 'art', sessionId: s.id, messages: [
    { role: 'user', text: 'Old failure', at: 1, delivery: 'failed' }
  ] }] };
  assert.equal(roleWorkState('art', input).state, 'done');
});
