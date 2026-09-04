import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:new URL('./helpers/electron-stub.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
const {getSnapshot,prepareBranchDelivery,executePlan}=await import('../dist-electron/electron/git-service.js');
function fixture(t) {
 const path=mkdtempSync(join(tmpdir(),'gitcat-delivery-'));
 t.after(()=>rmSync(path,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.com');
 writeFileSync(join(path,'file.txt'),'base\n');git('add','.');git('commit','-qm','base');git('switch','-qc','feature/work');
 return {path,git};
}
test('one reviewed plan saves modified and untracked files before merging, without publishing or deleting',async t=>{
 const {path,git}=fixture(t);
 writeFileSync(join(path,'file.txt'),'changed\n');writeFileSync(join(path,'new.txt'),'new file\n');
 const state=await getSnapshot(path);
 const plan=await prepareBranchDelivery(path,{stateId:state.stateId,message:'Save reviewed work',mergeToDefault:true},'en');
 assert.deepEqual(plan.steps.map(s=>s.operation),['commit','checkout','merge']);assert.equal(plan.requiresConfirmation,true);
 assert.equal(git('status','--porcelain').includes('?? new.txt'),true,'preparing is read-only');
 const result=await executePlan(path,plan,'en');
 assert.equal(result.error,undefined);assert.equal(result.snapshot.currentBranch,'main');assert.equal(result.snapshot.isDirty,false);
 assert.equal(git('show','main:new.txt'),'new file');assert.equal(git('rev-parse','feature/work'),git('rev-parse','main'));
 const repeated=await prepareBranchDelivery(path,{stateId:result.snapshot.stateId,mergeToDefault:true},'en').catch(e=>e);
 assert.match(repeated.message,/different from the main/);
 git('switch','-q','feature/work');
 const clean=await getSnapshot(path);
 assert.equal((await prepareBranchDelivery(path,{stateId:clean.stateId,mergeToDefault:true},'en')).allowed,false);
});
test('saving only stays on the branch and stale review or stale execution cannot include unseen files',async t=>{
 const {path,git}=fixture(t);writeFileSync(join(path,'file.txt'),'one\n');
 const before=await getSnapshot(path);assert.deepEqual(before.changes.map(file=>file.path),['file.txt']);writeFileSync(join(path,'unexpected.txt'),'unreviewed\n');
 await assert.rejects(()=>prepareBranchDelivery(path,{stateId:before.stateId,message:'save',mergeToDefault:false},'en'),/Review the changes again/);
 const current=await getSnapshot(path);
 const plan=await prepareBranchDelivery(path,{stateId:current.stateId,message:'save',mergeToDefault:false},'en');
 writeFileSync(join(path,'file.txt'),'two\n');
 await assert.rejects(()=>executePlan(path,plan,'en'),/changes moved/);
 const next=await getSnapshot(path);const ready=await prepareBranchDelivery(path,{stateId:next.stateId,message:'save',mergeToDefault:false},'en');
 const result=await executePlan(path,ready,'en');assert.equal(result.error,undefined);assert.equal(git('branch','--show-current'),'feature/work');assert.equal(git('show','main:file.txt'),'base');
});
test('a conflicting merge leaves the saved commit recoverable and reports a partial operation',async t=>{
 const {path,git}=fixture(t);git('switch','-q','main');writeFileSync(join(path,'file.txt'),'main edit\n');git('commit','-qam','main change');git('switch','-q','feature/work');writeFileSync(join(path,'file.txt'),'feature edit\n');
 const state=await getSnapshot(path);const plan=await prepareBranchDelivery(path,{stateId:state.stateId,message:'save work',mergeToDefault:true},'en');
 const result=await executePlan(path,plan,'en');assert.ok(result.error);assert.equal(result.snapshot.pending.kind,'merge');
 assert.equal(git('show','feature/work:file.txt'),'feature edit');assert.equal(result.outcomes[0].status,'completed');
 await assert.rejects(()=>prepareBranchDelivery(path,{stateId:result.snapshot.stateId,message:'save',mergeToDefault:true},'en'),/pending operation/);
});
test('a target open in another worktree is rejected before any commit',async t=>{
 const {path,git}=fixture(t);const other=path+'-other';t.after(()=>rmSync(other,{recursive:true,force:true}));git('worktree','add','-q',other,'main');
 writeFileSync(join(path,'new.txt'),'work\n');const state=await getSnapshot(path);const head=git('rev-parse','HEAD');
 await assert.rejects(()=>prepareBranchDelivery(path,{stateId:state.stateId,message:'save',mergeToDefault:true},'en'),/another worktree/);
 assert.equal(git('rev-parse','HEAD'),head);
});
test('new directories are shown as individual files and can form the first saved version',async t=>{
 const path=mkdtempSync(join(tmpdir(),'gitcat-first-save-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.com');
 const {mkdirSync}=await import('node:fs');mkdirSync(join(path,'new-folder'));writeFileSync(join(path,'new-folder','first.txt'),'first');
 const state=await getSnapshot(path);assert.deepEqual(state.changes.map(f=>f.path),['new-folder/first.txt']);
 const plan=await prepareBranchDelivery(path,{stateId:state.stateId,message:'first save',mergeToDefault:false},'en');
 const result=await executePlan(path,plan,'en');assert.equal(result.error,undefined);assert.equal(result.snapshot.isDirty,false);
});
