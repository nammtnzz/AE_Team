'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(root,sub=''){return fs.readdirSync(path.join(root,sub)).sort().flatMap(n=>{const rel=sub?sub+'/'+n:n,s=fs.lstatSync(path.join(root,rel));if(s.isSymbolicLink())throw Error('No links in release');return s.isDirectory()?walk(root,rel):[rel]})}
function fileEntry(root,rel){const b=fs.readFileSync(path.join(root,rel));return{path:rel,bytes:b.length,sha256:sha(b)}}
function build(){
  const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
  // Bound work/: drop earlier mkdtemp stages (release-XXXXXX); versioned release-x.y.z output folders never match.
  // A stage still held open (e.g. by a running installer) is left for the next build instead of failing this one.
  for(const n of fs.readdirSync(work))if(/^release-[A-Za-z0-9]{6}$/.test(n)){try{fs.rmSync(path.join(work,n),{recursive:true,force:true})}catch{}}
  const stage=fs.mkdtempSync(path.join(work,'release-'));
  const payload=path.join(stage,'payload');fs.mkdirSync(payload);
  const original=JSON.parse(fs.readFileSync(path.join(root,'engine/distribution.json')));
  const allow=original.files.map(f=>f.path).concat('tools/AeLibrarySearch.js','tools/AeFunctionsMcpLauncher.js','tools/Invoke-AeRetention.ps1');
  for(const rel of new Set(allow)){
    const src=path.join(root,'engine',rel);if(!fs.lstatSync(src).isFile())throw Error('Bad engine input');
    const dest=path.join(payload,'engine',rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
  }
  const engineRoot=path.join(payload,'engine'),files=walk(engineRoot).map(rel=>fileEntry(engineRoot,rel));
  const catalog=JSON.parse(fs.readFileSync(path.join(engineRoot,'.ae-codex/functions/catalog.json'))),toolCount=catalog.functions.length;
  const engineVersion='1.0.0',id=engineVersion+'-'+sha(JSON.stringify(files)).slice(0,12);
  const metadata={...original,version:engineVersion,bridgeVersion:catalog.bridgeVersion,toolCount,packageId:id,additionalTools:['aect_library_search'],files};
  // Legacy README/command assets are not part of this sanitized engine package.
  delete metadata.readmeSha256;delete metadata.commandSha256;
  metadata.launcherSourceSha256=sha(fs.readFileSync(path.join(engineRoot,'tools/AeBackgroundLauncher.cs')));
  fs.writeFileSync(path.join(engineRoot,'distribution.json'),JSON.stringify(metadata,null,2));
  fs.mkdirSync(path.join(payload,'team'));const vsix='team/ae-codexteam-'+version+'.vsix';fs.copyFileSync(path.join(root,path.basename(vsix)),path.join(payload,vsix));
  fs.mkdirSync(path.join(payload,'tools'));
  for(const name of ['TeamMaintenance.ps1','Install-AeCodexTeam.ps1','Manage-AeCodexTeam.ps1','Cleanup-AeCodexTeam.ps1','TeamStatus.cjs','TeamKnowledge.cjs'])fs.copyFileSync(path.join(root,'tools',name),path.join(payload,'tools',name));
  // Native AEGP bridge: built .aex + its installer, run by Install-AeCodexTeam.ps1.
  const aex=path.join(root,'native/out/AE_CodexTeam_Native.aex');if(!fs.existsSync(aex))throw Error('Build native first: native\build.cmd');
  fs.mkdirSync(path.join(payload,'native'));fs.copyFileSync(aex,path.join(payload,'native/AE_CodexTeam_Native.aex'));fs.copyFileSync(path.join(root,'native/Install-NativePlugin.ps1'),path.join(payload,'native/Install-NativePlugin.ps1'));
  // Default image skill installed into the user's Claude skills folder. Allowlist only: .env (keys) never ships.
  const skillFiles=['SKILL.md','.env.example','agents/openai.yaml','references/prompting.md','references/sample-prompts.md','scripts/image_gen.py'];
  for(const rel of skillFiles){const dest=path.join(payload,'skills/iw-imagegen',rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,'skills/iw-imagegen',rel),dest);}
  if(fs.existsSync(path.join(payload,'skills/iw-imagegen/.env')))throw Error('Refusing to ship skill credentials (.env)');
  // Lessons learned on this machine travel with the release (sanitized); install merges them into the new machine.
  if(process.env.AECT_EXCLUDE_KNOWLEDGE!=='1'){const local=process.env.LOCALAPPDATA||'',current=path.join(local,'AE_Team','knowledge'),older=path.join(local,'AE_CodexTeam','knowledge');const source=process.env.AECT_SHARE_KNOWLEDGE_DIR||(fs.existsSync(path.join(current,'lessons.json'))||!fs.existsSync(path.join(older,'lessons.json'))?current:older);require('./TeamKnowledge.cjs').exportShared(source,path.join(payload,'knowledge/shared-lessons.json'));}
  const product={schema:'ae-codexteam-package/v1',product:'AE_CodexTeam',version,engineVersion,vsix,toolCount,additionalTools:['aect_library_search'],signed:false,files:walk(payload).map(rel=>fileEntry(payload,rel))};
  fs.writeFileSync(path.join(payload,'product.json'),JSON.stringify(product,null,2));
  console.log(JSON.stringify({stage,payload,version,engineVersion,files:product.files.length,packageId:id}));return{stage,payload};
}
if(require.main===module)build();module.exports={build,walk,fileEntry};
