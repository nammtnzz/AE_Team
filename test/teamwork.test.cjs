const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultConfig, validateConfig, upgradeConfig } = require('../dist/core');
const { normalizeScope, inScope, scopesOverlap, applyEdits, budgetExceeded, estimateCost, sessionUsage } = require('../dist/teamwork');

test('budget and prices are validated, defaulted for old team.json and kept on upgrade', () => {
  const legacy = { ...defaultConfig() }; delete legacy.budget; delete legacy.prices;
  assert.deepEqual(validateConfig(legacy).budget, { maxCalls: 0, maxTokens: 0 });
  assert.deepEqual(validateConfig(legacy).prices, {});
  const priced = validateConfig({ ...defaultConfig(), budget: { maxCalls: 50, maxTokens: 0 }, prices: { 'claude-opus-5-5': { input: 15, output: 75 } } });
  assert.deepEqual(upgradeConfig(priced).prices, priced.prices);
  assert.throws(() => validateConfig({ ...defaultConfig(), budget: { maxCalls: -1 } }), /Ngân sách/);
  assert.throws(() => validateConfig({ ...defaultConfig(), prices: { m: { input: 'x', output: 1 } } }), /Giá/);
  assert.throws(() => validateConfig({ ...defaultConfig(), prices: [] }), /Bảng giá/);
});

test('scope normalisation, containment and overlap', () => {
  assert.equal(normalizeScope('.\\notes\\'), 'notes');
  assert.equal(normalizeScope('comp: Main '), 'comp:Main');
  for (const bad of ['../x', 'C:/x', '/abs', '', 'a/../b']) assert.throws(() => normalizeScope(bad));
  assert.equal(inScope('notes/cue.md', ['notes']), true);
  assert.equal(inScope('notesX/cue.md', ['notes']), false);
  assert.equal(inScope('any.md', undefined), true);
  assert.equal(inScope('any.md', ['comp:Main']), false);
  assert.equal(scopesOverlap(['notes'], ['notes/a.md']), true);
  assert.equal(scopesOverlap(['comp:Main'], ['comp:main']), true);
  assert.equal(scopesOverlap(['comp:Main'], ['main']), false);
  assert.equal(scopesOverlap([], ['notes']), false);
});

test('patch edits must match exactly once', () => {
  assert.equal(applyEdits('a b c', [{ oldText: 'b', newText: 'B' }]), 'a B c');
  assert.throws(() => applyEdits('a b', [{ oldText: 'z', newText: '' }]), /Không tìm thấy/);
  assert.throws(() => applyEdits('a a', [{ oldText: 'a', newText: '' }]), /nhiều lần/);
  assert.throws(() => applyEdits('a', []), /1–20/);
});

test('session usage counts tasks and chats; cost only from configured prices', () => {
  const config = { ...defaultConfig(), budget: { maxCalls: 3, maxTokens: 0 }, prices: { m1: { input: 10, output: 20 } } };
  const session = { tasks: [{ requestCount: 1, inputTokens: 1e6, outputTokens: 5e5, model: 'm1' }, { requestCount: 1, inputTokens: 10, outputTokens: 0, model: 'm2' }],
    chatUsage: { calls: 1, inputTokens: 5, outputTokens: 5 } };
  assert.deepEqual(sessionUsage(session), { calls: 3, input: 1000015, output: 500005, tokens: 1500020 });
  assert.match(budgetExceeded(config, session), /3 lượt gọi/);
  assert.equal(budgetExceeded({ ...config, budget: { maxCalls: 0, maxTokens: 0 } }, session), undefined);
  const cost = estimateCost(config, session);
  assert.equal(cost.cost, 20); assert.equal(cost.unpriced, 2);
});
