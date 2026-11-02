const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {status}=require('../tools/TeamStatus.cjs');
test('manager distinguishes installed, connected, stale and damaged without running AE',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ae-manager-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  assert.equal(status(base).state,'not-installed');
  const runtime=path.join(base,'versions/test');fs.mkdirSync(path.join(runtime,'tools'),{recursive:true});
  const source=path.join(runtime,'tools/AeCapabilities.js');
  const module={capabilityStatus:()=>({activeTools:44,installation:{certificateMatches:true},connection:{fresh:true,ageMs:0,state:'running',revisionMatches:true}})};
  fs.writeFileSync(source,'module.exports={}');const cacheKey=require.resolve(source);require.cache[cacheKey]={exports:module};t.after(()=>delete require.cache[cacheKey]);
  const loader=path.join(base,'loader.jsx');fs.writeFileSync(loader,'bundle = new File('+JSON.stringify(path.join(runtime,'jsx/AECT Engine.jsx'))+');');
  fs.writeFileSync(path.join(base,'installation.json'),JSON.stringify({schema:'aect-installation/v1',runtimeRoot:runtime,panelPath:loader,startupPath:loader}));
  assert.equal(status(base).state,'connected');
  const cap=module.capabilityStatus();module.capabilityStatus=()=>cap;cap.connection.fresh=false;assert.equal(status(base).state,'disconnected');
  cap.connection.fresh=true;cap.installation.certificateMatches=false;assert.equal(status(base).state,'repair-required');
  cap.installation.certificateMatches=true;fs.writeFileSync(loader,'bundle = new File("C:/old/jsx/AECT Engine.jsx");');assert.equal(status(base).state,'repair-required');
  fs.unlinkSync(loader);assert.equal(status(base).state,'repair-required');
});
