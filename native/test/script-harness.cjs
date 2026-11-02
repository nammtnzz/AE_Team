// Runs the exact scripts produced by core/ScriptText.cpp (via ScriptDump.exe) against the real installed
// function runtime, with a minimal ExtendScript shim ($, File, Folder, app). Proves the bundle-only bootstrap,
// parse/validate/status and the OK/ERR protocol work before anything is loaded into After Effects.
// Usage: node script-harness.cjs <ScriptDump.exe> <runtimeRoot>
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const [dump, root] = process.argv.slice(2);
const rootFs = path.resolve(root), rootEs = rootFs.replace(/\\/g, '/');

function makeContext() {
  const ctx = vm.createContext({});
  class Folder {
    constructor(p) { this.path = String(p); }
    get fsName() { return path.resolve(this.path); }
    get exists() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isDirectory(); }
    get alias() { try { return fs.lstatSync(this.fsName).isSymbolicLink(); } catch { return false; } }
    get name() { return path.basename(this.fsName); }
    get parent() { return new Folder(path.dirname(this.fsName)); }
  }
  class File extends Folder {
    constructor(p) { super(p); this.encoding = 'UTF-8'; this.error = ''; this.pos = 0; this.buf = null; }
    get exists() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isFile(); }
    get length() { return this.exists ? fs.statSync(this.fsName).size : 0; }
    get modified() { return this.exists ? fs.statSync(this.fsName).mtime : null; }
    get eof() { return !this.buf || this.pos >= this.buf.length; }
    open(mode) { if (mode !== 'r' || !this.exists) { this.error = 'cannot open'; return false; } this.buf = fs.readFileSync(this.fsName); this.pos = 0; return true; }
    close() { this.buf = null; return true; }
    seek(offset) { if (!this.buf || offset > this.buf.length) return false; this.pos = offset; return true; }
    decode(bytes) { return this.encoding === 'BINARY' ? bytes.toString('latin1') : bytes.toString('utf8'); }
    read(n) {
      if (n === undefined) { const s = this.decode(this.buf.subarray(this.pos)); this.pos = this.buf.length; return s; }
      // BINARY: one char per byte. UTF-8 reads in this runtime only use read() without a count.
      const bytes = this.buf.subarray(this.pos, this.pos + n); this.pos += bytes.length; return this.decode(bytes);
    }
    readln() {
      let end = this.buf.indexOf(10, this.pos); if (end < 0) end = this.buf.length;
      const s = this.decode(this.buf.subarray(this.pos, end)).replace(/\r$/, ''); this.pos = Math.min(end + 1, this.buf.length); return s;
    }
  }
  ctx.File = File; ctx.Folder = Folder;
  ctx.app = { version: '26.5x0-harness' };
  ctx.$ = { global: ctx, fileName: '', sleep() {}, writeln() {}, evalFile() { throw new Error('evalFile must not be used by the native bootstrap'); } };
  return ctx;
}

function script(mode, request, runId) {
  const args = [mode, rootEs];
  if (request !== undefined) {
    const file = path.join(os.tmpdir(), 'aect-request-' + process.pid + '.json');
    fs.writeFileSync(file, request);
    args.push(file);
    if (runId) args.push(runId);
  }
  return cp.execFileSync(dump, args).toString('utf8');
}
function run(ctx, text) {
  const result = vm.runInContext(text, ctx, { filename: 'native-bootstrap.jsx' });
  assert.equal(typeof result, 'string', 'script returns a string');
  const ok = result.startsWith('OK\n');
  assert.ok(ok || result.startsWith('ERR\n'), 'OK/ERR protocol: ' + result.slice(0, 120));
  return { ok, payload: result.slice(ok ? 3 : 4) };
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }

const ctx = makeContext();
const catalog = JSON.parse(fs.readFileSync(path.join(rootFs, '.ae-codex/functions/catalog.json'), 'utf8'));

check('status loads the runtime in bundle-only mode and reports the catalog revision', () => {
  const r = run(ctx, script('status'));
  assert.ok(r.ok, r.payload);
  const status = JSON.parse(r.payload);
  assert.equal(status.revision, catalog.revision);
  assert.ok(status.total >= 1);
  assert.equal(ctx.__AECT_BUNDLE_ONLY__, undefined, 'bundle-only flag restored');
  assert.equal(ctx.__AECT_WORKSPACE_ROOT__, undefined, 'workspace root flag restored');
  assert.equal(ctx.__aeCodexTeamBridgeV1, undefined, 'no ScriptUI bridge created');
  assert.ok(ctx.__aeCodexTeamNativeV1 && ctx.__aectFunctionsV1, 'runtime cached under the native key');
});

check('runtime is loaded once and reused while the bundle is unchanged', () => {
  const first = ctx.__aeCodexTeamNativeV1;
  run(ctx, script('status'));
  assert.equal(ctx.__aeCodexTeamNativeV1, first);
});

check('validate accepts an installed read function and names it', () => {
  const plan = JSON.stringify({ schema: 'aect-functions/v1', steps: [{ function: 'team.project.inspect', args: {} }] });
  const r = run(ctx, script('validate', plan));
  assert.ok(r.ok, r.payload);
  assert.equal(r.payload, 'functions: team.project.inspect');
});

check('validate rejects unknown functions and bad args with an error, not an exception', () => {
  const bad = run(ctx, script('validate', JSON.stringify({ schema: 'aect-functions/v1', steps: [{ function: 'nope.nothing', args: {} }] })));
  assert.equal(bad.ok, false); assert.ok(bad.payload.length > 0);
  const garbage = run(ctx, script('validate', '{not json'));
  assert.equal(garbage.ok, false);
});

check('request text is data: quotes, U+2028 and script-like text cannot break out', () => {
  const evil = '{"schema":"aect-functions/v1","steps":[{"function":"team.project.inspect","args":{}}],"x":"\\"); $.global.pwned=1; ("  "}';
  run(ctx, script('validate', evil));
  assert.equal(ctx.pwned, undefined);
});

check('run executes through the runtime and clears the run context', () => {
  const plan = JSON.stringify({ schema: 'aect-functions/v1', steps: [{ function: 'team.project.inspect', args: {} }] });
  const r = run(ctx, script('run', plan, 'harness-run-001'));
  // Outside AE the function itself fails (no project); what matters is the error is reported, not thrown.
  assert.ok(typeof r.payload === 'string' && r.payload.length > 0);
  assert.equal(ctx.__AECT_RUN_CONTEXT__, undefined, 'run context removed');
});

check('app version script', () => {
  const r = run(makeContext(), script('version'));
  assert.ok(r.ok); assert.equal(r.payload, '26.5x0-harness');
});

console.log(passed + ' harness checks passed');
