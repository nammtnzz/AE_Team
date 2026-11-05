const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultConfig, validateConfig, upgradeConfig, newSession, readyTasks, refreshDependencyBlocks, retryTask, demoSession } = require('../dist/core');

test('AE preset migration retains model routes and replaces the old Unity workflow', () => {
  const old = { ...defaultConfig(), name: 'Unity Level Production', openaiBaseUrl: 'https://mock.invalid/v1' };
  old.roles[2].model = 'custom-model';
  const next = upgradeConfig(old);
  assert.equal(next.roles[2].model, 'custom-model');
  assert.equal(next.openaiBaseUrl, old.openaiBaseUrl);
  assert.equal(next.roles[2].name, 'Diễn hoạt');
  assert.ok(!JSON.stringify(next).includes('Unity'));
  const session = newSession('Motion poster');
  for (const id of ['animation', 'layout', 'fx']) {
    assert.deepEqual(session.tasks.find(t => t.id === id).dependencies, ['architecture', 'art']);
  }
});

test('preset has nine roles with a dedicated image skill and intake QA', () => {
  const config = validateConfig(defaultConfig());
  assert.equal(new Set(config.roles.map(r => r.id)).size, 10);
  assert.equal(config.roles.filter(r => r.model === 'claude-opus-5-5').length, 2);
  assert.equal(config.roles.filter(r => r.model === 'claude-sonnet-5').length, 3);
  assert.equal(config.roles.filter(r => r.protocol === 'responses').length, 2);
  assert.deepEqual(config.roles.filter(r => r.model.includes('image')).map(r => r.id), ['image']);
  assert.equal(config.roles.find(r => r.id === 'qa').model, 'claude-haiku-5-5');
});
test('config rejects invalid roles, protocols and credential-bearing URLs; drops imported secrets', () => {
  const config = defaultConfig();
  assert.throws(() => validateConfig({ ...config, roles: config.roles.slice(1) }));
  assert.throws(() => validateConfig({ ...config, openaiBaseUrl: 'https://key@example.com/v1' }));
  assert.throws(() => validateConfig({ ...config, anthropicBaseUrl: 'https://example.com/v1?key=secret' }));
  assert.throws(() => validateConfig({ ...config, maxParallel: 0 }));
  const clean = validateConfig({ ...config, apiKey: 'do-not-persist', roles: config.roles.map(r => ({ ...r, apiKey: 'secret' })) });
  assert.ok(!JSON.stringify(clean).includes('secret'));
});
test('dependencies require approval; art and architecture unlock after brief', () => {
  const session = newSession('Build a Unity level');
  assert.deepEqual(readyTasks(session).map(t => t.id), ['brief']);
  session.tasks[0].status = 'review';
  assert.deepEqual(readyTasks(session), []);
  session.tasks[0].status = 'approved';
  assert.deepEqual(readyTasks(session).map(t => t.id), ['architecture', 'art']);
});
test('a failed dependency blocks descendants and retry releases only dependent blockers', () => {
  const session = newSession('Unity');
  session.tasks.find(t => t.id === 'architecture').status = 'blocked';
  session.tasks.find(t => t.id === 'architecture').error = 'HTTP 403';
  refreshDependencyBlocks(session);
  assert.equal(session.tasks.find(t => t.id === 'integration').status, 'blocked');
  assert.equal(session.tasks.find(t => t.id === 'delivery').status, 'blocked');
  assert.equal(session.tasks.find(t => t.id === 'art').status, 'assigned');
  retryTask(session, 'architecture');
  assert.ok(session.tasks.every(t => t.status === 'assigned'));
});
test('demo is explicitly marked and has no fabricated API metrics', () => {
  const session = demoSession();
  assert.equal(session.demo, true);
  assert.ok(session.tasks.every(t => t.requestCount === 0 && t.inputTokens === 0));
  assert.ok(session.tasks.filter(t => t.result).every(t => t.result.includes('DEMO')));
});

test('saved configs with the invalid claude-haiku-5.5 ID move to claude-haiku-5-5', () => {
  const saved = defaultConfig(); saved.roles.find(r => r.id === 'qa').model = 'claude-haiku-5.5';
  assert.equal(upgradeConfig(saved).roles.find(r => r.id === 'qa').model, 'claude-haiku-5-5');
});

test('seven-role configs gain image and intake QA without losing custom settings', () => {
  const old = defaultConfig(); old.roles = old.roles.slice(0, 7);
  old.roles[0].model = 'custom-opus'; old.roles[0].systemPrompt = 'My custom prompt';
  const upgraded = upgradeConfig(old);
  assert.equal(upgraded.roles.length, 10);
  assert.deepEqual(upgraded.roles.slice(0, 7), old.roles);
  assert.equal(upgraded.roles[7].protocol, 'iw-imagegen');
  assert.equal(upgraded.roles[8].model, 'claude-haiku-5-5');
  assert.deepEqual(upgradeConfig(upgraded), upgraded);
  const bad = defaultConfig(); bad.roles[7].protocol = 'responses';
  assert.throws(() => validateConfig(bad), /iw-imagegen/);
  const missing = defaultConfig(); missing.roles = missing.roles.slice(3); // 7 roles without the original PO/architect seats
  assert.throws(() => validateConfig(missing), /Thiếu vai trò/);
});

test('10th seat Học tập runs Claude Opus 5 and only on a Claude protocol; 9-role configs gain it', () => {
  const config = defaultConfig(); const learn = config.roles.find(r => r.id === 'learn');
  assert.equal(config.roles.length, 10); assert.equal(config.roles[9].id, 'learn');
  assert.equal(learn.model, 'claude-opus-5'); assert.equal(learn.protocol, 'claude-cli');
  assert.throws(() => validateConfig({ ...config, roles: config.roles.map(r => r.id === 'learn' ? { ...r, protocol: 'responses' } : r) }), /Học tập/);
  const nine = defaultConfig(); nine.roles = nine.roles.slice(0, 9); nine.roles[0].model = 'custom-opus';
  const upgraded = upgradeConfig(nine);
  assert.equal(upgraded.roles.length, 10); assert.equal(upgraded.roles[0].model, 'custom-opus'); assert.equal(upgraded.roles[9].id, 'learn');
  assert.throws(() => validateConfig({ ...config, roles: [...config.roles.slice(1, 9), config.roles[9]] }), /vai trò/);
});

test('image seat (8th) uses the AE_Team-installed skill; saved default text migrates', () => {
  const image = defaultConfig().roles.find(r => r.id === 'image');
  assert.equal(defaultConfig().roles.findIndex(r => r.id === 'image'), 7);
  assert.equal(image.shortName, 'Skill AE_Team · iw-imagegen'); assert.match(image.systemPrompt, /\.claude\/skills/);
  const saved = defaultConfig(); Object.assign(saved.roles[7], { shortName: 'Codex skill · iw-imagegen', systemPrompt: 'Tạo raster qua skill Codex iw-imagegen' });
  const upgraded = upgradeConfig(saved).roles[7];
  assert.equal(upgraded.shortName, 'Skill AE_Team · iw-imagegen'); assert.match(upgraded.systemPrompt, /AE_Team cài/);
  const custom = defaultConfig(); custom.roles[7].shortName = 'Ảnh của tôi';
  assert.equal(upgradeConfig(custom).roles[7].shortName, 'Ảnh của tôi', 'custom names are kept');
});
