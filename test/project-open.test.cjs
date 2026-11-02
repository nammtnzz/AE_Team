const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFunctionsRuntime}=require('../engine/tools/AeFunctionsSource');
const {validatePlan}=require('../dist/ae');
function fixture(overrides={}) {
  let opens=0;
  const app={project:{dirty:false,file:{fsName:'C:/current.aep'},renderQueue:{rendering:false}},open(file){opens++;return{file,numItems:2}},...overrides};
  function File(p){this.fsName=p;this.exists=!/missing/.test(p);this.parent={exists:true,alias:false};this.alias=false;}
  const sandbox={app,File,$:{global:{}}};vm.runInNewContext(readFunctionsRuntime(),sandbox);
  const api=sandbox.$.global.__aectFunctionsV1;
  const request=(path='C:/next.aep')=>({schema:'aect-functions/v1',steps:[{function:'team.project.open',args:{path}}]});
  return{app,api,request,opens:()=>opens};
}
test('project.open opens the selected existing project without an undo group or import',()=>{
  const f=fixture(),r=f.api.run(f.request());assert.equal(f.opens(),1);assert.equal(r.results[0].value.opened,true);assert.equal(r.results[0].value.path,'C:/next.aep');
});
test('project.open refuses dirty, unknown, rendering, missing and non-project files before app.open',()=>{
  for(const dirty of [true,undefined]){const f=fixture();f.app.project.dirty=dirty;assert.throws(()=>f.api.run(f.request()),/unsaved changes/);assert.equal(f.opens(),0);}
  const f=fixture();f.app.project.renderQueue.rendering=true;assert.throws(()=>f.api.run(f.request()),/rendering/);assert.equal(f.opens(),0);
  for(const file of ['C:/missing.aep','C:/audio.wav','relative.aep']){const g=fixture();assert.throws(()=>g.api.run(g.request(file)));assert.equal(g.opens(),0);}
});
test('project.open does not reopen the current project and cannot be combined with edits',()=>{
  const f=fixture();f.app.project.dirty=true;assert.equal(f.api.run(f.request('C:/current.aep')).results[0].value.alreadyOpen,true);assert.equal(f.opens(),0);
  const p=f.request();p.steps.push({function:'team.project.inspect',args:{}});assert.throws(()=>f.api.run(p),/alone/);assert.equal(f.opens(),0);
  assert.throws(()=>validatePlan(p,f.api.list(false)),/chạy riêng/);
});
test('project.open does not silently report success after host cancellation',()=>{
  const f=fixture({open(){return null}});assert.throws(()=>f.api.run(f.request()),/did not confirm/);
});
