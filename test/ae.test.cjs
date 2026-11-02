const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AeEngine, validatePlan, boundedResult } = require('../dist/ae');
const funcs = [
  { name: 'team.project.inspect', mutates: false, inputSchema: { type: 'object', properties: { maxItems: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { name: 'team.comp.create', mutates: true, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  { name: 'team.inspection.capture', mutates: false, inputSchema: { type: 'object' } },
  { name: 'team.app.memory', mutates: true, inputSchema: { type: 'object' } }
];
const plan = steps => ({ schema: 'aect-functions/v1', steps });
test('AE plan validates every step before dispatch and rejects arbitrary/archived execution', () => {
  assert.throws(() => validatePlan(plan([{ function: 'team.project.inspect', args: {} }, { function: 'team.comp.create', args: {} }]), funcs), /required/);
  for (const name of ['team.script.run', 'execute_script', 'eval', 'unknown']) assert.throws(() => validatePlan(plan([{ function: name, args: {} }]), funcs), /chặn/);
  assert.throws(() => validatePlan(plan([{ function: 'team.project.inspect', args: { maxItems: 0 } }]), funcs), /maxItems/);
  assert.throws(() => validatePlan(plan([{ function: 'team.project.inspect', args: {}, code: 'alert(1)' }]), funcs));
  assert.throws(() => validatePlan(JSON.parse('{"schema":"aect-functions/v1","steps":[{"function":"team.project.inspect","args":{"__proto__":{}}}]}'), funcs));
  const input = plan([{ function: 'team.comp.create', args: { name: 'Title' }, as: 'title' }]);
  const output = validatePlan(input, funcs); input.steps[0].args.name = 'Changed';
  assert.equal(output.steps[0].args.name, 'Title');
});
test('AE limits captures, duplicate aliases and standalone memory operations', () => {
  assert.throws(() => validatePlan(plan([{ function: 'team.inspection.capture', args: { numFrames: 4 } }]), funcs), /3 frame/);
  assert.throws(() => validatePlan(plan([{ function: 'team.inspection.capture', args: {} }, { function: 'team.inspection.capture', args: {} }]), funcs));
  assert.throws(() => validatePlan(plan([{ function: 'team.app.memory', args: {} }, { function: 'team.project.inspect', args: {} }]), funcs), /chạy riêng/);
  assert.throws(() => validatePlan(plan([{ function: 'team.project.inspect', args: {}, as: 'a' }, { function: 'team.project.inspect', args: {}, as: 'a' }]), funcs));
  assert.ok(boundedResult({ state: 'success', data: 'x'.repeat(130000) }).truncated);
});
test('MCP stdio handshake, catalog/schema discovery, serialized jobs and no replay on failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-fixture-'));
  await fs.mkdir(path.join(root, 'tools'));
  await fs.writeFile(path.join(root, 'tools/AeFunctionsMcp.js'), `
const fs=require('node:fs');const readline=require('node:readline');
const functions=${JSON.stringify(funcs)};
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const req=JSON.parse(line);if(req.id===undefined)return;
 fs.appendFileSync('calls.jsonl',JSON.stringify({method:req.method,name:req.params?.name})+'\\n');
 let result={};
 if(req.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(req.method==='tools/list')result={tools:functions.map(f=>({name:'aect_'+f.name.replaceAll('.','_'),inputSchema:f.inputSchema}))};
 if(req.method==='tools/call'){
   let value={};if(req.params.name==='aect_list_functions')value={functions};
   if(req.params.name==='aect_run_plan'){await new Promise(r=>setTimeout(r,80));value={state:'error',message:'partial failure; do not replay'};}
   result={content:[{type:'text',text:JSON.stringify(value)}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`);
  const engine = new AeEngine({ root });
  t.after(async () => { await engine.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const functions = await engine.functions(); assert.equal(functions.length, funcs.length);
  await assert.rejects(engine.read('team.comp.create', { name: 'Forbidden' }), /Chỉ cho phép/);
  const first = engine.call('aect_run_plan', { steps: [{ function: 'team.project.inspect', args: {} }] }, true);
  await assert.rejects(engine.call('aect_run_plan', { steps: [] }, true), /đang có lệnh/);
  assert.equal((await first).state, 'error');
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c => c.name === 'aect_run_plan').length, 1);
  assert.equal(calls.filter(c => c.method === 'initialize').length, 1);
  assert.equal(calls.find(c => c.method === 'tools/call').name, 'aect_search_capabilities');
});
test('disabled SFX inventory is never loaded or exposed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-inventory-fixture-'));
  await fs.mkdir(path.join(root, '.ae-codex/library'), { recursive: true });
  await fs.mkdir(path.join(root, '.ae-codex/plugins'), { recursive: true });
  await fs.writeFile(path.join(root, '.ae-codex/library/current.json'), JSON.stringify({ sfxCount: 123, sfxRelativePath: 'private-cache', sfxEnabled: true }));
  await fs.writeFile(path.join(root, '.ae-codex/library/config.json'), JSON.stringify({ effects: { enabled: false }, sfx: { enabled: false } }));
  await fs.writeFile(path.join(root, '.ae-codex/library/USAGE.md'), 'Usage');
  await fs.writeFile(path.join(root, '.ae-codex/plugins/USAGE.md'), 'Plugins');
  const engine = new AeEngine({ root }); t.after(async () => { await engine.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const inventory = await engine.inventory('glow');
  assert.equal(inventory.sfxEnabled, false);
  assert.equal(inventory.current.sfxCount, 0);
  assert.equal(inventory.current.sfxRelativePath, undefined);
});

test('plans must reference comps created in the same plan by ref, not by name', () => {
  const { validatePlan } = require('../dist/ae');
  const any = { type: 'object' };
  const fns = ['team.comp.create', 'team.layer.solid.create'].map(name => ({ name, inputSchema: any, mutates: true }));
  const bad = { schema: 'aect-functions/v1', steps: [{ function: 'team.comp.create', args: { name: 'HELLO' } }, { function: 'team.layer.solid.create', args: { comp: { name: 'HELLO' } } }] };
  assert.throws(() => validatePlan(bad, fns), /ref/);
  const good = { schema: 'aect-functions/v1', steps: [{ function: 'team.comp.create', args: { name: 'HELLO' }, as: 'main' }, { function: 'team.layer.solid.create', args: { comp: { ref: 'main' } } }] };
  assert.equal(validatePlan(good, fns).steps.length, 2);
});
