const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KnowledgeStore, runLearning, knowledgeBlock, readLearningStatus, LEARNING_MODEL, LEARNING_TOOLS } = require('../dist/learning');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aect-learning-'));
const history = [
  { id: 's1', at: 1, name: 'Drop Fit ad', brief: 'Làm quảng cáo Drop Fit', feedback: ['qa: glow màu xanh, không phải vàng'], problems: [] },
  { id: 's2', at: 2, name: 'Arrow 3D', brief: 'Text pop', feedback: [], problems: ['Render: missing font'] }
];
// Scripted model: each turn returns the next set of tool calls; the final turn has no calls.
function scripted(turns) {
  const results = [];
  return { results, conversation: { async turn() { const next = turns.shift() || { text: 'Đã học xong', calls: [] }; return { raw: {}, inputTokens: 0, outputTokens: 0, text: next.text || '', calls: next.calls || [] }; },
    toolResults(r) { results.push(...r); } } };
}
const call = (name, args, id = name) => ({ id, name, arguments: args });

test('learning is delegated to Claude Opus 5 with only learning tools', () => {
  assert.equal(LEARNING_MODEL, 'claude-opus-5');
  assert.deepEqual(LEARNING_TOOLS.map(t => t.name).sort(), ['fetch_source', 'list_sources', 'mark_history_learned', 'read_history', 'recall_knowledge', 'report_progress', 'save_lesson']);
});

test('a learning run reads history and sources, saves lessons and finishes at 100%', async () => {
  const store = new KnowledgeStore(tmp());
  const fetched = [];
  const { conversation, results } = scripted([
    { calls: [call('read_history', { limit: 5 })] },
    { calls: [call('save_lesson', { title: 'Glow màu xanh', lesson: 'CEO muốn glow xanh, không vàng', kind: 'preference', project: 'Drop Fit' }), call('mark_history_learned', { ids: ['s1', 's2'] })] },
    { calls: [call('fetch_source', { url: 'https://helpx.adobe.com/after-effects/user-guide.html' }), call('report_progress', { phase: 'web', message: 'Adobe', percent: 90 })] },
    { calls: [call('save_lesson', { title: 'Easy ease', lesson: 'F9 áp easy ease 33% cho keyframe đã chọn', kind: 'tip' })] }
  ]);
  const statuses = [];
  const final = await runLearning({ topic: 'easing', store, history, conversation, signal: new AbortController().signal, isPaused: () => false,
    onStatus: s => statuses.push(s), fetchText: async url => { fetched.push(url); return 'Easy ease…'; } });
  assert.equal(final.state, 'done'); assert.equal(final.percent, 100); assert.equal(final.lessonsSaved, 2);
  assert.equal(final.historyLearned, 2); assert.equal(final.historyTotal, 2);
  assert.deepEqual(fetched, ['https://helpx.adobe.com/after-effects/user-guide.html']);
  assert.ok(statuses.some(s => s.percent === 70), 'history done reaches 70% before web research');
  assert.equal(JSON.parse(results[0].output).sessions.length, 2);
  assert.equal((await store.lessons()).length, 2);
  assert.equal((await readLearningStatus(store)).state, 'done');
});

test('pause stops between turns; resume continues without re-reading learned history', async () => {
  const store = new KnowledgeStore(tmp());
  let paused = false;
  const first = scripted([
    { calls: [call('save_lesson', { title: 'A', lesson: 'Bài A' }), call('mark_history_learned', { ids: ['s1'] })] },
    { calls: [call('read_history', {})] }
  ]);
  const onStatus = s => { if (s.lessonsSaved === 1) paused = true; };
  const stopped = await runLearning({ topic: '', store, history, conversation: first.conversation, signal: new AbortController().signal, isPaused: () => paused, onStatus });
  assert.equal(stopped.state, 'paused'); assert.equal(stopped.lessonsSaved, 1); assert.equal(stopped.historyLearned, 1);
  paused = false;
  const second = scripted([{ calls: [call('read_history', {})] }]);
  const resumed = await runLearning({ topic: '', store, history, conversation: second.conversation, signal: new AbortController().signal, isPaused: () => false, onStatus() {} });
  assert.equal(resumed.state, 'done');
  assert.deepEqual(JSON.parse(second.results[0].output).sessions.map(s => s.id), ['s2'], 'only unlearned history is offered again');
  assert.equal(resumed.lessonsSaved, 1, 'lesson count carries over a paused run');
});

test('secrets and unknown tools are refused; lessons reinforce instead of duplicating', async () => {
  const store = new KnowledgeStore(tmp());
  const { conversation, results } = scripted([
    { calls: [call('save_lesson', { title: 'Key', lesson: 'api_key=abc' }, 'a'), call('run_shell', { cmd: 'dir' }, 'b'),
      call('save_lesson', { title: 'Glow', lesson: 'radius 40' }, 'c'), call('save_lesson', { title: 'glow', lesson: 'radius 35' }, 'd')] }
  ]);
  await runLearning({ topic: '', store, history: [], conversation, signal: new AbortController().signal, isPaused: () => false, onStatus() {} });
  assert.match(results[0].output, /bí mật/); assert.match(results[1].output, /không có trong phiên học/);
  const lessons = await store.lessons();
  assert.equal(lessons.length, 1); assert.equal(lessons[0].lesson, 'radius 35'); assert.equal(lessons[0].confirmations, 2);
});

test('relevant lessons are injected into team prompts; unrelated ones are not', async () => {
  const store = new KnowledgeStore(tmp());
  await store.save({ title: 'Glow cho text', lesson: 'Deep Glow radius 35', kind: 'tip', project: 'Drop Fit' });
  await store.save({ title: 'Âm thanh whoosh', lesson: 'Whoosh -6dB', kind: 'tip' });
  const block = await knowledgeBlock(store, 'thêm glow cho text', 'Arrow');
  assert.match(block, /Glow cho text/); assert.doesNotMatch(block, /whoosh/i);
  assert.equal(await knowledgeBlock(store, 'xuất phim mp4'), '');
});

test('YouTube watch and search pages yield titles, descriptions and watch links', () => {
  const { extractYouTube } = require('../dist/learning');
  const watch = '<meta name="title" content="Smooth Text Animation in After Effects"><script>var x={"shortDescription":"Easy ease 80%\nGraph Editor"}</script>';
  assert.match(extractYouTube(watch), /VIDEO: Smooth Text Animation[\s\S]*MÔ TẢ: Easy ease 80%\nGraph Editor/);
  const search = '{"videoId":"abcdefghijk","thumbnail":{},"title":{"runs":[{"text":"Bounce expression"}]}} {"videoId":"abcdefghijk","title":{"runs":[{"text":"dup"}]}}';
  assert.equal(extractYouTube(search), 'https://www.youtube.com/watch?v=abcdefghijk · Bounce expression');
});

test('automatic topics stay within After Effects animation and rotate', () => {
  const { ANIMATION_TOPICS, nextAnimationTopic, LEARNING_SYSTEM, LEARNING_SOURCES } = require('../dist/learning');
  assert.equal(nextAnimationTopic(''), ANIMATION_TOPICS[0]);
  assert.equal(nextAnimationTopic(ANIMATION_TOPICS[0]), ANIMATION_TOPICS[1]);
  assert.equal(nextAnimationTopic(ANIMATION_TOPICS.at(-1)), ANIMATION_TOPICS[0]);
  assert.match(LEARNING_SYSTEM, /chỉ học về After Effects animation/);
  assert.ok(LEARNING_SOURCES.some(s => /youtube\.com\/results/.test(s.url)), 'YouTube is a learning source');
});

test('learned how-tos are handed to the seat that does the work', async () => {
  const store = new KnowledgeStore(tmp());
  await store.save({ title: 'Text pop', lesson: '1. Scale 0→110→100% trong 6 frame\n2. Easy ease 80%', kind: 'tip', roles: ['gameplay'] });
  await store.save({ title: 'Whoosh cho text pop', lesson: '1. Whoosh -6dB, lệch 2 frame trước keyframe', kind: 'tip', roles: ['sfx_vfx'] });
  await store.save({ title: 'Text pop luôn đọc được', lesson: 'Giữ chữ trong safe area 90%', kind: 'preference' });
  const animator = await knowledgeBlock(store, 'text pop', '', { id: 'gameplay', name: 'Diễn hoạt' });
  assert.match(animator, /CÁCH LÀM ĐÃ HỌC CHO DIỄN HOẠT/);
  assert.match(animator, /Scale 0→110→100%/); assert.match(animator, /safe area/, 'shared lessons reach every seat');
  assert.doesNotMatch(animator, /Whoosh/, 'another seat\'s how-to stays out of this prompt');
  const fx = await knowledgeBlock(store, 'text pop', '', { id: 'sfx_vfx', name: 'Hình ảnh & âm thanh' });
  assert.match(fx, /Whoosh/); assert.doesNotMatch(fx, /Scale 0→110/);
  await assert.rejects(store.save({ title: 'x', lesson: 'y', roles: ['qa'] }), /roles chỉ gồm/);
  const { LEARNING_TOOLS, LEARNING_SYSTEM } = require('../dist/learning');
  assert.ok(LEARNING_TOOLS.find(t => t.name === 'save_lesson').parameters.properties.roles);
  assert.match(LEARNING_SYSTEM, /BÀN GIAO CÁCH LÀM/);
});
