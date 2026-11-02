const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { discover, publicSnapshot, readSkill, normalizeServer, isAeCodexServer } = require('../dist/toolbox');

const sdk = p => JSON.stringify(require.resolve('@modelcontextprotocol/sdk/' + p));
// Fake MCP server: one read-only tool, one write tool that appends to a log file (so dispatches can be counted).
const serverSource = (log) => `
const { Server } = require(${sdk('server/index.js')});
const { StdioServerTransport } = require(${sdk('server/stdio.js')});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk('types.js')});
const fs = require('node:fs');
const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'lookup', description: 'read', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'write', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } } ] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === 'lookup') return { content: [{ type: 'text', text: 'found ' + request.params.arguments.q }] };
  fs.appendFileSync(${JSON.stringify(log)}, request.params.arguments.text + '\\n');
  if (request.params.arguments.text === 'fail') return { isError: true, content: [{ type: 'text', text: 'boom' }] };
  return { content: [{ type: 'text', text: 'wrote' }] };
});
server.connect(new StdioServerTransport());`;

async function fakeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-toolbox-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const log = path.join(home, 'writes.log'), script = path.join(home, 'fake-mcp.cjs');
  await fs.writeFile(script, serverSource(log));
  const plugin = path.join(home, '.codex', 'plugins', 'cache', 'market', 'helper', '1.2.0');
  await fs.mkdir(path.join(plugin, 'skills', 'cue-sheet'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'skills', 'cue-sheet', 'SKILL.md'), '---\nname: cue-sheet\ndescription: Build SFX cue sheets\n---\nUse frames.');
  await fs.writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { helper: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } }));
  await fs.mkdir(path.join(home, '.codex', 'skills', 'notes', 'references'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Write notes\n---\nBody');
  await fs.writeFile(path.join(home, '.codex', 'skills', 'notes', 'references', 'guide.md'), 'Guide text');
  await fs.writeFile(path.join(home, '.codex', 'skills', 'notes', 'run.ps1'), 'Remove-Item *');
  await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.fake]', 'command = ' + JSON.stringify(process.execPath), 'args = [' + JSON.stringify(script) + ']',
    '[mcp_servers.fake.env]', 'SECRET_TOKEN = "s3cr3t"',
    '[mcp_servers.off]', 'command = "x"', 'enabled = false',
    '[mcp_servers.ae_functions]', 'command = "node"', 'args = ["C:/x/tools/AeFunctionsMcp.js"]',
    '[mcp_servers.web]', 'url = "https://mcp.example.com/mcp"', 'bearer_token_env_var = "WEB_TOKEN"',
    '[plugins."helper@market"]', 'enabled = true', '[plugins."other@market"]', 'enabled = false'].join('\n'));
  return { home, log };
}

test('discovery finds Codex/Claude skills, plugins and MCP servers; snapshot carries no credentials', async t => {
  const { home } = await fakeHome(t);
  const found = await discover({ home, env: { WEB_TOKEN: 'tok-123' } });
  assert.deepEqual(found.skills.map(s => s.id).sort(), ['codex-plugin:helper:cue-sheet', 'codex:notes']);
  assert.deepEqual(found.servers.map(s => s.name).sort(), ['fake', 'helper', 'web']);
  assert.deepEqual(found.excluded, ['codex:ae_functions']);
  const web = found.servers.find(s => s.name === 'web');
  assert.equal(web.headers.Authorization, 'Bearer tok-123'); assert.equal(web.type, 'http');
  assert.match(found.servers.find(s => s.name === 'helper').args[0], /1\.2\.0[\\/]server\.js$/);
  const snapshot = JSON.stringify(publicSnapshot(found));
  assert.doesNotMatch(snapshot, /s3cr3t|tok-123|Authorization|SECRET_TOKEN/);
});

test('skills are read-only reference text inside their own folder', async t => {
  const { home } = await fakeHome(t);
  const skill = (await discover({ home, env: {} })).skills.find(s => s.name === 'notes');
  assert.match((await readSkill(skill)).text, /Body/);
  assert.equal((await readSkill(skill, 'references/guide.md')).text, 'Guide text');
  await assert.rejects(readSkill(skill, 'run.ps1'), /văn bản/);
  await assert.rejects(readSkill(skill, '../../config.toml'), /văn bản|thư mục skill/);
});

test('server normalisation handles Claude/Codex shapes and AE_Codex exclusion', () => {
  assert.equal(normalizeServer({ type: 'sse', url: 'https://x.dev/sse', headers: { A: '${T}' } }, 's', 'claude', { T: 'v' }).headers.A, 'v');
  assert.equal(normalizeServer({ url: 'file:///etc/passwd' }, 's', 'claude'), undefined);
  assert.equal(normalizeServer({ command: 'n', disabled: true }, 's', 'claude'), undefined);
  assert.deepEqual(normalizeServer({ command: 'n', env_vars: ['KEEP'], env: { A: 'b' } }, 's', 'codex', { KEEP: '1', DROP: '2' }).env, { A: 'b', KEEP: '1' });
  assert.equal(isAeCodexServer({ name: 'codex-ae', args: [] }), true);
  assert.equal(isAeCodexServer({ name: 'tools', command: 'node', args: ['D:/AE_Codex/tools/AeFunctionsMcp.js'] }), true);
  assert.equal(isAeCodexServer({ name: 'context7', command: 'npx', args: [] }), false);
});

async function boardWithHome(t, home) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-toolbox-ws-'));
  const previous = process.env.USERPROFILE, previousHome = process.env.HOME;
  process.env.USERPROFILE = home; process.env.HOME = home;
  const storage = new Map();
  const fakeVscode = { workspace: { workspaceFolders: [{ name: 'Fixture', uri: { scheme: 'file', fsPath: root } }], getConfiguration: () => ({ get: (_, f) => f }) },
    commands: { executeCommand: async () => {} }, Uri: { file: fsPath => ({ fsPath }) },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showWarningMessage: async () => 'Đã kiểm tra' } };
  const location = require.resolve('../dist/extension');
  const make = () => {
    const m = new Module(location, module); m.filename = location; m.paths = Module._nodeModulePaths(path.dirname(location));
    const normal = m.require.bind(m); m.require = id => id === 'vscode' ? fakeVscode : normal(id);
    m._compile(require('node:fs').readFileSync(location, 'utf8'), location);
    return new m.exports.Board({ globalStorageUri: { fsPath: path.join(root, '.gs') }, subscriptions: [],
      workspaceState: { get: (k, f) => storage.get(k) ?? f, update: async (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))) },
      secrets: { get: async () => 'key', store: async () => {} } });
  };
  const board = make();
  t.after(async () => { board.dispose(); await board.hub.closeAll(); process.env.USERPROFILE = previous; process.env.HOME = previousHome; await fs.rm(root, { recursive: true, force: true }); });
  return { board, storage, make };
}

test('enabled MCP: read-only tools run directly, write tools wait for CEO review, failures are never replayed', async t => {
  const { home, log } = await fakeHome(t);
  const { board, storage, make } = await boardWithHome(t, home);
  const sent = []; board.send = m => sent.push(m);
  await board.handle({ type: 'create', brief: 'MCP' });
  const session = board.sessions[0], task = session.tasks[0];
  await assert.rejects(board.executeTool(session, task, 'mcp_list_tools', { serverId: 'codex-fake' }), /chưa được CEO bật/);
  await board.handle({ type: 'toolboxScan' });
  assert.equal(storage.get('toolbox').servers.length, 3); assert.deepEqual(storage.get('mcpEnabled'), []);
  assert.doesNotMatch(JSON.stringify(storage.get('toolbox')), /s3cr3t/);
  await board.handle({ type: 'mcpToggle', id: 'codex-fake', enabled: true });
  const tools = JSON.parse(await board.executeTool(session, task, 'mcp_list_tools', { serverId: 'codex-fake' }));
  assert.deepEqual(tools.map(x => [x.name, x.readOnly]), [['lookup', true], ['write', false]]);
  const read = JSON.parse(await board.executeTool(session, task, 'mcp_call', { serverId: 'codex-fake', tool: 'lookup', argumentsJson: '{"q":"whoosh"}', reason: 'tra' }));
  assert.equal(read.text, 'found whoosh');
  const queued = JSON.parse(await board.executeTool(session, task, 'mcp_call', { serverId: 'codex-fake', tool: 'write', argumentsJson: '{"text":"ok"}', reason: 'ghi' }));
  assert.equal(queued.state, 'pending_user_review');
  await assert.rejects(fs.readFile(log, 'utf8'), { code: 'ENOENT' }); // nothing dispatched yet
  await assert.rejects(board.executeTool(session, { ...task, roleId: 'reviewer' }, 'mcp_call', { serverId: 'codex-fake', tool: 'write', argumentsJson: '{"text":"r"}', reason: 'r' }), /chỉ đọc/);
  task.status = 'review';
  await assert.rejects(board.handle({ type: 'approve', taskId: task.id }), /MCP/);
  await board.handle({ type: 'mcpExecute', id: queued.proposalId });
  assert.equal(await fs.readFile(log, 'utf8'), 'ok\n');
  assert.equal(board.mcpPlans[0].state, 'success');
  await assert.rejects(board.handle({ type: 'mcpExecute', id: queued.proposalId }), /Không tự chạy lại/);
  // A failing call becomes uncertain and holds the queue; nothing re-sends it.
  const failing = JSON.parse(await board.executeTool(session, task, 'mcp_call', { serverId: 'codex-fake', tool: 'write', argumentsJson: '{"text":"fail"}', reason: 'f' }));
  const next = JSON.parse(await board.executeTool(session, task, 'mcp_call', { serverId: 'codex-fake', tool: 'write', argumentsJson: '{"text":"later"}', reason: 'l' }));
  await board.handle({ type: 'mcpExecute', id: failing.proposalId });
  assert.equal(board.mcpPlans.find(p => p.id === failing.proposalId).state, 'uncertain'); assert.equal(board.mcpHold, true);
  await assert.rejects(board.handle({ type: 'mcpExecute', id: next.proposalId }), /chưa rõ/);
  assert.equal(await fs.readFile(log, 'utf8'), 'ok\nfail\n');
  await board.handle({ type: 'mcpResolve' }); assert.equal(board.mcpHold, false);
  // A reload while dispatching reconciles instead of replaying.
  storage.set('mcpPlans', storage.get('mcpPlans').map(p => p.id === next.proposalId ? { ...p, state: 'dispatching' } : p));
  const reloaded = make(); await reloaded.initialize();
  assert.equal(reloaded.mcpPlans.find(p => p.id === next.proposalId).state, 'uncertain'); assert.equal(reloaded.mcpHold, true);
  reloaded.dispose();
});

test('model only sees skill/MCP tools when something is installed or enabled', async t => {
  const { home } = await fakeHome(t);
  const { board } = await boardWithHome(t, home);
  let seen; global.fetchBackup = global.fetch;
  global.fetch = async (_, init) => { seen = JSON.parse(init.body); return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }); };
  t.after(() => { global.fetch = global.fetchBackup; });
  const { defaultConfig } = require('../dist/core');
  board.config = { ...defaultConfig(), openaiBaseUrl: 'https://mock.invalid/v1', anthropicBaseUrl: 'https://mock.invalid/v1', roles: defaultConfig().roles.map(r => ({ ...r, protocol: r.id === 'image' ? r.protocol : 'responses' })) };
  await board.handle({ type: 'create', brief: 'Tools' });
  const session = board.sessions[0];
  session.state = 'running'; session.tasks[0].status = 'running';
  await board.runTask(session, session.tasks[0], new AbortController());
  assert.ok(!seen.tools.some(x => ['list_skills', 'mcp_call'].includes(x.name)));
  await board.handle({ type: 'toolboxScan' });
  session.tasks[0].status = 'running'; await board.runTask(session, session.tasks[0], new AbortController());
  assert.ok(seen.tools.some(x => x.name === 'read_skill')); assert.ok(!seen.tools.some(x => x.name === 'mcp_call'));
  await board.handle({ type: 'mcpToggle', id: 'codex-fake', enabled: true });
  session.tasks[0].status = 'running'; await board.runTask(session, session.tasks[0], new AbortController());
  assert.ok(seen.tools.some(x => x.name === 'mcp_call'));
  assert.match(JSON.stringify(seen.input), /codex-fake/); assert.doesNotMatch(JSON.stringify(seen), /s3cr3t/);
});
