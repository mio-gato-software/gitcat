import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
registerHooks({resolve(s,c,n){return s==='electron'?{url:new URL('./helpers/electron-stub.mjs',import.meta.url).href,shortCircuit:true}:n(s,c);}});
const { ActivityHistory }=await import('../dist-electron/electron/activity-history.js');
const service=await import('../dist-electron/electron/git-service.js');
function fixture(t) {
 const path=mkdtempSync(join(tmpdir(),'gitcat-history-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q','-b','main');git('config','user.name','QA');git('config','user.email','qa@example.test');
 writeFileSync(join(path,'file'),'base');git('add','.');git('commit','-qm','base');
 return {path,git};
}
async function save(path) {
 writeFileSync(join(path,'file'),'saved'); const state=await service.getSnapshot(path);
 await service.executePlan(path,await service.prepareBranchDelivery(path,{stateId:state.stateId,message:'save',mergeToDefault:false},'en'),'en');
 return (await service.getActivityHistory(path)).entries[0];
}
test('history survives a new store instance and interrupted steps remain unknown without storing content',t=>{
 const {path}=fixture(t), file=join(path,'journal.json'), history=new ActivityHistory(file);
 const before={path,head:'a'.repeat(40),currentBranch:'main'};
 const id=history.begin({steps:[{operation:'commit',command:'secret command',summary:'private content'}]},before);
 const stored=new ActivityHistory(file).list(path).entries[0];
 assert.equal(stored.id,id);assert.equal(stored.state,'running');assert.equal(stored.steps[0].status,'pending');
 assert.doesNotMatch(readFileSync(file,'utf8'),/secret command|private content/);
 history.finish(id,before,[], 'https://user:password@example.test failed');
 assert.doesNotMatch(readFileSync(file,'utf8'),/password/);
 history.retention(0);assert.equal(history.list(path).entries.length,0);
});
test('an unpublished save can be undone while keeping files and index, and restoring a reference does not switch',async t=>{
 const {path,git}=fixture(t), base=git('rev-parse','HEAD'),entry=await save(path);
 assert.equal(entry.steps[0].status,'completed'); assert.equal(entry.steps[0].beforeHead,base);
 const index=git('write-tree');
 const plan=await service.prepareHistoryRecovery(path,entry.id,'undo','en');
 assert.equal(plan.requiresConfirmation,true);assert.deepEqual(plan.steps[0].argv,['reset','--soft',`${entry.after.head}^`]);
 await service.executePlan(path,plan,'en');
 assert.equal(git('rev-parse','HEAD'),base);assert.equal(git('write-tree'),index);assert.equal(readFileSync(join(path,'file'),'utf8'),'saved');
 const restore=await service.prepareHistoryRecovery(path,entry.id,'restore','en');
 await service.executePlan(path,restore,'en');assert.equal(git('branch','--show-current'),'main');assert.equal(git('write-tree'),index);
 assert.equal(git('rev-parse',restore.recovery.branch),base);
});
test('published saves use revert, and publication after preview blocks an undo',async t=>{
 const {path,git}=fixture(t),remote=join(path,'remote.git');git('init','--bare',remote);git('remote','add','origin',remote);
 // Keep the fixture remote out of the working tree.
 writeFileSync(join(path,'.git','info','exclude'),'remote.git/\n');
 const entry=await save(path), undo=await service.prepareHistoryRecovery(path,entry.id,'undo','en');
 git('push','-u','origin','main');
 await assert.rejects(service.executePlan(path,undo,'en'),/published/);
 await assert.rejects(service.prepareHistoryRecovery(path,entry.id,'undo','en'),/published/);
 const revert=await service.prepareHistoryRecovery(path,entry.id,'revert','en');
 await service.executePlan(path,revert,'en');assert.equal(readFileSync(join(path,'file'),'utf8'),'base');assert.equal(git('rev-list','--count','HEAD'),'3');
});
test('unrelated dirty work and externally moved history refuse recovery before changing anything',async t=>{
 const {path,git}=fixture(t),entry=await save(path),plan=await service.prepareHistoryRecovery(path,entry.id,'undo','en');
 writeFileSync(join(path,'unrelated'),'mine');await assert.rejects(service.executePlan(path,plan,'en'),/unfinished work/);
 assert.equal(readFileSync(join(path,'unrelated'),'utf8'),'mine');git('add','.');git('commit','-qm','other work');
 await assert.rejects(service.prepareHistoryRecovery(path,entry.id,'undo','en'),/branch has moved/);
});
test('partial sequence records completed and failed steps with recovery refs',async t=>{
 const {path,git}=fixture(t);git('switch','-qc','work');writeFileSync(join(path,'file'),'work');
 const state=await service.getSnapshot(path),plan=await service.prepareBranchDelivery(path,{stateId:state.stateId,message:'work',mergeToDefault:true},'en');
 writeFileSync(join(path,'.git','hooks','post-commit'),'#!/bin/sh\ngit update-ref refs/heads/main HEAD~1\n',{mode:0o755});
 // Use a failing checkout step after the save to exercise a partial plan deterministically.
 plan.steps[1].args.name='missing';
 const result=await service.executePlan(path,plan,'en');
 assert.ok(result.error);const entry=(await service.getActivityHistory(path)).entries[0];
 assert.deepEqual(entry.steps.map(s=>s.status),['completed','failed','skipped']);assert.ok(entry.steps[0].afterHead);
});
