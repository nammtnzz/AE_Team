const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {searchLibrary}=require('../engine/tools/AeLibrarySearch');
const {resolveEngineRoot}=require('../dist/ae');
const {defaultConfig,upgradeConfig}=require('../dist/core');
async function library(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ae-unified-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lib=path.join(root,'.ae-codex/library');await fs.mkdir(path.join(lib,'sessions/demo'),{recursive:true});
  const config={sfx:{enabled:true,roots:[path.join(root,'sounds')],extensions:['.wav']}};
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({roots:config.sfx.roots,extensions:['.wav']})).digest('hex');
  const latest={state:'success',enabled:true,settingsFingerprint:fingerprint,catalogRelativePath:'.ae-codex/library/sessions/demo/sfx-demo.jsonl'};
  const write=async()=>{await fs.writeFile(path.join(lib,'config.json'),JSON.stringify(config));await fs.writeFile(path.join(lib,'latest-sfx.json'),JSON.stringify(latest))};
  await write();return{root,lib,config,latest,write};
}
test('SFX finds real saved metadata by accent-insensitive name and bounds returned rows',async t=>{
  const f=await library(t),catalog=path.join(f.root,f.latest.catalogRelativePath);
  await fs.writeFile(catalog,Array.from({length:50},(_,i)=>JSON.stringify({name:'Chuyển động whoosh '+i,path:path.join(f.config.sfx.roots[0],i+'.wav'),tags:['transition']})).join('\n'));
  const got=await searchLibrary(f.root,{query:'chuyen dong',limit:3});
  assert.equal(got.state,'ready');assert.equal(got.results.length,3);assert.equal(got.truncated,true);assert.equal(got.scanned,false);
});
test('disabled SFX never opens the catalog and changed settings invalidate saved metadata',async t=>{
  const f=await library(t);f.config.sfx.enabled=false;await f.write();assert.equal((await searchLibrary(f.root,{query:''})).state,'disabled');
  f.config.sfx.enabled=true;f.config.sfx.roots.push(path.join(f.root,'other'));await f.write();assert.equal((await searchLibrary(f.root,{query:''})).state,'needs-manual-scan');
});
test('SFX rejects catalog traversal and oversized rows; excludes metadata outside selected roots',async t=>{
  const f=await library(t);f.latest.catalogRelativePath='../../private.jsonl';await f.write();await assert.rejects(searchLibrary(f.root,{query:''}),/Unsafe/);
  f.latest.catalogRelativePath='.ae-codex/library/sessions/demo/sfx-demo.jsonl';await f.write();
  const file=path.join(f.root,f.latest.catalogRelativePath);await fs.writeFile(file,JSON.stringify({name:'outside',path:path.join(f.root,'elsewhere.wav')})+'\n');
  assert.deepEqual((await searchLibrary(f.root,{query:''})).results,[]);
  await fs.writeFile(file,'x'.repeat(70000));await assert.rejects(searchLibrary(f.root,{query:''}),/64 KiB/);
});
test('engine discovery follows only version pointers inside a compatible install',async t=>{
  const f=await library(t),base=path.join(f.root,'AE_CodexTeam'),runtime=path.join(base,'versions/demo');
  await fs.mkdir(path.join(runtime,'tools'),{recursive:true});await fs.writeFile(path.join(runtime,'tools/AeFunctionsMcp.js'),'');
  const pointer=path.join(base,'installation.json');await fs.writeFile(pointer,JSON.stringify({schema:'aect-installation/v1',runtimeRoot:runtime}));
  assert.equal(resolveEngineRoot('',f.root),runtime);assert.equal(resolveEngineRoot('X:/explicit',f.root),path.resolve('X:/explicit'));
  await fs.writeFile(pointer,JSON.stringify({schema:'aect-installation/v1',runtimeRoot:f.root}));assert.notEqual(resolveEngineRoot('',f.root),f.root);
});
test('Vietnamese preset upgrade preserves custom models and explicitly gives position five SFX duties',()=>{
  const config=defaultConfig();config.roles[4].name='Compositing / FX';config.roles[4].model='my-model';
  const upgraded=upgradeConfig(config);assert.equal(upgraded.roles[4].name,'Hình ảnh & âm thanh');assert.equal(upgraded.roles[4].model,'my-model');assert.match(upgraded.roles[4].systemPrompt,/SFX/);
  assert.equal(new Set(defaultConfig().roles.map(r=>r.name)).size,9);
});
