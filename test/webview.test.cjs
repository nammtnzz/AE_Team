const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { defaultConfig, demoSession, newSession } = require('../dist/core');

function setup(saved = {}, officeFactory) {
  const messages = [];
  const uiStates = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../media/index.html'), 'utf8'), { runScripts: 'outside-only' });
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message), getState: () => saved, setState: value => uiStates.push(value) });
  dom.window.AETeamOffice = officeFactory;
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../media/views.js'), 'utf8'));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/work-status.js'), 'utf8'), dom.getInternalVMContext());
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../media/board.js'), 'utf8'));
  const session = demoSession();
  const state = { type: 'state', config: defaultConfig(), sessions: [session], selectedId: session.id, workspace: 'Unity', hasKey: false, active: 0 };
  const update = value => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: value }));
  update(state);
  return { dom, doc: dom.window.document, messages, update, state, uiStates };
}

test('every position has a work bar that switches from running to done before approval and resets for new work', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const session = newSession('Loading states'); state.sessions = [session]; state.selectedId = session.id;
  const task = session.tasks.find(item => item.roleId === 'gameplay');
  const bar = () => doc.querySelector('.role-card[data-id="gameplay"] .work-indicator');
  task.status = 'running'; update(state);
  assert.equal(doc.querySelectorAll('.role-card .work-indicator').length, 9);
  assert.equal(bar().dataset.work, 'running'); assert.equal(bar().querySelector('.work-label').textContent, 'Đang xử lý');
  assert.equal(bar().querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'), false);
  doc.querySelector('.role-card[data-id="gameplay"]').click();
  assert.equal(doc.querySelector('#detail>.work-indicator').dataset.work, 'running');
  task.status = 'review'; update(state);
  assert.equal(bar().dataset.work, 'done'); assert.equal(bar().querySelector('.work-label').textContent, 'Xong');
  assert.equal(bar().querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100');
  assert.match(bar().querySelector('.work-detail').textContent, /Chờ duyệt/);
  assert.match(doc.querySelector('#detail>.work-indicator').textContent, /Chờ duyệt/);
  assert.equal(task.status, 'review');
  const next = { ...task, id: 'gameplay-next', status: 'assigned', title: 'Next work' };
  session.tasks.push(next); update(state); assert.equal(bar().dataset.work, 'idle');
  next.status = 'running'; update(state); assert.equal(bar().dataset.work, 'running');
  next.status = 'approved'; update(state); assert.equal(bar().dataset.work, 'done');
  task.status = 'approved'; update(state); assert.equal(bar().querySelector('.work-detail'), null);
});

test('Office roster, profile and renderer share the selected-session work state', t => {
  const updates = [];
  const { dom, doc, update, state } = setup({ tab: 'office', officeRole: 'qa' }, () => ({ update: value => updates.push(value), camera() {}, setActive() {}, dispose() {} }));
  t.after(() => dom.window.close());
  state.chatBusy = [{ roleId: 'qa', sessionId: state.selectedId }]; update(state);
  const rosterBar = () => doc.querySelector('.office-roster-seat[data-id="qa"] .work-indicator');
  assert.equal(doc.querySelectorAll('.office-roster-seat .work-indicator').length, 9);
  assert.equal(rosterBar().dataset.work, 'running');
  assert.equal(doc.querySelector('.office-profile .work-indicator').dataset.work, 'running');
  assert.equal(updates.at(-1).workStatuses.qa.state, 'running');
  state.chatBusy = [];
  state.roleChats = [{ roleId: 'qa', sessionId: state.selectedId, messages: [{ role: 'user', text: 'Question', at: 20, delivery: 'answered' }, { role: 'assistant', text: 'Answer', at: 21 }] }]; update(state);
  assert.equal(rosterBar().dataset.work, 'done');
  assert.equal(doc.querySelector('.office-profile .work-label').textContent, 'Xong');
  assert.equal(updates.at(-1).workStatuses.qa.state, 'done');
});

test('QA loading and failures stay scoped to the selected session with escaped error details', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  state.chatBusy = [{ roleId: 'qa', sessionId: state.selectedId }]; state.qa = { busy: true }; update(state);
  doc.querySelector('.role-card[data-id="qa"]').click();
  assert.equal(doc.querySelector('#detail>.work-indicator').dataset.work, 'running');
  assert.match(doc.querySelector('.role-work-summary').textContent, /1 đang làm/);
  const other = newSession('Different session'); state.sessions.push(other); state.selectedId = other.id; update(state);
  doc.querySelector('.role-card[data-id="qa"]').click();
  assert.equal(doc.querySelector('#detail>.work-indicator').dataset.work, 'idle');
  assert.match(doc.querySelector('.role-work-summary').textContent, /0 đang làm/);
  const error = '<img src=x onerror="window.pwned=true">';
  state.roleChats = [{ roleId: 'qa', sessionId: other.id, messages: [{ role: 'user', text: 'Question', at: 30, delivery: 'failed', error }] }]; update(state);
  const bar = doc.querySelector('#detail>.work-indicator'); assert.equal(bar.dataset.work, 'blocked');
  assert.match(bar.textContent, /Cần xử lý/); assert.ok(bar.textContent.includes(error));
  assert.equal(doc.querySelectorAll('img').length, 0); assert.equal(dom.window.pwned, undefined);
});

test('stopped work stays incomplete and loading animations pause with panel and document visibility', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  const session = newSession('Paused work'); state.sessions = [session]; state.selectedId = session.id;
  session.state = 'paused'; session.tasks[0].startedAt = 10; update(state);
  const bar = doc.querySelector('.role-card[data-id="lead"] .work-indicator');
  assert.equal(bar.dataset.work, 'stopped'); assert.equal(bar.querySelector('.work-label').textContent, 'Đã dừng');
  update({ type: 'visibility', visible: false }); assert.equal(doc.body.classList.contains('work-paused'), true);
  update({ type: 'visibility', visible: true }); assert.equal(doc.body.classList.contains('work-paused'), false);
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true }); doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(doc.body.classList.contains('work-paused'), true);
});

test('board renders 10 roles, 5 columns, 9 tasks and explicit demo label', t => {
  const { dom, doc, messages } = setup(); t.after(() => dom.window.close());
  assert.equal(doc.querySelectorAll('.role-card').length, 9);
  assert.match(doc.querySelectorAll('.role-specialty')[4].textContent, /FX · SFX/);
  assert.equal(doc.querySelectorAll('.column').length, 5);
  assert.equal(doc.querySelectorAll('.task').length, 9);
  assert.equal(doc.getElementById('demoNotice').hidden, false);
  assert.equal(doc.getElementById('runBtn').disabled, true);
  assert.equal(messages[0].type, 'ready');
});
test('task detail, approval, view tabs and configuration send expected messages', t => {
  const { dom, doc, messages } = setup(); t.after(() => dom.window.close());
  doc.querySelector('[data-action="task"][data-id="art"]').click();
  assert.equal(doc.getElementById('detail').hidden, false);
  doc.querySelector('[data-action="approve"]').click();
  assert.equal(messages.at(-1).type, 'approve');
  doc.querySelector('[data-tab="stats"]').click();
  assert.equal(doc.getElementById('statsView').hidden, false);
  assert.equal(doc.getElementById('boardView').hidden, true);
  doc.getElementById('configBtn').click();
  assert.equal(doc.querySelectorAll('.role-setting').length, 10);
  doc.getElementById('openaiUrl').value = 'https://example.com/v1';
  doc.getElementById('saveConfig').click();
  assert.equal(messages.at(-1).config.openaiBaseUrl, 'https://example.com/v1');
});
test('model results, task titles and session names are HTML-escaped', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const payload = '<img src=x onerror="window.pwned=true">';
  state.sessions[0].name = payload;
  state.sessions[0].tasks[0].title = payload;
  state.sessions[0].tasks[0].result = '<script>window.pwned=true</script>';
  update(state);
  doc.querySelector('[data-tab="results"]').click();
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.equal(dom.window.pwned, undefined);
  assert.ok(doc.getElementById('resultsView').textContent.includes('<script>'));
});
test('new live session enables run but never auto-starts requests', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  const session = newSession('A real task');
  state.sessions = [session]; state.selectedId = session.id; update(state);
  assert.equal(doc.getElementById('runBtn').disabled, false);
  assert.ok(!messages.some(m => m.type === 'run'));
  doc.getElementById('runBtn').click();
  assert.equal(messages.at(-1).type, 'run');
});

test('AE tab reviews escaped plans, blocks disconnected execution, and sends explicit actions', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  state.ae = { status: { activeTools: 43, connection: { fresh: false } }, plans: [{ id: 'p1', title: '<img src=x>', reason: 'Review',
    state: 'proposed', plan: { schema: 'aect-functions/v1', steps: [{ function: 'team.project.inspect', args: {} }] } }] };
  update(state);
  doc.getElementById('aeOpenBtn').click();
  assert.equal(doc.getElementById('aeView').hidden, false);
  assert.equal(messages.at(-1).type, 'aeRefresh');
  assert.equal(doc.querySelector('[data-action="aeExecute"]').disabled, true);
  assert.equal(doc.querySelectorAll('img').length, 0);
  state.ae.status.connection = { fresh: true, state: 'running', revisionMatches: true }; update(state);
  doc.querySelector('[data-action="aeExecute"]').click();
  assert.equal(messages.at(-1).type, 'aeExecute'); assert.equal(messages.at(-1).id, 'p1');
  state.ae.hold = true; update(state);
  assert.equal(doc.querySelector('[data-action="aeExecute"]').disabled, true);
  assert.equal(doc.getElementById('aeHold').hidden, false);
  doc.getElementById('aeStage').click();
  assert.equal(messages.at(-1).type, 'aeStage');
  assert.ok(JSON.parse(messages.at(-1).planJson).steps.length);
});

test('all seven views switch exclusively in reference order without API calls', t => {
  const { dom, doc, messages } = setup(); t.after(() => dom.window.close());
  const tabs = [...doc.querySelectorAll('[data-tab]')];
  assert.deepEqual(tabs.map(x => x.dataset.tab), ['office', 'board', 'results', 'timeline', 'workflow', 'stats', 'ae']);
  for (const tab of tabs) {
    tab.click();
    assert.equal(tab.getAttribute('aria-selected'), 'true');
    assert.deepEqual([...doc.querySelectorAll('.view')].filter(x => !x.hidden).map(x => x.id), [tab.dataset.tab + 'View']);
  }
  assert.deepEqual(messages.map(m => m.type), ['ready']);
});

test('results filter real deliverables, expose file diff and scope plans to selected session', t => {
  const { dom, doc, update, state, messages, uiStates } = setup(); t.after(() => dom.window.close());
  const s = newSession('Deliverables'); state.sessions = [s]; state.selectedId = s.id;
  const task = s.tasks[0]; task.status = 'review'; task.result = 'Alpha delivery';
  s.proposals = [{ id: 'file1', taskId: task.id, path: 'notes.md', reason: 'Document', applied: false }];
  state.ae = { plans: [
    { id: 'ok', sessionId: s.id, taskId: task.id, title: 'My AE plan', state: 'success', plan: { steps: [] } },
    { id: 'other', sessionId: 'another', taskId: task.id, title: 'Foreign plan', state: 'success', plan: { steps: [] } }
  ] };
  update(state); doc.querySelector('[data-tab="results"]').click();
  assert.equal(doc.querySelectorAll('.result-card').length, 1);
  assert.ok(doc.getElementById('resultsView').textContent.includes('My AE plan'));
  assert.ok(!doc.getElementById('resultsView').textContent.includes('Foreign plan'));
  doc.querySelector('.asset-row [data-action="preview"]').click();
  assert.equal(messages.at(-1).proposalId, 'file1');
  const form = doc.getElementById('resultFilters'); form.elements.query.value = 'missing';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(doc.querySelectorAll('.result-card').length, 0);
  assert.equal(uiStates.at(-1).resultFilter.query, 'missing');
});

test('timeline sorts timestamps and combines role, kind and text filters', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const s = newSession('Timeline'); state.sessions = [s]; state.selectedId = s.id;
  s.events = [
    { id: 'e2', at: 200000, kind: 'error', text: 'Late blocker', taskId: s.tasks[0].id },
    { id: 'e1', at: 100000, kind: 'start', text: 'Early start', taskId: s.tasks[1].id },
    { id: 'e3', at: 300000, kind: 'error', text: 'Newest blocker', taskId: s.tasks[0].id }
  ];
  update(state); doc.querySelector('[data-tab="timeline"]').click();
  assert.deepEqual([...doc.querySelectorAll('.activity-row p')].map(x => x.textContent), ['Newest blocker', 'Late blocker', 'Early start']);
  let form = doc.getElementById('timelineFilters');
  form.elements.order.value = 'oldest'; form.elements.kind.value = 'error'; form.elements.role.value = s.tasks[0].roleId; form.elements.query.value = 'blocker';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual([...doc.querySelectorAll('.activity-row p')].map(x => x.textContent), ['Late blocker', 'Newest blocker']);
});

test('workflow follows actual dependencies and approval state; keyboard opens task', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const s = newSession('DAG'); state.sessions = [s]; state.selectedId = s.id; update(state);
  doc.querySelector('[data-tab="workflow"]').click();
  assert.equal(doc.querySelectorAll('.flow-node').length, s.tasks.length);
  assert.equal(doc.querySelectorAll('.flow-edge').length, s.tasks.reduce((n, task) => n + task.dependencies.length, 0));
  assert.equal(doc.querySelectorAll('.flow-edge.unlocked').length, 0);
  assert.ok(doc.getElementById('workflowView').textContent.includes('1 task sẵn sàng'));
  s.tasks[0].status = 'approved'; update(state);
  assert.equal(doc.querySelectorAll('.flow-edge.unlocked').length, s.tasks.filter(task => task.dependencies.includes(s.tasks[0].id)).length);
  const node = doc.querySelector('.flow-node');
  node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(doc.getElementById('detail').hidden, false);
  assert.ok(doc.getElementById('detail').textContent.includes(s.tasks[0].title));
});

test('stats use reported usage and measured duration, and demo has no fabricated tokens', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  doc.querySelector('[data-tab="stats"]').click();
  assert.deepEqual([...doc.querySelectorAll('#statsView .stats-summary strong')].map(x => x.textContent).slice(0, 3), ['0', '0', '0']);
  const s = newSession('Measured'); state.sessions = [s]; state.selectedId = s.id;
  Object.assign(s.tasks[0], { requestCount: 3, inputTokens: 1234, outputTokens: 432, attempts: 2, startedAt: 1000, finishedAt: 62000 });
  update(state);
  const values = [...doc.querySelectorAll('#statsView .stats-summary strong')].map(x => x.textContent);
  assert.deepEqual(values.slice(0, 3), ['3', '1.234', '432']);
  assert.ok(values.includes('1 phút 1 giây'));
  assert.ok(Number(doc.querySelector('.chart-input').getAttribute('width')) > 0);
  assert.equal(doc.querySelectorAll('#statsView tbody tr').length, 10);
});

test('Office mounts once, selects a role, restores camera and suspends when hidden', t => {
  const calls = { mounted: 0, updates: [], active: [], camera: [], disposed: 0 }; let pick;
  const factory = (host, onPick) => { calls.mounted++; pick = onPick; return {
    update: value => calls.updates.push(value), setActive: value => calls.active.push(value), camera: value => calls.camera.push(value), dispose: () => calls.disposed++
  }; };
  const { dom, doc, update, state, messages, uiStates } = setup({ tab: 'office', camera: 'top', focus: true }, factory); t.after(() => dom.window.close());
  assert.equal(calls.mounted, 1); assert.equal(calls.updates.length, 1);
  assert.equal(calls.camera[0], 'top'); assert.equal(calls.active.at(-1), true);
  assert.equal(calls.updates.at(-1).previewMotion, true);
  doc.getElementById('officeMotionBtn').click();
  assert.equal(calls.updates.at(-1).previewMotion, false);
  assert.equal(uiStates.at(-1).officePreview, false);
  assert.equal(doc.querySelectorAll('.office-roster-seat').length, 9);
  assert.ok(doc.body.classList.contains('focus'));
  pick('art'); assert.equal(calls.updates.at(-1).selectedRole, 'art');
  assert.equal(uiStates.at(-1).officeRole, 'art');
  doc.querySelector('.office-task').click(); assert.equal(doc.getElementById('detail').hidden, false);
  update({ type: 'visibility', visible: false }); assert.equal(calls.active.at(-1), false);
  update({ type: 'visibility', visible: true }); assert.equal(calls.active.at(-1), true);
  doc.querySelector('[data-tab="board"]').click(); assert.equal(calls.active.at(-1), false);
  doc.querySelector('[data-tab="office"]').click(); update(state); assert.equal(calls.mounted, 1);
  doc.querySelector('[data-action="officeCamera"][data-id="front"]').click(); assert.equal(calls.camera.at(-1), 'front');
  doc.querySelector('[data-action="officeReset"]').click(); assert.equal(calls.disposed, 1); assert.equal(calls.mounted, 2);
  assert.deepEqual(messages.map(m => m.type), ['ready']);
  dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(calls.disposed, 2);
});

test('live Office never enables demo motion or sends a run request', t => {
  const calls = [];
  const { dom, doc, update, state, messages } = setup({ tab: 'office' }, () => ({ update: value => calls.push(value), camera() {}, setActive() {}, dispose() {} }));
  t.after(() => dom.window.close()); const session = newSession('Real session'); state.sessions = [session]; state.selectedId = session.id; update(state);
  assert.equal(doc.getElementById('officeMotionBtn').hidden, true);
  assert.equal(calls.at(-1).previewMotion, false);
  assert.equal(calls.at(-1).demo, false);
  assert.deepEqual(messages.map(m => m.type), ['ready']);
});

test('Office retains accessible roster when WebGL cannot start', t => {
  const { dom, doc, messages } = setup({ tab: 'office' }, () => { throw new Error('GPU unavailable'); }); t.after(() => dom.window.close());
  assert.equal(doc.getElementById('officeGpuNotice').hidden, false);
  assert.ok(doc.getElementById('officeGpuNotice').textContent.includes('GPU unavailable'));
  doc.querySelector('[data-action="officeRole"][data-id="reviewer"]').click();
  assert.ok(doc.getElementById('officeRoleDetail').textContent.includes('Kiểm định & xuất phim'));
  assert.deepEqual(messages.map(m => m.type), ['ready']);
});

test('provider changes filter model choices, incorporate gateway IDs and save custom IDs', t => {
  const { dom, doc, update, messages } = setup(); t.after(() => dom.window.close());
  doc.getElementById('configBtn').click();
  const row = doc.querySelector('[data-role-id="lead"]');
  const protocol = row.querySelector('[data-field="protocol"]'), model = row.querySelector('[data-field="model"]');
  assert.ok([...model.options].some(o => o.value === 'claude-haiku-5-5'));
  assert.ok(![...model.options].some(o => /^gpt-/.test(o.value)));
  update({ type: 'models', models: ['claude-custom', 'gpt-custom', 'gpt-image-secret', '<img src=x>'] });
  assert.ok([...model.options].some(o => o.value === 'claude-custom'));
  protocol.value = 'responses'; protocol.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(model.value, 'gpt-6.1-sol');
  assert.ok([...model.options].some(o => o.value === 'gpt-custom'));
  assert.ok(![...model.options].some(o => /claude|image/.test(o.value)));
  model.value = '__custom__'; model.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const custom = row.querySelector('[data-field="customModel"]'); assert.equal(custom.hidden, false); custom.value = 'my-codex-id';
  doc.getElementById('saveConfig').click();
  assert.equal(messages.at(-1).config.roles[0].model, 'my-codex-id');
  assert.equal(messages.at(-1).config.roles[0].protocol, 'responses');
});

test('image generation stays explicit and QA card opens its chat directly with target-scoped send and Stop', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  doc.querySelector('.role-card[data-id="art"]').click();
  assert.equal(doc.getElementById('imageOverlay').hidden, true);
  doc.querySelector('#detail [data-action="openImage"]').click();
  assert.equal(doc.getElementById('imageOverlay').hidden, false);
  state.imageBusy = true; update(state);
  doc.getElementById('imageStop').click(); assert.equal(messages.at(-1).target, 'image');
  doc.getElementById('closeImage').click();
  doc.querySelector('.role-card[data-id="qa"]').click();
  assert.equal(doc.getElementById('qaOverlay').hidden, true);
  assert.equal(doc.querySelector('#detail [data-action="openQa"]'), null);
  const composer = doc.querySelector('#detail [data-role-chat-input]');
  assert.equal(composer.dataset.roleId, 'qa'); assert.equal(doc.activeElement, composer);
  composer.value = 'Tôi muốn thay màu';
  doc.querySelector('#detail [data-role-chat-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'roleChatSend', roleId: 'qa', sessionId: state.selectedId, text: 'Tôi muốn thay màu' });
  state.chatBusy = [{ roleId: 'qa', sessionId: state.selectedId }];
  state.roleChats = [{ roleId: 'qa', sessionId: state.selectedId, messages: [{ role: 'assistant', model: 'claude-haiku-5-5', text: '<img src=x onerror=boom>' }] }]; update(state);
  assert.equal(doc.querySelectorAll('#detail .role-chat-messages img').length, 0);
  assert.ok(doc.querySelector('#detail .role-chat-messages').textContent.includes('<img'));
  assert.equal(doc.querySelector('#detail [type="submit"]').disabled, true);
  doc.querySelector('#detail [data-action="roleChatStop"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'roleChatStop', roleId: 'qa', sessionId: state.selectedId });
  doc.getElementById('closeQa').click(); doc.querySelector('#detail [data-action="closeDetail"]').click();
  doc.getElementById('qaBtn').click();
  assert.equal(doc.querySelector('#detail [data-role-chat-input]').dataset.roleId, 'qa');
});

test('subagent detail identifies its parent and parent links open the child', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const s = state.sessions[0], parent = s.tasks[0];
  const child = { ...s.tasks[2], id: 'child-art', parentTaskId: parent.id, title: 'Subagent palette', dependencies: [] };
  s.tasks.push(child); parent.dependencies.push(child.id); update(state);
  doc.querySelector('[data-action="task"][data-id="brief"]').click();
  const link = doc.querySelector('#detail [data-action="task"][data-id="child-art"]'); assert.ok(link); link.click();
  assert.match(doc.getElementById('detail').textContent, /Subagent của:/);
  assert.ok(doc.getElementById('detail').textContent.includes(parent.title));
});

test('engineer cards show owned tasks with running tasks first, including subagents, instead of model settings', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  const session = newSession('Current production'); state.sessions = [session]; state.selectedId = session.id;
  const task = session.tasks.find(t => t.roleId === 'architect'); task.status = 'running'; task.prompt = 'Khảo sát cấu trúc comp';
  const child = { ...task, id: 'architect-sub', title: 'Tích hợp theo PO', parentTaskId: 'brief', status: 'review', result: 'Bàn giao thật' };
  session.tasks.unshift(child); update(state);
  const priorMessages = messages.length;
  doc.querySelector('.role-card[data-id="architect"]').click();
  assert.equal(doc.getElementById('overlay').hidden, true);
  assert.equal(doc.getElementById('detail').hidden, false);
  const links = [...doc.querySelectorAll('#detail .role-work-task')];
  assert.equal(links[0].dataset.id, task.id);
  assert.equal(links.length, session.tasks.filter(t => t.roleId === 'architect').length);
  assert.ok(links.some(link => link.dataset.id === child.id));
  assert.ok(links.every(link => session.tasks.find(t => t.id === link.dataset.id).roleId === 'architect'));
  assert.match(doc.getElementById('detail').textContent, /Khảo sát cấu trúc comp/);
  assert.equal(messages.length, priorMessages);
  doc.getElementById('configBtn').click(); assert.equal(doc.getElementById('overlay').hidden, false);
});

test('role work updates from state, opens task details and returns without overwriting the selected task', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const session = state.sessions[0], task = session.tasks.find(t => t.roleId === 'gameplay');
  doc.querySelector('.role-card[data-id="gameplay"]').click();
  task.status = 'running'; task.result = 'Kết quả mới theo task'; update(state);
  assert.match(doc.getElementById('detail').textContent, /1 đang làm/);
  assert.match(doc.getElementById('detail').textContent, /Kết quả mới theo task/);
  doc.querySelector('#detail .role-work-task').click(); update(state);
  assert.equal(doc.querySelector('#detail h2').textContent, task.title);
  assert.match(doc.getElementById('detail').textContent, /Kết quả bàn giao/);
  doc.querySelector('#detail [data-action="role"]').click();
  assert.equal(doc.querySelector('#detail h2').textContent, 'Diễn hoạt');
  doc.querySelector('#detail [data-action="closeDetail"]').click(); update(state);
  assert.equal(doc.getElementById('detail').hidden, true);
  doc.querySelector('.role-card[data-id="gameplay"]').click();
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); update(state);
  assert.equal(doc.getElementById('detail').hidden, true);
});

test('role task prompts, results, parent titles and session names are escaped', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const payload = '<img src=x onerror="window.pwned=true">';
  const session = state.sessions[0], task = session.tasks.find(t => t.roleId === 'art');
  session.name = payload; session.tasks[0].title = payload;
  Object.assign(task, { title: payload, prompt: payload, result: payload, error: payload, parentTaskId: session.tasks[0].id });
  update(state); doc.querySelector('.role-card[data-id="art"]').click();
  assert.equal(doc.querySelectorAll('#detail img').length, 0);
  assert.ok(doc.getElementById('detail').textContent.includes(payload));
  assert.equal(dom.window.pwned, undefined);
});

test('every member including PO opens a composer immediately alongside their tasks without sending a request', t => {
  const { dom, doc, messages, state } = setup(); t.after(() => dom.window.close());
  const before = messages.length;
  for (const role of state.config.roles.filter(r => r.id !== 'image')) {
    doc.querySelector('.role-card[data-id="' + role.id + '"]').click();
    const composer = doc.querySelector('#detail [data-role-chat-input]');
    assert.equal(composer.dataset.roleId, role.id);
    assert.equal(composer.dataset.sessionId, state.selectedId);
    assert.equal(doc.activeElement, composer);
    assert.equal(doc.querySelectorAll('#detail .role-work-task').length, state.sessions[0].tasks.filter(task => task.roleId === role.id).length);
    assert.equal(doc.querySelector('#detail [data-action="openQa"]'), null);
  }
  assert.equal(messages.length, before);
});

test('role histories and busy state stay isolated by member and session; delivery errors are escaped', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  const payload = '<img src=x onerror=boom>';
  state.roleChats = [
    { roleId: 'lead', sessionId: state.selectedId, messages: [{ role: 'user', text: 'PO feedback', delivery: 'failed', error: payload }] },
    { roleId: 'art', sessionId: state.selectedId, messages: [{ role: 'assistant', text: 'Art response', model: 'art-model' }] },
    { roleId: 'lead', sessionId: 'other-session', messages: [{ role: 'user', text: 'Other session secret' }] }
  ];
  state.chatBusy = [{ roleId: 'art', sessionId: state.selectedId }]; update(state);
  doc.querySelector('.role-card[data-id="lead"]').click();
  let history = doc.querySelector('#detail .role-chat-messages');
  assert.match(history.textContent, /PO feedback/); assert.match(history.textContent, /Chưa nhận được trả lời/);
  assert.ok(history.textContent.includes(payload)); assert.equal(history.querySelector('img'), null);
  assert.ok(!history.textContent.includes('Other session secret')); assert.ok(!history.textContent.includes('Art response'));
  assert.equal(doc.querySelector('#detail [type="submit"]').disabled, false);
  doc.querySelector('.role-card[data-id="art"]').click();
  history = doc.querySelector('#detail .role-chat-messages');
  assert.match(history.textContent, /Art response/); assert.match(history.textContent, /art-model/);
  assert.ok(!history.textContent.includes('PO feedback'));
  assert.equal(doc.querySelector('#detail [type="submit"]').disabled, true);
  doc.querySelector('#detail [data-action="roleChatStop"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'roleChatStop', roleId: 'art', sessionId: state.selectedId });
});

test('drafts, focus and caret survive state updates and remain separate across members and sessions', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const firstId = state.selectedId;
  doc.querySelector('.role-card[data-id="lead"]').click();
  let input = doc.querySelector('#detail [data-role-chat-input]');
  input.value = 'Draft for PO'; input.setSelectionRange(2, 7, 'backward');
  state.sessions[0].tasks[0].status = 'running'; update(state);
  input = doc.querySelector('#detail [data-role-chat-input]');
  assert.equal(input.value, 'Draft for PO'); assert.equal(doc.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7); assert.equal(input.selectionDirection, 'backward');
  doc.querySelector('.role-card[data-id="art"]').click();
  input = doc.querySelector('#detail [data-role-chat-input]'); assert.equal(input.value, ''); input.value = 'Draft for art';
  doc.querySelector('.role-card[data-id="lead"]').click();
  assert.equal(doc.querySelector('#detail [data-role-chat-input]').value, 'Draft for PO');
  const next = newSession('Second session'); state.sessions.push(next); update({ ...state, selectedId: next.id });
  assert.equal(doc.getElementById('detail').hidden, true);
  doc.querySelector('.role-card[data-id="lead"]').click();
  input = doc.querySelector('#detail [data-role-chat-input]'); assert.equal(input.value, ''); input.value = 'Second PO draft';
  update({ ...state, selectedId: firstId }); doc.querySelector('.role-card[data-id="lead"]').click();
  assert.equal(doc.querySelector('#detail [data-role-chat-input]').value, 'Draft for PO');
  doc.querySelector('.role-card[data-id="art"]').click(); assert.equal(doc.querySelector('#detail [data-role-chat-input]').value, 'Draft for art');
});

test('chat without a session sends an explicit empty target, blocks duplicate submits and clears only the sent draft', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  state.sessions = []; state.selectedId = ''; update(state);
  doc.querySelector('.role-card[data-id="lead"]').click();
  let input = doc.querySelector('#detail [data-role-chat-input]'); input.value = 'CEO asks PO';
  const submit = () => doc.querySelector('#detail [data-role-chat-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  submit();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'roleChatSend', roleId: 'lead', sessionId: '', text: 'CEO asks PO' });
  assert.equal(doc.querySelector('#detail [data-role-chat-input]').value, '');
  input = doc.querySelector('#detail [data-role-chat-input]'); input.value = 'Do not duplicate';
  const sent = messages.length; submit(); assert.equal(messages.length, sent);
  update({ type: 'toast', kind: 'error', text: 'Connection failed' });
  assert.equal(doc.querySelector('#detail [type="submit"]').disabled, false);
  assert.equal(doc.querySelector('#detail [data-role-chat-input]').value, 'Do not duplicate');
  assert.match(doc.querySelector('#detail .role-chat').textContent, /không tự chạy lại tác vụ/);
});

test('new chat replies follow the bottom while reading older messages keeps the reading position', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  // JSDOM has no layout; provide viewport/content heights to exercise the real scrolling behavior.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('role-chat-messages') ? 240 : 0; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList.contains('role-chat-messages') ? this.querySelectorAll('article').length * 120 : 0; } });
  const history = Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', text: 'Message ' + i }));
  state.roleChats = [{ roleId: 'lead', sessionId: state.selectedId, messages: history }]; update(state);
  doc.querySelector('.role-card[data-id="lead"]').click();
  let log = doc.querySelector('#detail .role-chat-messages');
  assert.ok(log.scrollTop >= log.scrollHeight - log.clientHeight);
  log.scrollTop = 120; history.push({ role: 'assistant', text: 'New reply while reading history' }); update(state);
  log = doc.querySelector('#detail .role-chat-messages'); assert.equal(log.scrollTop, 120);
  log.scrollTop = log.scrollHeight - log.clientHeight - 5;
  history.push({ role: 'assistant', text: 'Latest reply' }); update(state);
  log = doc.querySelector('#detail .role-chat-messages');
  assert.ok(log.scrollTop >= log.scrollHeight - log.clientHeight);
  assert.match(log.lastElementChild.textContent, /Latest reply/);
});

test('PO detail shows the delivery report; engineers show scope, checks, single Stop and a per-position model switch', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  const session = newSession('Delivery'); state.sessions = [session]; state.selectedId = session.id;
  const parent = session.tasks[0];
  const child = { ...session.tasks[2], id: 'sub-art', parentTaskId: parent.id, status: 'running', dependencies: [], scope: ['notes', 'comp:Main'],
    acceptance: [{ id: 'palette', description: 'Palette <b>3 màu</b>', verification: 'analysis' }], checks: [{ id: 'palette', status: 'pass', evidence: 'xanh trắng đen' }] };
  session.tasks.push(child);
  state.deliveries = { [parent.id]: { taskId: parent.id, ready: false, engineers: [{ taskId: child.id }], files: [{ path: 'notes/a.md', taskId: child.id, state: 'proposed' }], aePlans: [],
    checks: [{ id: 'palette', taskId: child.id, title: child.title, description: 'Palette <b>3 màu</b>', verification: 'analysis', status: 'pass', verified: true }],
    incomplete: [{ title: 'notes/a.md', detail: 'đề xuất file chưa áp dụng' }] } };
  state.usage = { calls: 4, tokens: 900, input: 600, output: 300, cost: 0, unpriced: 0, priced: false, budget: { maxCalls: 10, maxTokens: 0 } };
  update(state);
  doc.querySelector('[data-action="task"][data-id="' + parent.id + '"]').click();
  const report = doc.querySelector('.delivery-report');
  assert.match(report.textContent, /Còn 1 mục/); assert.match(report.textContent, /notes\/a\.md/);
  assert.equal(report.querySelector('b'), null); // escaped
  doc.querySelector('[data-action="task"][data-id="sub-art"]').click();
  assert.match(doc.getElementById('detail').textContent, /comp:Main/);
  assert.equal(doc.querySelector('.check-list li').className, 'verified');
  doc.querySelector('[data-action="stopTask"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'stopTask', taskId: 'sub-art' });
  doc.querySelector('.role-card[data-id="camera_ui"]').click();
  const form = doc.querySelector('[data-model-switch]');
  form.elements.model.value = 'gpt-6.1-sol'; form.querySelector('button').click();
  assert.equal(messages.filter(m => m.type === 'setRoleModel').length, 0); // unchanged model is not sent
  doc.querySelector('.role-card[data-id="architect"]').click();
  const architect = doc.querySelector('[data-model-switch]');
  architect.elements.model.value = 'claude-sonnet-5'; architect.querySelector('button').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'setRoleModel', roleId: 'architect', model: 'claude-sonnet-5' });
});

test('config modal round-trips budget and prices and rejects invalid price JSON locally', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  state.config = { ...defaultConfig(), budget: { maxCalls: 40, maxTokens: 0 }, prices: { 'claude-opus-5-5': { input: 15, output: 75 } } }; update(state);
  doc.getElementById('configBtn').click();
  assert.equal(doc.getElementById('budgetCalls').value, '40');
  assert.match(doc.getElementById('prices').value, /claude-opus-5-5/);
  doc.getElementById('prices').value = '{ bad'; doc.getElementById('saveConfig').click();
  assert.equal(messages.filter(m => m.type === 'saveConfig').length, 0);
  assert.match(doc.getElementById('toast').textContent, /JSON/);
  doc.getElementById('prices').value = ''; doc.getElementById('budgetTokens').value = '50000'; doc.getElementById('saveConfig').click();
  const saved = JSON.parse(JSON.stringify(messages.find(m => m.type === 'saveConfig').config));
  assert.deepEqual(saved.budget, { maxCalls: 40, maxTokens: 50000 }); assert.deepEqual(saved.prices, {});
});

test('Skill & MCP settings toggle servers manually and the MCP queue requires an enabled server', t => {
  const { dom, doc, update, state, messages } = setup({ tab: 'ae' }); t.after(() => dom.window.close());
  state.toolbox = { enabled: [], snapshot: { scannedAt: 1, excluded: ['codex:ae_functions'], skills: [{ id: 'codex:notes', name: 'notes', source: 'codex' }],
    servers: [{ id: 'codex-fake', name: 'fake <i>', source: 'codex', type: 'stdio', target: 'node.exe' }] } };
  state.mcp = { busy: false, hold: false, plans: [{ id: 'm1', serverId: 'codex-fake', serverName: 'fake', tool: 'write', args: { text: 'x' }, reason: 'ghi', state: 'proposed', createdAt: 1 }] };
  update(state);
  const run = doc.querySelector('[data-action="mcpExecute"]');
  assert.equal(run.disabled, true); // server not enabled yet
  doc.getElementById('configBtn').click();
  assert.match(doc.getElementById('toolboxSummary').textContent, /1 skill · 1 server MCP · 0 đang bật/);
  assert.equal(doc.querySelector('#toolboxList i'), null); assert.match(doc.getElementById('toolboxList').textContent, /ae_functions/);
  doc.getElementById('toolboxScan').click();
  assert.equal(messages.at(-1).type, 'toolboxScan');
  const box = doc.querySelector('[data-mcp-toggle="codex-fake"]'); box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'mcpToggle', id: 'codex-fake', enabled: true });
  state.toolbox.enabled = ['codex-fake']; update(state);
  doc.querySelector('[data-action="mcpExecute"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'mcpExecute', id: 'm1' });
  state.mcp.hold = true; update(state);
  assert.equal(doc.getElementById('mcpHold').hidden, false); assert.equal(doc.querySelector('[data-action="mcpExecute"]').disabled, true);
});

test('Tạo ảnh is merged into Mỹ thuật & Tạo ảnh: no separate card, art shows image progress and the image button', t => {
  const { dom, doc, update, state } = setup(); t.after(() => dom.window.close());
  const session = newSession('Ảnh'); state.sessions = [session]; state.selectedId = session.id;
  session.tasks.forEach(task => { task.status = 'approved'; });
  state.imageWork = [{ sessionId: session.id, status: 'running', at: 2 }]; update(state);
  assert.equal(doc.querySelector('.role-card[data-id="image"]'), null);
  assert.equal(doc.querySelector('.role-card[data-id="art"] .work-indicator').dataset.work, 'running');
  doc.querySelector('.role-card[data-id="art"]').click();
  assert.ok(doc.querySelector('#detail [data-action="openImage"]'));
});

test('Học AE strip starts with a topic, pauses, resumes and shows Claude Opus 5 progress', t => {
  const { dom, doc, update, state, messages } = setup(); t.after(() => dom.window.close());
  assert.equal(doc.getElementById('learnModel').textContent, 'claude-opus-5');
  assert.equal(doc.getElementById('learnPauseBtn').disabled, true);
  doc.getElementById('learnTopic').value = ' smear frames ';
  doc.getElementById('learnStartBtn').click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'learnStart', topic: 'smear frames' });
  update({ ...state, learning: { busy: true, model: 'claude-opus-5', status: { state: 'running', topic: 'smear frames', percent: 45, lessonsSaved: 3, historyLearned: 9, historyTotal: 20, message: 'Đọc yêu cầu cũ' } } });
  assert.equal(doc.getElementById('learnBar').value, 45);
  assert.match(doc.getElementById('learnStatus').textContent, /Đang học · 45% · 3 bài · lịch sử 9\/20/);
  assert.equal(doc.getElementById('learnStartBtn').disabled, true);
  doc.getElementById('learnPauseBtn').click();
  assert.equal(messages.at(-1).type, 'learnPause');
  update({ ...state, learning: { busy: false, model: 'claude-opus-5', status: { state: 'paused', topic: 'smear frames', percent: 45, lessonsSaved: 3, historyLearned: 9, historyTotal: 20, message: 'Đã dừng' } } });
  assert.equal(doc.getElementById('learnStartBtn').textContent, 'Tiếp tục');
  doc.getElementById('learnStartBtn').click();
  assert.equal(messages.at(-1).type, 'learnResume');
});
