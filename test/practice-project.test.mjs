import test from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
registerHooks({resolve(s,c,n){return s==='electron'?{url:new URL('./helpers/electron-stub.mjs',import.meta.url).href,shortCircuit:true}:n(s,c);}});
const service=await import('../dist-electron/electron/git-service.js');
const{PracticeProjects}=await import('../dist-electron/electron/practice-project.js');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
function fixture(t){const root=mkdtempSync(join(tmpdir(),'gitcat-practice-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=new PracticeProjects(join(root,'owned'),async(path,args)=>git(path,...args));return {root,store};}
test('practice creates actual isolated Git state without identity or remote setup',async t=>{const{store}=fixture(t);const info=await store.create();assert.equal(git(info.path,'remote'),'');assert.equal(git(info.path,'config','user.email'),'practice@example.invalid');assert.equal(git(info.path,'branch','--show-current'),'main');assert.equal(git(info.path,'status','--porcelain'),'');assert.equal(git(info.path,'config','commit.gpgSign'),'false');assert.ok(git(info.path,'branch','--list','practice/conflict-*').includes('practice/conflict-ours'));store.edit(info.path);assert.match(git(info.path,'status','--porcelain'),/story.txt/);});
test('skipped lessons resume after reopening and replay creates a separate project',async t=>{const{root,store}=fixture(t);const first=await store.create();store.lesson(first.path,4);const reopened=new PracticeProjects(join(root,'owned'),async(path,args)=>git(path,...args));assert.equal(reopened.info(first.path).lesson,4);const second=await reopened.create();assert.notEqual(first.path,second.path);assert.equal(reopened.info(first.path).lesson,4);reopened.remove(second.path);assert.equal(existsSync(first.path),true);assert.equal(existsSync(second.path),false);});
test('cleanup and example editing refuse personal folders, forged markers and symlink targets', async t => {
  const { root, store } = fixture(t);
  const personalFolder = join(root, 'personal');
  mkdirSync(personalFolder);
  const personal = join(personalFolder, 'keep.txt');
  writeFileSync(personal, 'keep me');
  assert.throws(() => store.remove(root), /not a verified/);
  const info = await store.create();
  rmSync(join(info.path, 'story.txt'));
  // Directory junctions exercise link rejection without Windows symlink privileges.
  symlinkSync(process.platform === 'win32' ? personalFolder : personal,
    join(info.path, 'story.txt'), process.platform === 'win32' ? 'junction' : 'file');
  assert.throws(() => store.edit(info.path));
  assert.equal(readFileSync(personal, 'utf8'), 'keep me');
  const alias = join(root, 'alias');
  symlinkSync(info.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.remove(alias), /not a verified/);
  writeFileSync(join(info.path, '.gitcat-practice.json'), JSON.stringify({ id: info.id, token: 'wrong' }));
  assert.throws(() => store.remove(info.path), /not a verified/);
  assert.equal(existsSync(info.path), true);
});
test('the full practice path saves, branches, integrates and resolves a real conflict without AI',async t=>{
 let state=await service.createPractice();const path=state.path;t.after(()=>service.removePractice(path));
 state=await service.editPractice(path);let plan=await service.prepareBranchDelivery(path,{stateId:state.stateId,message:'First practice save',mergeToDefault:false},'en');await service.executePlan(path,plan,'en');
 plan=await service.prepareOperation(path,'create_branch',{name:'practice/my-idea'},'en');await service.executePlan(path,plan,'en');
 state=await service.editPractice(path);plan=await service.prepareBranchDelivery(path,{stateId:state.stateId,message:'Save the idea',mergeToDefault:true},'en');const integrated=await service.executePlan(path,plan,'en');assert.equal(integrated.error,undefined);assert.equal(integrated.snapshot.currentBranch,'main');
 await service.executePlan(path,await service.prepareOperation(path,'checkout',{name:'practice/conflict-ours'},'en'),'en');
 const conflict=await service.executePlan(path,await service.prepareOperation(path,'merge',{name:'practice/conflict-theirs'},'en'),'en');assert.ok(conflict.error);assert.equal(conflict.snapshot.conflicts[0].path,'conflict.txt');
 const guide=await service.describeConflicts(path,'en');const choices=await service.applyConflictChoices(path,guide,[{path:'conflict.txt',choice:'ours'}],'en');assert.equal(choices.complete,true);
 const completed=await service.executePlan(path,await service.prepareOperation(path,'continue_operation',{},'en'),'en');assert.equal(completed.error,undefined);assert.equal(completed.snapshot.pending,undefined);assert.equal(git(path,'remote'),'');
});
test('practice refuses network/global changes even if a remote is added externally',async t=>{
 const state=await service.createPractice(),path=state.path;t.after(()=>service.removePractice(path));
 const plan=await service.prepareOperation(path,'set_identity',{user:'Other',email:'other@example.test',scope:'global'},'en');await assert.rejects(service.executePlan(path,plan,'en'),/Practice stays local/);
 git(path,'remote','add','origin','https://example.invalid/no-network');
 const read=await service.fetchRemotes(path);assert.equal(read.path,path);
 const checked=await service.checkReadiness(path,{remote:'origin',access:true});assert.equal(checked.remote.access,'denied');
});
