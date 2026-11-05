const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportShared, mergeShared } = require('../tools/TeamKnowledge.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aect-share-'));
const write = (dir, lessons) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'lessons.json'), JSON.stringify({ schema: 'codex-ae-knowledge/v1', lessons })); };
const lesson = (title, extra = {}) => ({ id: title, title, lesson: 'Cách làm ' + title, kind: 'tip', tags: [], project: '', roles: [],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', confirmations: 1, ...extra });

test('lessons travel sanitized and merge into another machine without overwriting its own learning', () => {
  const source = path.join(tmp(), 'knowledge'), shared = path.join(tmp(), 'shared-lessons.json');
  write(source, [
    lesson('Text pop', { lesson: '1. Scale 110% → 100% · lưu ở C:\\Users\\alice\\Desktop\\pop.aep', roles: ['gameplay'], project: 'E:/Task/Drop Fit', confirmations: 4 }),
    lesson('Key', { lesson: 'api_key=abc123' }),
    lesson('Glow xanh', { kind: 'preference', updatedAt: '2026-11-02T00:00:00Z' })
  ]);
  assert.equal(exportShared(source, shared).exported, 2, 'lessons containing secrets never ship');
  const text = fs.readFileSync(shared, 'utf8');
  assert.ok(!/Users[\\/]+alice/.test(text) && text.includes('%USERPROFILE%'), 'personal paths are removed');
  const exported = JSON.parse(text).lessons;
  assert.equal(exported.find(l => l.title === 'Text pop').project, 'Drop Fit', 'only the project name travels');
  assert.deepEqual(exported.find(l => l.title === 'Text pop').roles, ['gameplay'], 'seat hand-off is kept');

  const target = path.join(tmp(), 'knowledge');
  write(target, [lesson('Glow xanh', { lesson: 'Bản mới của máy kia', updatedAt: '2999-01-01T00:00:00Z', confirmations: 9 }), lesson('Chỉ máy này')]);
  const merged = mergeShared(shared, target);
  assert.deepEqual([merged.added, merged.kept], [1, 1]);
  const lessons = JSON.parse(fs.readFileSync(path.join(target, 'lessons.json'), 'utf8')).lessons;
  assert.ok(lessons.some(l => l.title === 'Chỉ máy này'), 'the receiving machine keeps its own lessons');
  assert.equal(lessons.find(l => l.title === 'Glow xanh').lesson, 'Bản mới của máy kia', 'newer local learning wins');
  assert.equal(lessons.find(l => l.title === 'Text pop').confirmations, 4);
  assert.equal(mergeShared(shared, target).added, 0, 'reinstalling the same release adds nothing twice');
});

test('no lessons means no shared file; a missing or foreign file merges nothing', () => {
  const empty = path.join(tmp(), 'knowledge'), shared = path.join(tmp(), 'shared.json');
  assert.equal(exportShared(empty, shared).exported, 0); assert.equal(fs.existsSync(shared), false);
  fs.writeFileSync(shared, JSON.stringify({ schema: 'other', lessons: [lesson('x')] }));
  assert.equal(mergeShared(shared, path.join(tmp(), 'k')).added, 0);
});
