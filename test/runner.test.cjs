const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { defaultConfig } = require('../dist/core');

async function waitFor(predicate, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message || 'Timed out');
}
async function setup(t, fetcher, settings = {}, cli, dependencies = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p0-runner-test-'));
  const storage = new Map(); const secrets = new Map([['gatewayKey', 'mock-api-key']]);
  const fakeVscode = {
    workspace: {
      workspaceFolders: [{ name: 'Fixture', uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback })
    },
    commands: { executeCommand: async () => {} }, Uri: { file: fsPath => ({ fsPath }) },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
  };
  const location = require.resolve('../dist/extension');
  const source = await fs.readFile(location, 'utf8');
  const extensionModule = new Module(location, module);
  extensionModule.filename = location; extensionModule.paths = Module._nodeModulePaths(path.dirname(location));
  const normalRequire = extensionModule.require.bind(extensionModule);
  extensionModule.require = id => id === 'vscode' ? fakeVscode : Object.hasOwn(dependencies, id) ? dependencies[id] : id === './claude-cli' && cli ? cli : normalRequire(id);
  extensionModule._compile(source, location);
  const context = { globalStorageUri: { fsPath: path.join(root, ".globalStorage") }, subscriptions: [], workspaceState: { get: (key, fallback) => storage.get(key) ?? fallback,
    update: async (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))) },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) } };
  const board = new extensionModule.exports.Board(context);
  const originalFetch = global.fetch;
  global.fetch = fetcher;
  t.after(async () => {
    board.dispose();
    await waitFor(() => board.activeTasks.size === 0 && board.chatControllers.size === 0 && !board.imageController, 'Fixture requests must stop before teardown');
    await board.persistence;
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  board.config = { ...defaultConfig(), openaiBaseUrl: 'https://mock.invalid/v1', anthropicBaseUrl: 'https://mock.invalid/v1',
    maxParallel: 2, roles: defaultConfig().roles.map(r => ({ ...r, protocol: 'responses' })) };
  return { board, root, storage, context, Board: extensionModule.exports.Board };
}
const done = () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Verified handoff, no file changes.' }] }],
  usage: { input_tokens: 10, output_tokens: 5 } });

test('CEO creates one PO task; engineers get work only through PO delegation', async t => {
  const { board } = await setup(t, async () => done());
  await board.handle({ type: 'create', brief: 'CEO cần poster mới' });
  const session = board.sessions[0];
  assert.equal(session.tasks.length, 1); assert.equal(session.tasks[0].roleId, 'lead');
  assert.match(session.tasks[0].prompt, /CEO cần poster mới/);
  assert.match(session.tasks[0].prompt, /delegate_task/);
  session.state = 'running'; session.tasks[0].status = 'running';
  await assert.rejects(board.delegateTask(session, { ...session.tasks[0], roleId: 'architect' },
    { roleId: 'art', title: 'No engineer delegation', prompt: 'No' }, new AbortController()), /Chỉ PO/);
});

test('delegation calls a different role model, delivers child output straight to PO without review and never deadlocks at parallel=1', async t => {
  const calls = []; let parentTurns = 0;
  const { board, storage } = await setup(t, async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.model === 'lead-fixture' && parentTurns++ === 0) return Response.json({ output: [{ type: 'function_call', call_id: 'delegate-1', name: 'delegate_task',
      arguments: JSON.stringify({ roleId: 'art', title: 'Chọn palette', prompt: 'Chọn 3 màu cụ thể cho poster.' }) }] });
    if (body.model === 'art-fixture') {
      assert.ok(!body.tools.some(t => t.name === 'delegate_task'));
      assert.match(JSON.stringify(body.input), /Chọn 3 màu cụ thể/);
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Palette thật: xanh, trắng, đen.' }] }] });
    }
    if (body.model === 'lead-fixture') assert.match(JSON.stringify(body.input), /Palette thật/);
    return done();
  });
  board.config.maxParallel = 1;
  board.config.roles.find(r => r.id === 'lead').model = 'lead-fixture';
  board.config.roles.find(r => r.id === 'art').model = 'art-fixture';
  await board.handle({ type: 'create', brief: 'Poster xanh' }); await board.handle({ type: 'run' });
  const session = board.sessions[0];
  await waitFor(() => session.tasks[0].status === 'approved' && board.activeTasks.size === 0);
  const child = session.tasks.find(t => t.parentTaskId === 'brief');
  assert.ok(child); assert.equal(child.model, 'art-fixture'); assert.equal(child.status, 'approved');
  assert.deepEqual(calls.map(c => c.model), ['lead-fixture', 'art-fixture', 'lead-fixture']);
  // Lean subagent context: no workspace listing or team roster.
  const childInput = JSON.stringify(calls[1].input);
  assert.doesNotMatch(childInput, /FILE TRONG WORKSPACE/); assert.doesNotMatch(childInput, /KỸ SƯ CÓ THỂ GIAO VIỆC/);
  session.state = 'running';
  const duplicate = JSON.parse(await board.delegateTask(session, { ...session.tasks[0], status: 'running' },
    { roleId: 'art', title: 'Việc khác', prompt: 'Một yêu cầu khác cho cùng kỹ sư' }, new AbortController()));
  // One job per engineer: the existing result is returned, never dispatched twice.
  assert.equal(calls.length, 3);
  assert.equal(duplicate.taskId, child.id); assert.equal(duplicate.delivered, true);
  assert.ok(storage.get('sessions')[0].tasks.some(t => t.parentTaskId === 'brief'));
  session.state = 'paused';
  // PO is the approver: its task is approved without a CEO review step.
  assert.equal(session.tasks[0].status, 'approved');
});

test('delegation enforces role boundaries, caps, no nested agents, and no automatic failed-child replay', async t => {
  let calls = 0; const { board } = await setup(t, async () => { calls++; return new Response('offline', { status: 503 }); });
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Boundaries' });
  const session = board.sessions[0], parent = session.tasks[0]; session.state = 'running'; parent.status = 'running';
  const controller = new AbortController(), args = { roleId: 'art', title: 'Palette', prompt: 'Choose palette' };
  for (const roleId of ['lead', 'image', 'qa', 'missing']) await assert.rejects(board.delegateTask(session, parent, { ...args, roleId }, controller), /vai trò/);
  await assert.rejects(board.delegateTask(session, { ...parent, parentTaskId: 'another' }, args, controller), /một cấp/);
  await assert.rejects(board.delegateTask(session, { ...parent, roleId: 'reviewer' }, args, controller), /một cấp/);
  const output = JSON.parse(await board.delegateTask(session, parent, args, controller));
  assert.equal(output.status, 'blocked'); assert.match(output.error, /503/); assert.equal(calls, 1);
  const same = JSON.parse(await board.delegateTask(session, parent, { ...args, prompt: 'Different prompt' }, controller));
  assert.equal(same.taskId, output.taskId); assert.equal(same.status, 'blocked'); assert.equal(calls, 1);
  for (let n = 0; n < 24; n++) session.tasks.push({ ...session.tasks[1], id: 'filler-' + n, parentTaskId: 'other' });
  await assert.rejects(board.delegateTask(session, parent, { ...args, roleId: 'architect' }, controller), /giới hạn/);
  assert.equal(calls, 1);
});

test('PO delegations in one turn run in parallel, one job per engineer, results delivered to PO', async t => {
  let active = 0, peak = 0, poTurns = 0, poFinalInput = '';
  const { board } = await setup(t, async (_, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'po-fixture') {
      if (poTurns++ === 0) return Response.json({ output: ['art', 'camera_ui', 'art'].map((roleId, i) => ({ type: 'function_call', call_id: 'd' + i, name: 'delegate_task',
        arguments: JSON.stringify({ roleId, title: 'Việc ' + roleId, prompt: 'Làm phần ' + roleId }) })) });
      poFinalInput = JSON.stringify(body.input); return done();
    }
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30)); active--; return done();
  });
  board.config.maxParallel = 2; board.config.roles.find(r => r.id === 'lead').model = 'po-fixture';
  await board.handle({ type: 'create', brief: 'Song song' }); await board.handle({ type: 'run' });
  const session = board.sessions[0];
  await waitFor(() => session.tasks[0].status === 'approved' && board.activeTasks.size === 0);
  const children = session.tasks.filter(t => t.parentTaskId === 'brief');
  assert.deepEqual(children.map(t => t.roleId).sort(), ['art', 'camera_ui']);
  assert.ok(children.every(t => t.status === 'approved'));
  assert.equal(peak, 2);
  // The repeated art delegation either waits-error (still running) or gets the existing result; never a second run.
  assert.match(poFinalInput, /chỉ nhận một việc|việc duy nhất/);
});

test('delegation scope, patch proposals, acceptance evidence and compact PO handoff', async t => {
  const { board, root } = await setup(t, async () => done());
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'notes', 'cue.md'), 'Cue 1: whoosh\nCue 2: hit\n');
  await board.handle({ type: 'create', brief: 'Scope' });
  const session = board.sessions[0], parent = session.tasks[0]; session.state = 'running'; parent.status = 'running';
  // Invalid delegations return specific errors for PO to fix; nothing is created.
  await assert.rejects(board.delegateTask(session, parent, { roleId: 'sfx_vfx', title: 'SFX', prompt: 'x', scope: ['../outside'] }, new AbortController()), /đường dẫn tương đối/);
  await assert.rejects(board.delegateTask(session, parent, { roleId: 'sfx_vfx', title: 'SFX', prompt: 'x', acceptance: [{ id: 'Bad Id', description: 'd', verification: 'ae' }] }, new AbortController()), /id dạng/);
  assert.equal(session.tasks.length, 1);
  const child = { id: 'sub-x', parentTaskId: parent.id, roleId: 'sfx_vfx', title: 'SFX', prompt: 'x', dependencies: [], status: 'running', result: '', error: '',
    attempts: 0, requestCount: 0, inputTokens: 0, outputTokens: 0, scope: ['notes', 'comp:Main'],
    acceptance: [{ id: 'cues', description: 'Có file cue', verification: 'file' }, { id: 'read', description: 'Đọc comp thật', verification: 'ae' }], toolLog: [] };
  session.tasks.push(child);
  await assert.rejects(board.executeTool(session, child, 'propose_file', { path: 'other.md', content: 'x', reason: 'r' }), /ngoài phạm vi/);
  JSON.parse(await board.executeTool(session, child, 'propose_patch', { path: 'notes/cue.md', reason: 'Thêm cue', edits: [{ oldText: 'Cue 2: hit', newText: 'Cue 2: impact' }] }));
  await assert.rejects(board.executeTool(session, child, 'propose_patch', { path: 'notes/cue.md', reason: 'r', edits: [{ oldText: 'Cue', newText: 'X' }] }), /nhiều lần/);
  const staged = session.proposals.find(p => p.taskId === child.id);
  assert.equal(staged.content, 'Cue 1: whoosh\nCue 2: impact\n'); assert.equal(staged.original, 'Cue 1: whoosh\nCue 2: hit\n');
  // A self-reported pass without matching evidence is not verified.
  const reported = JSON.parse(await board.executeTool(session, child, 'report_checks', { checks: [
    { id: 'cues', status: 'pass', evidence: 'Đã đề xuất cue', path: 'notes/cue.md' }, { id: 'read', status: 'pass', evidence: 'Đọc rồi', callId: 'fake' }] }));
  assert.deepEqual(reported.checks.map(c => c.verified), [true, false]);
  child.toolLog.push({ id: 'fake', name: 'aect_read', ok: true });
  assert.deepEqual(require('../dist/teamwork').verifyChecks(child, session.proposals).map(c => c.verified), [true, true]);
  // PO gets metadata + sha256, and reads content only on demand.
  child.status = 'approved'; child.result = 'R'.repeat(5000);
  const handoff = JSON.parse(await board.delegateTask(session, parent, { roleId: 'sfx_vfx', title: 'SFX', prompt: 'again' }, new AbortController()));
  assert.equal(handoff.summary.length, 4000); assert.equal(handoff.resultChars, 5000);
  assert.equal(handoff.proposals[0].sha256.length, 64); assert.equal(handoff.proposals[0].content, undefined);
  const inspected = JSON.parse(await board.executeTool(session, parent, 'inspect_proposal', { proposalId: handoff.proposals[0].proposalId }));
  assert.match(inspected.content, /impact/);
  const more = JSON.parse(await board.executeTool(session, parent, 'read_subagent_result', { taskId: child.id, offset: 4000 }));
  assert.equal(more.text.length, 1000);
  // Delivery report lists the unapplied proposal as incomplete.
  const sent = []; board.send = m => sent.push(m); await board.publish();
  const report = sent.find(m => m.type === 'state').deliveries[parent.id];
  assert.equal(report.ready, false); assert.ok(report.incomplete.some(i => /chưa áp dụng/.test(i.detail)));
});

test('overlapping delegation scopes run one after another, disjoint ones in parallel', async t => {
  let active = 0, peak = 0, poTurns = 0;
  const { board } = await setup(t, async (_, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'po-fixture') {
      if (poTurns++ === 0) return Response.json({ output: [['art', ['comp:Main']], ['camera_ui', ['comp:main']], ['sfx_vfx', ['audio']]].map(([roleId, scope], i) => ({ type: 'function_call', call_id: 'd' + i, name: 'delegate_task',
        arguments: JSON.stringify({ roleId, title: 'Việc ' + roleId, prompt: 'Làm phần ' + roleId, scope }) })) });
      return done();
    }
    active++; peak = Math.max(peak, active); const role = body.model;
    await new Promise(resolve => setTimeout(resolve, 30)); active--; return done();
  });
  board.config.maxParallel = 3; board.config.roles.find(r => r.id === 'lead').model = 'po-fixture';
  await board.handle({ type: 'create', brief: 'Scope song song' }); await board.handle({ type: 'run' });
  const session = board.sessions[0];
  await waitFor(() => session.tasks[0].status === 'approved' && board.activeTasks.size === 0);
  assert.equal(session.tasks.filter(t => t.parentTaskId).length, 3);
  assert.equal(peak, 2);
});

test('session budget pauses before the next billed request; CEO can stop one engineer; models switch per position', async t => {
  let calls = 0, release;
  const { board } = await setup(t, async (_, init) => {
    calls++; const body = JSON.parse(init.body);
    if (body.model === 'slow-art') return new Promise((resolve, reject) => { release = resolve; init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
    return Response.json({ output: [{ type: 'function_call', call_id: 'c' + calls, name: 'list_files', arguments: '{}' }], usage: { input_tokens: 600, output_tokens: 0 } });
  });
  board.config.budget = { maxCalls: 0, maxTokens: 1000 };
  await board.handle({ type: 'create', brief: 'Budget' }); await board.handle({ type: 'run' });
  const session = board.sessions[0];
  await waitFor(() => session.state === 'paused' && board.activeTasks.size === 0);
  assert.equal(calls, 2); assert.equal(session.tasks[0].status, 'assigned'); assert.match(session.tasks[0].error, /ngân sách/);
  await assert.rejects(board.handle({ type: 'run' }), /ngân sách/); assert.equal(calls, 2);
  // Stop one engineer: it ends blocked, PO is not aborted.
  board.config.budget = { maxCalls: 0, maxTokens: 0 };
  board.config.roles.find(r => r.id === 'art').model = 'slow-art';
  const parent = session.tasks[0]; session.state = 'running'; parent.status = 'running';
  const parentController = new AbortController();
  const pending = board.delegateTask(session, parent, { roleId: 'art', title: 'Palette', prompt: 'Chọn màu' }, parentController);
  await waitFor(() => session.tasks.some(t => t.parentTaskId && t.status === 'running') && release);
  const child = session.tasks.find(t => t.parentTaskId);
  await assert.rejects(board.handle({ type: 'setRoleModel', roleId: 'art', model: 'claude-sonnet-5' }), /đang làm việc/);
  await board.handle({ type: 'stopTask', taskId: child.id });
  const output = JSON.parse(await pending);
  assert.equal(output.status, 'blocked'); assert.match(output.error, /dừng riêng/); assert.equal(parentController.signal.aborted, false);
  board.config.roles.find(r => r.id === 'image').protocol = 'iw-imagegen'; // fixture sets every role to responses
  await board.handle({ type: 'setRoleModel', roleId: 'art', model: 'claude-sonnet-5' });
  assert.equal(board.config.roles.find(r => r.id === 'art').model, 'claude-sonnet-5');
  await assert.rejects(board.handle({ type: 'setRoleModel', roleId: 'image', model: 'x' }), /Tạo ảnh/);
});

test('connection check lists models on both OpenAI and Anthropic routes without generation calls', async t => {
  const seen = [];
  const { board } = await setup(t, async (url, init) => { seen.push({ url: String(url), headers: init.headers, method: init.method });
    return Response.json({ data: [{ id: String(url).includes('anthropic') ? 'claude-x' : 'gpt-x' }] }); });
  board.config.openaiBaseUrl = 'https://openai.mock.invalid/v1'; board.config.anthropicBaseUrl = 'https://anthropic.mock.invalid/v1';
  const sent = []; board.send = m => sent.push(m);
  await board.handle({ type: 'testConnection' });
  assert.deepEqual(seen.map(s => s.url), ['https://openai.mock.invalid/v1/models', 'https://anthropic.mock.invalid/v1/models']);
  assert.ok(seen.every(s => s.method === undefined));
  assert.equal(seen[1].headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(sent.find(m => m.type === 'models').models, ['gpt-x', 'claude-x']);
  board.config.anthropicBaseUrl = board.config.openaiBaseUrl; seen.length = 0;
  await board.handle({ type: 'testConnection' });
  assert.equal(seen.length, 1);
});

test('QA Stop only affects the selected session', async t => {
  let calls = 0;
  const { board } = await setup(t, async (_, init) => {
    calls++; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  await board.handle({ type: 'create', brief: 'A' }); const a = board.sessions[0].id;
  await board.handle({ type: 'create', brief: 'B' }); const b = board.sessions[0].id;
  const pending = board.handle({ type: 'roleChatSend', roleId: 'qa', sessionId: a, text: 'Câu hỏi phiên A' });
  await waitFor(() => calls === 1);
  assert.equal(board.selectedId, b); assert.equal(board.qaController, undefined);
  await board.handle({ type: 'supportStop', target: 'qa' });
  assert.equal(board.chatControllers.size, 1);
  await board.handle({ type: 'selectSession', id: a });
  await board.handle({ type: 'supportStop', target: 'qa' }); await pending;
  assert.equal(board.chatControllers.size, 0);
});

test('Claude CLI parent can delegate to a Responses model and receives its tool result', async t => {
  let cliTurns = 0, result, childModel;
  const cli = { findClaude: async () => 'fixture-cli', ClaudeCliConversation: class {
    constructor(options) { assert.ok(options.tools.some(t => t.name === 'delegate_task')); }
    async turn() { return ++cliTurns === 1 ? { text: '', calls: [{ id: 'cross-provider', name: 'delegate_task',
      arguments: { roleId: 'camera_ui', title: 'Layout', prompt: 'Kiểm tra safe area 1080x1920' } }], raw: {}, inputTokens: 1, outputTokens: 1 } :
      { text: 'Đã nhận kết quả layout từ subagent.', calls: [], raw: {}, inputTokens: 1, outputTokens: 1 }; }
    toolResults(items) { result = JSON.parse(items[0].output); }
  } };
  const { board } = await setup(t, async (_, init) => { childModel = JSON.parse(init.body).model; return done(); }, {}, cli);
  board.config.roles.find(r => r.id === 'lead').protocol = 'claude-cli';
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Cross provider' });
  const session = board.sessions[0], parent = session.tasks[0]; session.state = 'running'; parent.status = 'running';
  await board.runTask(session, parent, new AbortController());
  assert.equal(childModel, 'gpt-6.1-sol'); assert.equal(cliTurns, 2);
  assert.match(result.summary, /Verified handoff/); assert.equal(result.delivered, true);
  assert.equal(parent.status, 'approved');
});

test('Stop cancels a nested model request; resume keeps the persisted child dependency', async t => {
  let childStarted = false;
  const { board } = await setup(t, async (_, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'child-fixture') { childStarted = true; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); }
    return Response.json({ output: [{ type: 'function_call', call_id: 'delegate-stop', name: 'delegate_task', arguments: JSON.stringify({ roleId: 'art', title: 'Child', prompt: 'Wait until stopped' }) }] });
  });
  board.config.maxParallel = 1; board.config.roles.find(r => r.id === 'art').model = 'child-fixture';
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Stop nested' }); await board.handle({ type: 'run' });
  await waitFor(() => childStarted); await board.handle({ type: 'pause' }); await waitFor(() => board.activeTasks.size === 0);
  const session = board.sessions[0], child = session.tasks.find(t => t.parentTaskId);
  assert.equal(child.status, 'assigned'); assert.equal(session.tasks[0].status, 'assigned');
  assert.ok(session.tasks[0].dependencies.includes(child.id));
  const { readyTasks } = require('../dist/core');
  assert.deepEqual(readyTasks(session).map(t => t.id), [child.id]);
});

test('intake QA uses exact Haiku ID via Claude CLI, no tools, retains feedback and session context', async t => {
  const calls = [];
  const cli = { findClaude: async () => 'mock-claude', ClaudeCliConversation: class {
    constructor(options) { calls.push(options); }
    async turn() { return { text: 'Đã ghi nhận ý kiến của bạn.', calls: [] }; }
  } };
  const { board, storage, root } = await setup(t, async () => assert.fail('QA must use CLI'), {}, cli);
  board.config.roles.find(r => r.id === 'qa').protocol = 'claude-cli';
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Motion poster' });
  await board.handle({ type: 'qaSend', text: 'Cho tôi màu xanh' });
  await board.handle({ type: 'qaSend', text: 'Có thể đổi font không?' });
  assert.equal(calls.length, 2); assert.equal(calls[0].model, 'claude-haiku-5.5');
  assert.deepEqual(calls[0].tools, []);
  assert.match(calls[1].prompt, /Cho tôi màu xanh/); assert.match(calls[1].prompt, /Motion poster/);
  assert.equal(storage.get('qaMessages').length, 4);
  assert.equal(board.sessions[0].tasks.length, 9);
  assert.ok(board.sessions[0].tasks.every(task => task.status === 'assigned'));
  const guard = JSON.parse(await fs.readFile(path.join(root, '.globalStorage', 'update-guards',
    (await fs.readdir(path.join(root, '.globalStorage', 'update-guards')))[0]), 'utf8'));
  assert.equal(guard.active, false);
});

test('QA prevents concurrent submits, blocks config changes while active and supports Stop without a session', async t => {
  let calls = 0;
  const { board, storage } = await setup(t, async (_, init) => {
    calls++; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const pending = board.handle({ type: 'qaSend', text: 'Xin chào QA' });
  await waitFor(() => calls === 1);
  await assert.rejects(board.handle({ type: 'qaSend', text: 'Gửi trùng' }), /đang trả lời/);
  await assert.rejects(board.handle({ type: 'saveConfig', config: defaultConfig() }), /Tạm dừng/);
  await board.handle({ type: 'supportStop', target: 'qa' }); await pending;
  assert.equal(board.qaController, undefined); assert.equal(calls, 1);
  assert.equal(storage.get('qaMessages').length, 1);
});

test('QA failures release busy state without automatically retrying', async t => {
  let calls = 0; const { board } = await setup(t, async () => { calls++; return new Response('unavailable', { status: 503 }); });
  await assert.rejects(board.handle({ type: 'qaSend', text: 'Hỏi QA' }), /503/);
  assert.equal(calls, 1); assert.equal(board.qaController, undefined);
});

test('member chats use the selected Claude/Codex models and isolate engineer histories by role and session', async t => {
  const cliCalls = [], gatewayCalls = [];
  const cli = { findClaude: async () => 'mock-claude', ClaudeCliConversation: class {
    constructor(options) { cliCalls.push(options); }
    async turn() { return { text: 'PO đã tiếp nhận.', calls: [] }; }
  } };
  const { board, storage } = await setup(t, async (_, init) => { gatewayCalls.push(JSON.parse(init.body)); return done(); }, {}, cli);
  Object.assign(board.config.roles.find(r => r.id === 'lead'), { protocol: 'claude-cli', model: 'claude-po-fixture' });
  board.config.roles.find(r => r.id === 'camera_ui').model = 'codex-camera-fixture';
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Session A poster' });
  const first = board.sessions[0], originalTasks = JSON.stringify(first.tasks);
  await board.handle({ type: 'roleChatSend', roleId: 'lead', sessionId: first.id, text: 'PO_PRIVATE_A' });
  await board.handle({ type: 'roleChatSend', roleId: 'camera_ui', sessionId: first.id, text: 'CAMERA_A_FIRST' });
  await board.handle({ type: 'roleChatSend', roleId: 'camera_ui', sessionId: first.id, text: 'CAMERA_A_SECOND' });
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Session B landscape' });
  const second = board.sessions[0];
  await board.handle({ type: 'roleChatSend', roleId: 'camera_ui', sessionId: second.id, text: 'CAMERA_B_ONLY' });
  assert.equal(cliCalls[0].model, 'claude-po-fixture'); assert.deepEqual(cliCalls[0].tools, []);
  assert.equal(gatewayCalls[0].model, 'codex-camera-fixture'); assert.deepEqual(gatewayCalls[0].tools, []);
  assert.doesNotMatch(JSON.stringify(gatewayCalls[0].input), /PO_PRIVATE_A/);
  assert.match(JSON.stringify(gatewayCalls[1].input), /CAMERA_A_FIRST/);
  assert.doesNotMatch(JSON.stringify(gatewayCalls[2].input), /CAMERA_A_FIRST|CAMERA_A_SECOND|PO_PRIVATE_A/);
  assert.match(JSON.stringify(gatewayCalls[2].input), /Session B landscape/);
  assert.equal(JSON.stringify(first.tasks), originalTasks, 'chat must not dispatch or change work');
  assert.equal(storage.get('roleChats').length, 3);
  assert.equal(storage.get('roleChats').find(c => c.roleId === 'camera_ui' && c.sessionId === first.id).messages.length, 4);
});

test('switching sessions while a member chat awaits credentials preserves the original target and context', async t => {
  const calls = [];
  const { board, storage, context } = await setup(t, async (_, init) => { calls.push(JSON.parse(init.body)); return done(); });
  await board.handle({ type: 'create', brief: 'ORIGINAL_SESSION_A' }); const first = board.sessions[0];
  await board.handle({ type: 'create', brief: 'DIFFERENT_SESSION_B' }); const second = board.sessions[0];
  let releaseKey, waitingForKey = false;
  const getSecret = context.secrets.get;
  context.secrets.get = async key => {
    waitingForKey = true;
    await new Promise(resolve => { releaseKey = resolve; });
    return getSecret(key);
  };
  // publish() reads credentials too: release each request after the session has changed.
  const pending = board.handle({ type: 'roleChatSend', roleId: 'architect', sessionId: first.id, text: 'Góp ý cho A' });
  await waitFor(() => waitingForKey);
  board.selectedId = second.id;
  context.secrets.get = getSecret; releaseKey();
  await pending;
  assert.equal(calls.length, 1); assert.match(JSON.stringify(calls[0].input), /ORIGINAL_SESSION_A/);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /DIFFERENT_SESSION_B/);
  const chats = storage.get('roleChats');
  assert.equal(chats.length, 1); assert.equal(chats[0].sessionId, first.id);
  assert.equal(chats[0].messages[0].delivery, 'answered');
});

test('saved feedback reaches the next engineer task and PO coordination without leaking other roles or sessions', async t => {
  const requests = [];
  const { board } = await setup(t, async (_, init) => { requests.push(JSON.parse(init.body)); return done(); });
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Feedback integration' }); const session = board.sessions[0];
  await board.handle({ type: 'roleChatSend', roleId: 'art', sessionId: session.id, text: 'ART_FEEDBACK_PALETTE' });
  await board.handle({ type: 'roleChatSend', roleId: 'gameplay', sessionId: session.id, text: 'ANIMATION_FEEDBACK_TIMING' });
  await board.handle({ type: 'roleChatSend', roleId: 'lead', sessionId: session.id, text: 'PO_FEEDBACK_PRIORITY' });
  await board.handle({ type: 'create', brief: 'Other unrelated session' });
  await board.handle({ type: 'roleChatSend', roleId: 'art', sessionId: board.sessions[0].id, text: 'OTHER_SESSION_SECRET' });
  requests.length = 0;
  await board.runTask(session, session.tasks.find(task => task.roleId === 'art'), new AbortController());
  await board.runTask(session, session.tasks[0], new AbortController());
  const engineerInput = JSON.stringify(requests[0].input), poInput = JSON.stringify(requests[1].input);
  assert.match(engineerInput, /ART_FEEDBACK_PALETTE/);
  assert.doesNotMatch(engineerInput, /ANIMATION_FEEDBACK_TIMING|PO_FEEDBACK_PRIORITY|OTHER_SESSION_SECRET/);
  for (const feedback of ['ART_FEEDBACK_PALETTE', 'ANIMATION_FEEDBACK_TIMING', 'PO_FEEDBACK_PRIORITY']) assert.ok(poInput.includes(feedback));
  assert.doesNotMatch(poInput, /OTHER_SESSION_SECRET/);
});

test('member feedback is durable before dispatch, prevents duplicates/config edits, and Stop affects the explicit target only', async t => {
  let calls = 0;
  const { board, storage, root } = await setup(t, async (_, init) => {
    calls++;
    assert.equal(storage.get('roleChats')[0].messages[0].delivery, 'pending');
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  await board.handle({ type: 'create', brief: 'Cancelable feedback' }); const session = board.sessions[0];
  const target = { roleId: 'architect', sessionId: session.id };
  const pending = board.handle({ type: 'roleChatSend', ...target, text: 'Chờ tôi góp ý' });
  await waitFor(() => calls === 1);
  const guardPath = path.join(root, '.globalStorage', 'update-guards', (await fs.readdir(path.join(root, '.globalStorage', 'update-guards')))[0]);
  assert.equal(JSON.parse(await fs.readFile(guardPath, 'utf8')).active, true);
  await assert.rejects(board.handle({ type: 'roleChatSend', ...target, text: 'Gửi trùng' }), /đang trả lời/);
  await assert.rejects(board.handle({ type: 'saveConfig', config: defaultConfig() }), /Tạm dừng/);
  await assert.rejects(board.handle({ type: 'importLocal' }), /Dừng tác vụ/);
  await board.handle({ type: 'roleChatStop', roleId: 'art', sessionId: session.id });
  assert.equal(board.chatControllers.size, 1, 'stopping another role must not abort this request');
  await board.handle({ type: 'roleChatStop', ...target }); await pending;
  assert.equal(board.chatControllers.size, 0); assert.equal(calls, 1);
  const messages = storage.get('roleChats')[0].messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].delivery, 'stopped');
  assert.match(messages[0].error, /không tự gửi lại/);
  assert.equal(JSON.parse(await fs.readFile(guardPath, 'utf8')).active, false);
});

test('member chat failures retain feedback and release busy state without any automatic replay', async t => {
  let calls = 0;
  const { board, storage } = await setup(t, async () => { calls++; return new Response('unavailable', { status: 503 }); });
  await assert.rejects(board.handle({ type: 'roleChatSend', roleId: 'lead', sessionId: '', text: 'Góp ý PO trước phiên' }), /503/);
  assert.equal(calls, 1); assert.equal(board.chatControllers.size, 0);
  const messages = storage.get('roleChats')[0].messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].delivery, 'failed'); assert.match(messages[0].error, /503/);
  assert.equal(board.sessions.length, 0);
});

test('role chat history survives reload and interrupted requests never redispatch; legacy QA is preserved', async t => {
  let calls = 0;
  const { board, storage, context, Board } = await setup(t, async () => { calls++; return done(); });
  await board.handle({ type: 'roleChatSend', roleId: 'architect', sessionId: '', text: 'PERSISTED_FEEDBACK' });
  const saved = storage.get('roleChats');
  saved.push({ roleId: 'lead', sessionId: '', messages: [{ role: 'user', text: 'INTERRUPTED_FEEDBACK', at: 1, delivery: 'pending' }] });
  storage.set('roleChats', saved);
  const restored = new Board(context); t.after(() => restored.dispose()); await restored.initialize();
  assert.equal(calls, 1); assert.equal(restored.chatControllers.size, 0);
  assert.equal(restored.roleChats[0].messages[0].text, 'PERSISTED_FEEDBACK');
  assert.equal(restored.roleChats[1].messages[0].delivery, 'interrupted');
  assert.match(restored.roleChats[1].messages[0].error, /Không tự gửi lại/);
  storage.delete('roleChats'); storage.set('qaMessages', [{ role: 'user', text: 'LEGACY_QA', at: 2 }]);
  const legacy = new Board(context); t.after(() => legacy.dispose()); await legacy.initialize();
  assert.equal(legacy.roleChats.length, 1); assert.equal(legacy.roleChats[0].roleId, 'qa');
  assert.equal(legacy.roleChats[0].sessionId, ''); assert.equal(legacy.roleChats[0].messages[0].text, 'LEGACY_QA');
  assert.equal(calls, 1);
});

test('invalid chat targets and text never dispatch or create history', async t => {
  const { board } = await setup(t, async () => assert.fail('Invalid chat must not call a model'));
  const valid = { type: 'roleChatSend', roleId: 'lead', sessionId: '', text: 'Valid text' };
  for (const bad of [{ roleId: 'missing' }, { sessionId: 'missing-session' }, { sessionId: undefined },
    { text: '' }, { text: '   ' }, { text: undefined }, { text: 'x'.repeat(10001) }]) {
    await assert.rejects(board.handle({ ...valid, ...bad }));
  }
  assert.equal(board.roleChats.length, 0); assert.equal(board.chatControllers.size, 0);
});

test('image engineer feedback records locally without model or skill dispatch and preserves task approvals/proposals', async t => {
  const { board, storage, root } = await setup(t, async () => assert.fail('Image feedback must not call a conversational model'));
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Image feedback only' }); const session = board.sessions[0];
  session.tasks[0].status = 'approved'; session.proposals.push({ id: 'unchanged-file', taskId: 'art', applied: false });
  const before = JSON.stringify(session);
  await board.handle({ type: 'roleChatSend', roleId: 'image', sessionId: session.id, text: 'Ảnh cần nền trong suốt' });
  assert.equal(JSON.stringify(session), before); assert.equal(board.imageController, undefined); assert.equal(board.imageProcess, undefined);
  await assert.rejects(fs.stat(path.join(root, '.ae-team', 'assets')), { code: 'ENOENT' });
  const chat = storage.get('roleChats')[0];
  assert.equal(chat.roleId, 'image'); assert.equal(chat.messages[0].delivery, 'recorded');
  assert.match(chat.messages[1].text, /chưa chạy tạo ảnh/); assert.equal(chat.messages[1].model, 'Ghi nhận');
  assert.match(board.feedbackContext(session.id, 'lead'), /Ảnh cần nền trong suốt/);
});

test('image role invokes configured local skill with isolated image model and verifies a saved PNG', async t => {
  const settings = { pythonPath: process.execPath };
  const { board, root, storage } = await setup(t, async () => assert.fail('Image must use skill'), settings);
  settings.imageScript = path.join(root, 'mock-image.js');
  await fs.writeFile(settings.imageScript, `const fs = require('node:fs'); const args = process.argv.slice(2);
    if (args[0] !== 'generate' || args[args.indexOf('--model') + 1] !== 'gpt-image-2.5-sunburst') process.exit(7);
    if (args.includes('--prompt')) process.exit(9);
    const prompt = fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8');
    if (!prompt.includes('Asset màu xanh') || !prompt.includes('IMAGE_FEEDBACK_KEEP_ALPHA') || prompt.includes('OTHER_IMAGE_SESSION')) process.exit(8);
    fs.writeFileSync(args[args.indexOf('--out') + 1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));`);
  await board.handle({ type: 'create', brief: 'Current image session' }); const first = board.sessions[0];
  await board.handle({ type: 'roleChatSend', roleId: 'image', sessionId: first.id, text: 'IMAGE_FEEDBACK_KEEP_ALPHA' });
  await board.handle({ type: 'create', brief: 'Other image session' });
  await board.handle({ type: 'roleChatSend', roleId: 'image', sessionId: board.sessions[0].id, text: 'OTHER_IMAGE_SESSION' });
  await board.handle({ type: 'selectSession', id: first.id });
  const pending = board.handle({ type: 'image', prompt: 'Asset màu xanh' });
  await assert.rejects(board.handle({ type: 'image', prompt: 'Duplicate' }), /đang được tạo/);
  await pending;
  assert.equal(board.imageController, undefined);
  const files = await fs.readdir(path.join(root, '.ae-team', 'assets'));
  assert.equal(files.length, 1); assert.match(files[0], /\.png$/);
  assert.deepEqual(storage.get('imageWork').map(work => [work.sessionId, work.status]), [[first.id, 'done']]);
  // A successful prior image must not mask the next generation's invalid output.
  await fs.writeFile(settings.imageScript, `const fs = require('node:fs'); const args = process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('--out') + 1], 'not a PNG');`);
  await assert.rejects(board.handle({ type: 'image', prompt: 'Invalid output fixture' }), /PNG hợp lệ/);
  assert.equal(storage.get('imageWork').length, 1);
  assert.equal(storage.get('imageWork')[0].status, 'failed');
  assert.match(storage.get('imageWork')[0].error, /PNG hợp lệ/);
});

test('image work is durable before generation and remains bound to its original session when selection changes', async t => {
  const { board, storage, root } = await setup(t, async () => assert.fail('Image lifecycle must not call a model'));
  await board.handle({ type: 'create', brief: 'Original image session' }); const first = board.sessions[0];
  await board.handle({ type: 'create', brief: 'Other image session' }); const second = board.sessions[0];
  await board.handle({ type: 'selectSession', id: first.id });
  let release, entered = false, calls = 0;
  board.generateImage = async (prompt, session) => {
    calls++; assert.equal(session.id, first.id); assert.equal(prompt, 'Scoped image');
    assert.deepEqual(storage.get('imageWork').map(work => [work.sessionId, work.status]), [[first.id, 'running']]);
    const guards = await fs.readdir(path.join(root, '.globalStorage', 'update-guards'));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.globalStorage', 'update-guards', guards[0]), 'utf8')).active, true);
    entered = true; await new Promise(resolve => { release = resolve; });
  };
  const pending = board.handle({ type: 'image', prompt: 'Scoped image' }); await waitFor(() => entered);
  await board.handle({ type: 'selectSession', id: second.id });
  assert.equal(storage.get('imageWork')[0].sessionId, first.id);
  assert.equal(storage.get('imageWork')[0].status, 'running');
  release(); await pending;
  assert.equal(calls, 1); assert.equal(board.imageController, undefined);
  assert.deepEqual(storage.get('imageWork').map(work => [work.sessionId, work.status]), [[first.id, 'done']]);
});

test('stopping image generation persists stopped instead of a stale done result and never retries', async t => {
  const { board, storage, root } = await setup(t, async () => assert.fail('Stopped image must not call a model'));
  board.imageWork = [{ sessionId: '', status: 'done', at: 1 }];
  let entered = false, calls = 0;
  board.generateImage = async () => {
    calls++; entered = true;
    const signal = board.imageController.signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const pending = board.handle({ type: 'image', prompt: 'Cancelable image' }); await waitFor(() => entered);
  assert.equal(storage.get('imageWork')[0].status, 'running');
  await board.handle({ type: 'supportStop', target: 'image' }); await assert.rejects(pending);
  assert.equal(calls, 1); assert.equal(board.imageController, undefined);
  assert.equal(storage.get('imageWork').length, 1); assert.equal(storage.get('imageWork')[0].status, 'stopped');
  assert.match(storage.get('imageWork')[0].error, /Không tự tạo lại/);
  const guards = await fs.readdir(path.join(root, '.globalStorage', 'update-guards'));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.globalStorage', 'update-guards', guards[0]), 'utf8')).active, false);
});

test('Stop during prompt write prevents image process dispatch and removes the temporary prompt', async t => {
  let release, promptFile, spawnCalls = 0;
  const settings = { pythonPath: process.execPath };
  const { board, root, storage } = await setup(t, async () => assert.fail('Stopped image must not call a model'), settings, undefined, {
    'node:fs/promises': { ...fs, writeFile: async (file, ...args) => {
      await fs.writeFile(file, ...args);
      if (path.basename(file).startsWith('ae-codexteam-prompt-')) {
        promptFile = file; await new Promise(resolve => { release = resolve; });
      }
    } },
    'node:child_process': { spawn: () => { spawnCalls++; throw new Error('Image process must never start after Stop'); } }
  });
  settings.imageScript = path.join(root, 'unused-image-fixture.js');
  await fs.writeFile(settings.imageScript, '// This fixture must never execute.');
  const pending = board.handle({ type: 'image', prompt: 'Cancel before dispatch' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => release);
  await board.handle({ type: 'supportStop', target: 'image' });
  release(); await rejected;
  assert.equal(spawnCalls, 0); assert.equal(board.imageProcess, undefined);
  assert.equal(board.imageController, undefined); assert.equal(storage.get('imageWork')[0].status, 'stopped');
  await assert.rejects(fs.stat(promptFile), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(root, '.ae-team', 'assets')), []);
});

test('reopening the workspace marks unfinished image work stopped and keeps completed sessions without redispatch', async t => {
  const { storage, context, Board } = await setup(t, async () => assert.fail('Image recovery must not call a model'));
  storage.set('imageWork', [{ sessionId: 'first', status: 'running', at: 1 }, { sessionId: 'second', status: 'done', at: 2 }]);
  const restored = new Board(context); t.after(() => restored.dispose());
  restored.generateImage = async () => assert.fail('Interrupted generation must never restart automatically');
  await restored.initialize();
  assert.equal(restored.imageController, undefined);
  assert.deepEqual(restored.imageWork.map(work => [work.sessionId, work.status]), [['first', 'stopped'], ['second', 'done']]);
  assert.match(restored.imageWork[0].error, /Không tự tạo lại/);
});
test('runner completes all nine tasks through review gates with no duplicate calls', async t => {
  let requests = 0; let active = 0; let peak = 0;
  const { board, storage } = await setup(t, async () => {
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--; return done();
  });
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Implement a Unity level' });
  await board.handle({ type: 'run' });
  const session = board.sessions[0];
  for (let guard = 0; guard < 30 && session.state !== 'done'; guard++) {
    await waitFor(() => session.tasks.some(task => task.status === 'review') || session.state === 'done');
    for (const task of session.tasks.filter(task => task.status === 'review')) {
      await board.handle({ type: 'approve', taskId: task.id });
    }
  }
  await waitFor(() => session.state === 'done');
  assert.equal(requests, 9);
  assert.equal(session.tasks.filter(task => task.status === 'approved').length, 9);
  assert.ok(peak <= 2);
  await waitFor(() => storage.get('sessions')[0].state === 'done', 'Final session must be persisted');
  assert.equal(storage.get('sessions')[0].state, 'done');
});
test('runner surfaces gateway client failures and blocks dependent tasks', async t => {
  const { board } = await setup(t, async () => new Response('client not permitted', { status: 403 }));
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Unity' });
  await board.handle({ type: 'run' });
  const session = board.sessions[0];
  await waitFor(() => session.state === 'waiting');
  assert.equal(session.tasks[0].status, 'blocked');
  assert.ok(session.tasks[0].error.includes('403'));
  assert.ok(session.tasks.slice(1).every(task => task.status === 'blocked'));
});
test('pause aborts a running request without turning cancellation into a failure', async t => {
  const { board } = await setup(t, async (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Unity' });
  await board.handle({ type: 'run' });
  await waitFor(() => board.sessions[0].tasks[0].startedAt);
  await board.handle({ type: 'pause' });
  await waitFor(() => board.activeTasks.size === 0);
  assert.equal(board.sessions[0].state, 'paused');
  assert.equal(board.sessions[0].tasks[0].status, 'assigned');
});
test('proposed files require explicit application and cannot silently overwrite newer edits', async t => {
  const { board, root } = await setup(t, async () => done());
  await board.handle({ type: 'create', workflow: 'preset', brief: 'Unity' });
  const session = board.sessions[0]; const task = session.tasks[0];
  await fs.writeFile(path.join(root, 'Level.cs'), 'original');
  const result = JSON.parse(await board.executeTool(session, task, 'propose_file', {
    path: 'Level.cs', content: 'proposed', reason: 'Fix logic'
  }));
  assert.equal(result.status, 'pending_user_review');
  assert.equal(await fs.readFile(path.join(root, 'Level.cs'), 'utf8'), 'original');
  task.status = 'review';
  await assert.rejects(board.handle({ type: 'approve', taskId: task.id }), /áp dụng/);
  await fs.writeFile(path.join(root, 'Level.cs'), 'user edit');
  await assert.rejects(board.applyProposal(session.proposals[0]), /thay đổi/);
  await board.handle({ type: 'retry', taskId: task.id });
  assert.equal(session.proposals.length, 0);
});

const { validatePlan } = require('../dist/ae');
const aeFunctions = [{ name: 'team.comp.create', inputSchema: { type: 'object' }, mutates: true }];
const aePlan = { schema: 'aect-functions/v1', steps: [{ function: 'team.comp.create', args: { name: 'Review me' } }] };
function mockEngine(board, run) {
  board.engine = { root: 'fixture', validate: async p => validatePlan(p, aeFunctions),
    call: async () => ({ connection: { fresh: true, state: 'running', revisionMatches: true } }), run,
    dispose: async () => {} };
}
test('team AE plans run right away in AE, durable before dispatch, and only once', async t => {
  const { board, storage } = await setup(t, async () => done());
  let calls = 0;
  mockEngine(board, async () => {
    calls++;
    assert.equal(storage.get('aePlans')[0].state, 'dispatching');
    assert.equal(storage.get('aeInFlight'), true);
    await new Promise(r => setTimeout(r, 30)); return { state: 'success', runId: 'fixture' };
  });
  await board.handle({ type: 'create', workflow: 'preset', brief: 'After Effects task' });
  const session = board.sessions[0], task = session.tasks[0]; task.status = 'running';
  const out = JSON.parse(await board.executeTool(session, task, 'aect_propose_plan', { title: 'Create comp', reason: 'User requested shot', planJson: JSON.stringify(aePlan) }));
  assert.equal(calls, 1); assert.equal(out.state, 'success');
  const proposal = board.aeProposals[0];
  assert.equal(proposal.state, 'success');
  await assert.rejects(board.handle({ type: 'aeExecute', id: proposal.id }), /đã xử lý/);
  await assert.rejects(board.executeTool(session, task, 'aect_propose_plan', { title: 'Again', reason: 'Retry', planJson: JSON.stringify(aePlan) }), /đã có plan/);
  assert.equal(calls, 1);
});
test('AE failure retains evidence, blocks further jobs, and survives VS Code reload', async t => {
  const { board, storage } = await setup(t, async () => done()); let calls = 0;
  mockEngine(board, async () => { calls++; throw new Error('Timeout after dispatch'); });
  await board.handle({ type: 'aeStage', planJson: JSON.stringify(aePlan) });
  const proposal = board.aeProposals[0];
  await board.handle({ type: 'aeExecute', id: proposal.id });
  assert.equal(proposal.state, 'uncertain'); assert.equal(storage.get('aeHold'), true);
  await board.handle({ type: 'aeStage', planJson: JSON.stringify(aePlan) });
  await assert.rejects(board.handle({ type: 'aeExecute', id: board.aeProposals[1].id }), /chưa xác định/);
  assert.equal(calls, 1);
  board.aeHold = false; board.aeProposals[0].state = 'dispatching'; board.aeBusy = true;
  await board.persist(); board.aeBusy = false;
  await board.initialize();
  assert.equal(board.aeHold, true); assert.equal(board.aeProposals[0].state, 'uncertain');
});
test('disconnected or stopped AE never dispatches, and agents cannot mutate through read tool', async t => {
  const { board } = await setup(t, async () => done()); let calls = 0;
  mockEngine(board, async () => { calls++; return { state: 'success' }; });
  board.engine.call = async () => ({ connection: { fresh: true, state: 'stopped', revisionMatches: true } });
  await board.handle({ type: 'aeStage', planJson: JSON.stringify(aePlan) });
  await assert.rejects(board.handle({ type: 'aeExecute', id: board.aeProposals[0].id }), /Chưa có kết nối/);
  assert.equal(board.aeProposals[0].state, 'proposed'); assert.equal(board.aeHold, false);
  await assert.rejects(board.readAe('team.comp.create', {}), /Chỉ cho phép/);
  assert.equal(calls, 0);
});

test('offline project snapshot is timestamped and viewing it never dispatches to AE', async t => {
  const {board,storage}=await setup(t,async()=>done());let calls=0;
  board.engine={root:'fixture',validate:async p=>p,call:async()=>({connection:{fresh:true,state:'running',revisionMatches:true}}),
    read:async()=>{calls++;return{state:'success',result:{path:'C:/fixture.aep',numItems:2}}},dispose:async()=>{}};
  await board.handle({type:'aeProject'});
  const snapshot=storage.get('aeProjectSnapshot');assert.equal(snapshot.live,false);assert.ok(Date.parse(snapshot.capturedAt));assert.equal(calls,1);
  board.engine.call=async()=>{throw Error('AE offline')};
  await board.handle({type:'aeCachedProject'});assert.equal(board.aeLastRead.schema,'ae-codexteam-project-snapshot/v1');assert.equal(calls,1);
});

test('Chỉ đạo mỹ thuật điều phối Tạo ảnh: one real image job per call, PNG path returned, other roles refused', async t => {
  const settings = { pythonPath: process.execPath };
  const { board, root } = await setup(t, async () => assert.fail('no chat model call'), settings);
  settings.imageScript = path.join(root, 'mock-image.js');
  await fs.writeFile(settings.imageScript, `const fs = require('node:fs'); const a = process.argv.slice(2);
    fs.writeFileSync(a[a.indexOf('--out') + 1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));`);
  await board.handle({ type: 'create', brief: 'Poster cartoon' });
  const session = board.sessions[0];
  const art = { id: 'sub-art', parentTaskId: session.tasks[0].id, roleId: 'art', title: 'Style', prompt: 'x', dependencies: [], status: 'running', result: '', error: '', attempts: 0, requestCount: 0, inputTokens: 0, outputTokens: 0 };
  session.tasks.push(art);
  const out = JSON.parse(await board.executeTool(session, art, 'aect_request_image', { title: 'Nền cartoon', prompt: 'Nền trời xanh cartoon 3D' }, new AbortController().signal));
  assert.equal(out.status, 'approved'); assert.match(out.result, /\.png/);
  const child = session.tasks.find(t => t.id === out.taskId);
  assert.equal(child.roleId, 'image'); assert.equal(child.parentTaskId, 'sub-art');
  const other = { ...art, id: 'sub-cam', roleId: 'camera_ui' };
  await assert.rejects(board.executeTool(session, other, 'aect_request_image', { title: 'x', prompt: 'y' }), /Chỉ đạo mỹ thuật/);
});

test('image falls back from a failing skill to the next one once, and reports which skill made the PNG', async t => {
  const settings = { pythonPath: process.execPath };
  const { board, root } = await setup(t, async () => assert.fail('no chat call'), settings);
  const bad = path.join(root, 'bad', 'scripts', 'image_gen.js'), home = path.join(root, 'home');
  await fs.mkdir(path.dirname(bad), { recursive: true });
  await fs.writeFile(bad, 'process.stderr.write("quota exceeded"); process.exit(3);');
  const good = path.join(home, '.claude', 'skills', 'iw-imagegen', 'scripts', 'image_gen.py');
  await fs.mkdir(path.dirname(good), { recursive: true });
  await fs.writeFile(good, `const fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--out')+1],Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=','base64'));`);
  settings.imageScript = bad;
  const os = require('node:os'); const original = os.homedir; os.homedir = () => home; t.after(() => { os.homedir = original; });
  const file = await board.generateImage('Nền cartoon');
  assert.match(file, /\.png$/);
  settings.imageScript = bad; os.homedir = () => path.join(root, 'empty');
  await assert.rejects(board.generateImage('x'), /skill cấu hình: exit 3: quota exceeded/);
});

test('repeated identical read calls in one task reuse the first answer and stop at the third', async t => {
  let turns = 0;
  const call = { type: 'function_call', name: 'list_files', arguments: '{}' };
  const { board } = await setup(t, async () => {
    turns++;
    if (turns <= 3) return Response.json({ output: [{ ...call, call_id: 'c' + turns }] });
    return done();
  });
  let listed = 0; const original = board.executeTool.bind(board);
  board.executeTool = async (...a) => { if (a[2] === 'list_files') listed++; return original(...a); };
  await board.handle({ type: 'create', brief: 'Loop' });
  const session = board.sessions[0], task = session.tasks[0]; session.state = 'running'; task.status = 'running';
  await board.runTask(session, task, new AbortController());
  assert.equal(listed, 1);
  assert.equal(task.status, 'approved');
});

test('when tool rounds run out PO is asked for a final handoff instead of failing', async t => {
  let turns = 0;
  const { board } = await setup(t, async (_, init) => {
    turns++;
    if (/Hết 30 lượt công cụ/.test(init.body)) return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Bàn giao: đã dựng comp trong AE.' }] }] });
    return Response.json({ output: [{ type: 'function_call', call_id: 'c' + turns, name: 'list_files', arguments: JSON.stringify({ path: 'p' + turns }) }] });
  });
  await board.handle({ type: 'create', brief: 'Nhiều bước' });
  const session = board.sessions[0], task = session.tasks[0]; session.state = 'running'; task.status = 'running';
  await board.runTask(session, task, new AbortController());
  assert.equal(task.status, 'approved'); assert.match(task.result, /Bàn giao/); assert.equal(turns, 31);
});

test('Xóa yêu cầu clears all old requests, chats and plans, refuses while running, never touches files', async t => {
  const { board } = await setup(t, async () => done());
  await board.handle({ type: 'create', brief: 'Cũ 1' }); await board.handle({ type: 'create', brief: 'Cũ 2' });
  board.roleChats.push({ roleId: 'qa', sessionId: board.sessions[0].id, messages: [] });
  board.aeProposals.push({ id: 'p1', sessionId: board.sessions[1].id, state: 'uncertain', plan: { steps: [] } }); board.aeHold = true;
  board.sessions[0].state = 'running';
  await assert.rejects(board.handle({ type: 'deleteSession', confirmed: true }), /Tạm dừng/);
  board.sessions[0].state = 'paused';
  await board.handle({ type: 'deleteSession', confirmed: true });
  assert.equal(board.sessions.length, 0); assert.equal(board.selectedId, '');
  assert.equal(board.roleChats.length, 0); assert.equal(board.aeProposals.length, 0); assert.equal(board.aeHold, false);
});
test('a generated image is copied next to the open .aep and imported into AE with a layer in the active comp', async t => {
  const { board, root } = await setup(t, async () => assert.fail('no chat call'));
  const project = path.join(root, 'aeproj', 'Show.aep'); await fs.mkdir(path.dirname(project), { recursive: true });
  const png = path.join(root, 'made.png'); await fs.writeFile(png, 'png');
  const ran = [];
  board.readAe = async () => ({ result: { results: [{ value: { path: project, activeComp: { name: 'Main' } } }] } });
  board.ae.validate = async plan => plan;
  board.handleAe = async ({ id }) => { const p = board.aeProposals.find(x => x.id === id); ran.push(p.plan); p.state = 'success'; };
  await board.handle({ type: 'create', brief: 'Ảnh' }); const session = board.sessions[0];
  const placed = await board.placeImageInAe(session, { id: 'img-1', title: 'Chữ HELLO' }, png);
  assert.match(placed.path, /aeproj.AE_CodexTeam_assets.Chữ_HELLO_\d+\.png$/);
  assert.equal(await fs.readFile(placed.path, 'utf8'), 'png');
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].steps.map(s => s.function), ['team.media.import', 'team.layer.media.add']);
  assert.ok(path.isAbsolute(ran[0].steps[0].args.path));
  assert.match(placed.message, /comp "Main"/);
});

test('an Opus safety-filter false positive retries the task once with Sonnet, then reports a real failure', async t => {
  const models = [];
  const { board } = await setup(t, async (_, init) => {
    const body = JSON.parse(init.body); models.push(body.model);
    if (body.model === 'claude-opus-5-5') return new Response("API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).", { status: 400 });
    return done();
  });
  board.config.roles.find(r => r.id === 'architect').model = 'claude-opus-5-5';
  await board.handle({ type: 'create', brief: 'Cut-downs' });
  const session = board.sessions[0], parent = session.tasks[0]; session.state = 'running'; parent.status = 'running';
  const out = JSON.parse(await board.delegateTask(session, parent, { roleId: 'architect', title: 'Comp 9x16', prompt: 'Tạo 4 comp' }, new AbortController()));
  assert.deepEqual(models, ['claude-opus-5-5', 'claude-sonnet-5']);
  assert.equal(out.status, 'approved'); assert.equal(out.model, 'claude-sonnet-5');
  assert.ok(session.events.some(e => /chặn nhầm/.test(e.text)));
});
