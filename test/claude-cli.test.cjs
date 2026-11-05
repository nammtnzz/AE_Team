const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCliOutput, CLI_SCHEMA } = require('../dist/claude-cli');
// Never read the real ~/.claude/settings.json in tests: point the CLI bridge at an empty home.
const claudeHome = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'aect-claude-home-'));
process.env.AECT_CLAUDE_HOME = claudeHome;
const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }];
test('official CLI bridge validates structured output and maps custom tool calls', () => {
  const result = parseCliOutput(JSON.stringify({
    structured_output: { text: 'Need a file', toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"Level.cs"}' }] },
    num_turns: 2, usage: { input_tokens: 30, output_tokens: 15 }
  }), tools, 1);
  assert.equal(result.calls[0].name, 'read_file');
  assert.equal(result.calls[0].arguments.path, 'Level.cs');
  assert.equal(result.inputTokens, 30);
  assert.deepEqual(CLI_SCHEMA.required, ['text', 'toolCalls']);
});
test('CLI bridge rejects missing structured output, unknown tools and malformed arguments', () => {
  assert.throws(() => parseCliOutput('{"result":"unstructured"}', tools, 1), /structured_output/);
  assert.throws(() => parseCliOutput(JSON.stringify({ structured_output: { text: '', toolCalls: [
    { name: 'Bash', argumentsJson: '{}' }
  ] } }), tools, 1), /ngoài phạm vi/);
  assert.throws(() => parseCliOutput(JSON.stringify({ structured_output: { text: '', toolCalls: [
    { name: 'read_file', argumentsJson: '[]' }
  ] } }), tools, 1), /không hợp lệ/);
  assert.throws(() => parseCliOutput('{"is_error":true,"result":"permission denied"}', tools, 1), /permission denied/);
});

// Loads the CLI bridge with a fake spawn that records how Claude Code would be launched.
function loadWithFakeSpawn(stdout) {
  const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs');
  const { EventEmitter } = require('node:events');
  const location = require.resolve('../dist/claude-cli'); const launches = [];
  const fake = { spawn(executable, args, options) {
    launches.push({ executable, args, env: options.env });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() {} };
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', 0); });
    child.kill = () => {}; return child;
  } };
  const mod = new Module(location, module); mod.filename = location; mod.paths = Module._nodeModulePaths(path.dirname(location));
  const normal = mod.require.bind(mod); mod.require = id => id === 'node:child_process' ? fake : normal(id);
  mod._compile(fs.readFileSync(location, 'utf8'), location);
  return { api: mod.exports, launches };
}
const answer = JSON.stringify({ structured_output: { text: 'ok', toolCalls: [] }, usage: {} });
const options = (apiKey) => ({ executable: 'claude.exe', cwd: '.', baseUrl: 'https://gateway.invalid/v1', apiKey, model: 'claude-opus-5',
  system: 's', prompt: 'p', maxTokens: 1000, tools, signal: new AbortController().signal });

test('without an API key the CLI runs on the signed-in Claude account (no --bare, no key override)', async () => {
  const { api, launches } = loadWithFakeSpawn(answer);
  process.env.ANTHROPIC_API_KEY = 'leaked-env-key';
  try { await new api.ClaudeCliConversation(options('')).turn(); } finally { delete process.env.ANTHROPIC_API_KEY; }
  const launch = launches[0];
  assert.ok(!launch.args.includes('--bare'), '--bare only accepts API keys');
  // Connects like the user's own Claude Code (user settings), with hooks, tools, MCP and slash commands off.
  assert.equal(launch.args[launch.args.indexOf('--setting-sources') + 1], 'user');
  assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]), { disableAllHooks: true });
  assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
  assert.ok(launch.args.includes('--strict-mcp-config') && launch.args.includes('--disable-slash-commands'), 'still isolated');
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined); assert.equal(launch.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'claude-opus-5');
});

test('with an API key the CLI keeps bare mode and the configured gateway', async () => {
  const { api, launches } = loadWithFakeSpawn(answer);
  await new api.ClaudeCliConversation(options('secret-key')).turn();
  assert.ok(launches[0].args.includes('--bare') && launches[0].args.includes('--restricted') && !launches[0].args.includes('--setting-sources'));
  assert.equal(launches[0].env.ANTHROPIC_API_KEY, 'secret-key'); assert.equal(launches[0].env.ANTHROPIC_BASE_URL, 'https://gateway.invalid');
});

test('claudeAccountReady reads the signed-in state from `claude auth status`', async () => {
  assert.equal(await loadWithFakeSpawn('{"loggedIn":true,"authMethod":"oauth_token"}').api.claudeAccountReady('claude.exe'), true);
  assert.equal(await loadWithFakeSpawn('{"loggedIn":false}').api.claudeAccountReady('claude.exe'), false);
  assert.equal(await loadWithFakeSpawn('not json').api.claudeAccountReady('claude.exe'), false);
});

test('without an AE_Team key the CLI reuses the API/gateway configured for Claude Code', async () => {
  const fs = require('node:fs'), path = require('node:path');
  fs.mkdirSync(path.join(claudeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, '.claude', 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://llmproxy.example/', ANTHROPIC_AUTH_TOKEN: 'gateway-token-123', ANTHROPIC_DEFAULT_OPUS_MODEL: 'x', OTHER: 'ignored' } }));
  try {
    const { api, launches } = loadWithFakeSpawn(answer);
    await new api.ClaudeCliConversation(options('')).turn();
    assert.equal(launches[0].env.ANTHROPIC_BASE_URL, 'https://llmproxy.example/');
    assert.equal(launches[0].env.ANTHROPIC_AUTH_TOKEN, 'gateway-token-123');
    assert.equal(launches[0].env.OTHER, undefined, 'only connection values pass through --restricted');
    assert.ok(!launches[0].args.includes('--bare') && launches[0].args.includes('--setting-sources'));
    assert.equal(await api.claudeAccountReady('claude.exe'), true, 'a configured gateway counts as connected');
    const failing = loadWithFakeSpawn(JSON.stringify({ is_error: true, result: 'bad token gateway-token-123' }));
    const conversation = new failing.api.ClaudeCliConversation(options(''));
    await assert.rejects(conversation.turn(), error => !error.message.includes('gateway-token-123'));
  } finally { fs.rmSync(path.join(claudeHome, '.claude'), { recursive: true, force: true }); }
});

test('a Claude Code apiKeyHelper counts as connected', async () => {
  const fs = require('node:fs'), path = require('node:path');
  fs.mkdirSync(path.join(claudeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'node get-key.js' }));
  try { assert.equal(await loadWithFakeSpawn('{"loggedIn":false}').api.claudeAccountReady('claude.exe'), true); }
  finally { fs.rmSync(path.join(claudeHome, '.claude'), { recursive: true, force: true }); }
});
