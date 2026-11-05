const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OFFICE_SEATS, officeActivity } = require('../dist/office-model');
const { defaultConfig, newSession } = require('../dist/core');

test('coordinator has a fixed head seat facing all eight workstations, regardless of role order', () => {
  const reordered = defaultConfig().roles.reverse();
  const seats = OFFICE_SEATS.map(seat => ({ ...seat, role: reordered.find(r => r.id === seat.roleId) }));
  const head = seats.find(s => s.head); const workers = seats.filter(s => !s.head);
  assert.equal(head.role.id, 'lead'); assert.equal(head.x, 0); assert.equal(head.rotation, Math.PI);
  assert.equal(workers.length, 9); assert.ok(workers.every(s => s.z > head.z && s.rotation === 0));
  assert.equal(new Set(workers.map(s => s.x)).size, 2);
  assert.equal(new Set(workers.map(s => s.z)).size, 5);
});

test('real work animation only follows running tasks, and progress only counts approvals', () => {
  const role = defaultConfig().roles[0], session = newSession('Production');
  let activity = officeActivity(role, session.tasks, false, true);
  assert.equal(activity.moving, false); assert.equal(activity.progress, 0);
  session.tasks[0].status = 'running'; activity = officeActivity(role, session.tasks, false, false);
  assert.equal(activity.moving, true); assert.equal(activity.actualRunning, true); assert.equal(activity.progress, 0);
  session.tasks[0].status = 'review'; assert.equal(officeActivity(role, session.tasks, false, true).moving, false);
  session.tasks[0].status = 'approved'; activity = officeActivity(role, session.tasks, false, false);
  assert.equal(activity.completed, 1); assert.equal(activity.progress, 0.5);
  assert.equal(activity.label, 'Chờ phụ thuộc');
});

test('demo motion never changes task data or usage and can be disabled', () => {
  const role = defaultConfig().roles[0], session = newSession('Preview'); const snapshot = JSON.stringify(session);
  assert.equal(officeActivity(role, session.tasks, true, true).preview, true);
  assert.equal(officeActivity(role, session.tasks, true, false).moving, false);
  assert.equal(JSON.stringify(session), snapshot);
  session.tasks[0].status = 'blocked'; assert.equal(officeActivity(role, session.tasks, true, true).moving, false);
  const empty = officeActivity(role, [], false, false);
  assert.equal(empty.label, 'Sẵn sàng'); assert.equal(empty.progress, 0); assert.equal(empty.total, 0);
});
