const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const THREE = require('three');
const { transformSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { defaultConfig, newSession } = require('../dist/core');
const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/office.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

function setup() {
  const dom = new JSDOM('<div id="host"><div class="office-message"></div></div>');
  const host = dom.window.document.getElementById('host');
  Object.defineProperties(host, { clientWidth: { value: 700 }, clientHeight: { value: 620 } });
  let hidden = false, intersect; Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  const ctx = { fillRect() {}, fillText() {}, strokeRect() {} };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ctx;
  const raf = new Map(), timers = new Map(); let id = 0, renderer;
  const media = { matches: false, addEventListener(type, fn) { this.listener = fn; }, removeEventListener() { this.listener = undefined; } };
  dom.window.matchMedia = () => media;
  class Renderer {
    constructor({ canvas }) { this.canvas = canvas; this.shadowMap = {}; this.capabilities = { getMaxAnisotropy: () => 4 }; this.renders = 0; renderer = this; }
    setPixelRatio() {} setClearColor() {}
    setSize(w, h) { this.canvas.width = w; this.canvas.height = h; }
    render(scene, camera) { this.renders++; this.scene = scene; this.camera = camera; }
    dispose() { this.disposed = true; }
  }
  class Controls extends THREE.EventDispatcher {
    constructor(camera) { super(); this.camera = camera; this.target = new THREE.Vector3(); }
    update() { this.camera.lookAt(this.target); this.dispatchEvent({ type: 'change' }); }
    dispose() {}
  }
  const context = {
    exports: {}, window: dom.window, document: dom.window.document,
    require: name => name === 'three' ? { ...THREE, WebGLRenderer: Renderer } : name.includes('OrbitControls') ? { OrbitControls: Controls } : name === './work-status' ? require('../dist/work-status') : require('../dist/office-model'),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { constructor(fn) { intersect = fn; } observe() {} disconnect() {} },
    requestAnimationFrame: fn => { const key = ++id; raf.set(key, fn); return key; }, cancelAnimationFrame: key => raf.delete(key),
    setTimeout: fn => { const key = ++id; timers.set(key, fn); return key; }, clearTimeout: key => timers.delete(key)
  };
  vm.runInNewContext(source, context);
  const office = dom.window.AETeamOffice(host, () => {});
  const value = { roles: defaultConfig().roles, tasks: newSession('Renderer').tasks, selectedRole: 'lead', demo: false, previewMotion: false };
  office.update(value);
  const frame = at => { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(fn => fn(at)); };
  return { dom, host, office, value, raf, timers, frame, media, renderer: () => renderer, runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }, intersection(value) { intersect([{ isIntersecting: value }]); }, visibility(value) { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); } };
}

test('3D scene updates correct head station after reordering; camera labels project and textures stay cached', t => {
  const s = setup(); t.after(() => { s.office.dispose(); s.dom.window.close(); });
  s.value.roles.reverse(); s.office.update(s.value); s.office.setActive(true); s.frame(100);
  const lead = s.host.querySelector('.office-label-lead');
  assert.ok(lead.textContent.includes('PO · Điều phối')); assert.ok(lead.getAttribute('aria-pressed') === 'true');
  assert.equal(s.host.querySelectorAll('.office-label').length, 10);
  for (const mode of ['iso', 'front', 'top']) {
    s.office.camera(mode); s.frame(200);
    for (const x of [-10, 10]) for (const z of [-9.5, 9.5]) {
      const corner = new THREE.Vector3(x, 0, z).project(s.renderer().camera);
      assert.ok(Math.abs(corner.x) < 1 && Math.abs(corner.y) < 1, mode + ' should fit the room');
    }
  }
  s.office.camera('top'); s.frame(200);
  assert.ok([...s.host.querySelectorAll('.office-label')].every(label => !label.hidden && !label.style.transform.includes('NaN')));
  const maps = [];
  s.renderer().scene.traverse(object => { if (object.material?.map) maps.push(object.material.map); });
  let updated = 0; const previous = maps.map(m => m.version);
  for (let i = 0; i < 5; i++) s.office.update(s.value);
  maps.forEach((m, i) => { if (m.version !== previous[i]) updated++; });
  assert.equal(updated, 0);
});

test('3D working animation stops all timers/frames when hidden and honors reduced motion', t => {
  const s = setup(); t.after(() => s.dom.window.close());
  s.value.tasks[0].status = 'running'; s.office.update(s.value); s.office.setActive(true); s.frame(100);
  assert.equal(s.host.classList.contains('work-motion'), true);
  assert.equal(s.timers.size, 1);
  s.visibility(true); assert.equal(s.timers.size, 0); assert.equal(s.raf.size, 0);
  assert.equal(s.host.classList.contains('work-motion'), false);
  s.visibility(false); s.frame(200); assert.equal(s.timers.size, 1);
  s.intersection(false); assert.equal(s.timers.size, 0); assert.equal(s.raf.size, 0);
  assert.equal(s.host.classList.contains('work-motion'), false);
  s.office.update(s.value); assert.equal(s.raf.size, 0);
  s.intersection(true); s.frame(250); assert.equal(s.timers.size, 1);
  s.office.setActive(false); assert.equal(s.timers.size, 0); assert.equal(s.raf.size, 0);
  assert.equal(s.host.classList.contains('work-motion'), false);
  s.media.matches = true; s.office.setActive(true); s.frame(300); assert.equal(s.timers.size, 0);
  s.office.dispose(); assert.equal(s.host.querySelectorAll('canvas,.office-label').length, 0);
  assert.equal(s.renderer().disposed, true); assert.equal(s.raf.size, 0); assert.equal(s.timers.size, 0);
});

test('GPU context loss cancels animation, reports recovery and does not restart from a state update', t => {
  const s = setup(); t.after(() => { s.office.dispose(); s.dom.window.close(); });
  s.value.demo = true; s.value.previewMotion = true; s.office.update(s.value); s.office.setActive(true); s.frame(100);
  s.host.querySelector('canvas').dispatchEvent(new s.dom.window.Event('webglcontextlost', { cancelable: true }));
  assert.equal(s.timers.size, 0); assert.equal(s.raf.size, 0);
  assert.equal(s.host.classList.contains('work-motion'), false);
  assert.equal(s.host.querySelector('.office-message').hidden, false);
  assert.ok(s.host.querySelector('.office-message').textContent.includes('GPU'));
  s.office.update(s.value); s.office.setActive(true); assert.equal(s.raf.size, 0);
});

test('3D positions show actual work bars and chat/image work drives motion without repainting task screens', t => {
  const s = setup(); t.after(() => { s.office.dispose(); s.dom.window.close(); });
  assert.equal(s.host.querySelectorAll('.office-work-indicator').length, 10);
  const qaRole = s.value.roles.find(role => role.id === 'qa');
  const qa = [...s.host.querySelectorAll('.office-label')].find(label => label.querySelector('strong').textContent === qaRole.name);
  s.office.setActive(true); s.frame(100);
  const textures = []; s.renderer().scene.traverse(object => { if (object.material?.map) textures.push(object.material.map); });
  const versions = textures.map(texture => texture.version);
  s.value.workStatuses = { qa: { state: 'running', label: 'Đang xử lý', detail: 'QA answering' }, image: { state: 'running', label: 'Đang xử lý', detail: 'Generating' } };
  s.office.update(s.value); s.frame(200);
  assert.equal(qa.dataset.work, 'running'); assert.equal(qa.querySelector('.work-label').textContent, 'Đang xử lý');
  assert.equal(qa.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'), false);
  assert.equal(s.timers.size, 1);
  textures.forEach((texture, i) => assert.equal(texture.version, versions[i]));
  s.value.workStatuses = { qa: { state: 'done', label: 'Xong', detail: 'Answered' }, image: { state: 'done', label: 'Xong', detail: 'Created file' } };
  s.office.update(s.value); s.runTimers(); s.frame(300);
  assert.equal(qa.dataset.work, 'done'); assert.equal(qa.querySelector('.work-label').textContent, 'Xong');
  assert.equal(qa.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100');
  assert.equal(s.timers.size, 0); assert.equal(s.raf.size, 0);
  assert.match(qa.title, /0\/0 task đã duyệt/);
});

test('3D completion is green before approval and preserves the separate approval count', t => {
  const s = setup(); t.after(() => { s.office.dispose(); s.dom.window.close(); });
  const role = s.value.roles.find(role => role.id === 'gameplay');
  const task = s.value.tasks.find(task => task.roleId === role.id); task.status = 'review';
  s.office.update(s.value);
  const label = [...s.host.querySelectorAll('.office-label')].find(label => label.querySelector('strong').textContent === role.name);
  assert.equal(label.dataset.work, 'done'); assert.equal(label.querySelector('.work-label').textContent, 'Xong');
  assert.match(label.querySelector('[role="progressbar"]').getAttribute('aria-valuetext'), /Chờ duyệt/);
  assert.match(label.title, /0\/1 task đã duyệt/);
  task.status = 'approved'; s.office.update(s.value);
  assert.equal(label.dataset.work, 'done'); assert.match(label.title, /1\/1 task đã duyệt/);
});
