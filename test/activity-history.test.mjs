import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
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

for (const failingMethods of [['step'], ['finish'], ['step', 'finish']]) {
 test(`journal failure after commit preserves completion: ${failingMethods.join('+')}`, async t => {
  const {path,git}=fixture(t);
  writeFileSync(join(path,'file'),'saved despite journal error');
  const plan=await service.prepareOperation(path,'commit',{message:'confirmed save'},'en');
  for (const method of failingMethods) t.mock.method(ActivityHistory.prototype,method,()=>{throw new Error('simulated disk error');});
  const result=await service.executePlan(path,plan,'en');
  assert.match(result.error,/Completed steps remain done/);
  assert.deepEqual(result.outcomes.map(s=>s.status),['completed']);
  assert.equal(git('rev-list','--count','HEAD'),'2');
  assert.equal(git('show','HEAD:file'),'saved despite journal error');
  assert.equal(result.snapshot.head,git('rev-parse','HEAD'));
  const record={plan,outcomes:result.outcomes,stale:false};
  await assert.rejects(service.prepareRetry(path,record,'en'),/No step/);
  const report=await service.describeFailure(path,{command:plan.command,summary:plan.summary,error:result.error,skipped:[],stage:'execute'},record);
  assert.deepEqual(report.completed,[plan.steps[0].summary]);
  assert.equal(report.actions.some(action=>action.kind==='retry'),false);
  if (!failingMethods.includes('finish')) assert.equal((await service.getActivityHistory(path)).entries[0].steps[0].status,'completed');
 });
}

test('journal failure between steps stops the sequence and retry excludes the completed commit',async t=>{
 const {path,git}=fixture(t);
 writeFileSync(join(path,'file'),'saved once');
 const plan=await service.prepareOperation(path,'commit',{message:'save once'},'en');
 const next=await service.prepareOperation(path,'create_branch',{name:'after-save'},'en');
 plan.steps.push(...next.steps);
 const mock=t.mock.method(ActivityHistory.prototype,'step',()=>{throw new Error('simulated disk error');});
 const result=await service.executePlan(path,plan,'en');
 assert.deepEqual(result.outcomes.map(s=>s.status),['completed','skipped']);
 assert.equal(git('branch','--show-current'),'main');
 const saved=git('rev-parse','HEAD');
 mock.mock.restore();
 const retry=await service.prepareRetry(path,{plan,outcomes:result.outcomes,stale:false},'en');
 assert.deepEqual(retry.steps.map(s=>s.operation),['create_branch']);
 assert.equal((await service.executePlan(path,retry,'en')).error,undefined);
 assert.equal(git('branch','--show-current'),'after-save');
 assert.equal(git('rev-parse','HEAD'),saved);
 assert.equal(git('rev-list','--count','HEAD'),'2');
});

test('journal failure before execution leaves Git and local edits untouched',async t=>{
 const {path,git}=fixture(t),head=git('rev-parse','HEAD');
 writeFileSync(join(path,'file'),'still unsaved');
 const plan=await service.prepareOperation(path,'commit',{message:'must not run'},'en');
 t.mock.method(ActivityHistory.prototype,'begin',()=>{throw new Error('simulated disk error');});
 await assert.rejects(service.executePlan(path,plan,'en'),/simulated disk error/);
 assert.equal(git('rev-parse','HEAD'),head);
 assert.equal(readFileSync(join(path,'file'),'utf8'),'still unsaved');
});

test('a Git failure remains failed when its journal write also fails',async t=>{
 const {path}=fixture(t);
 const plan=await service.prepareOperation(path,'push',{},'en');
 t.mock.method(ActivityHistory.prototype,'step',()=>{throw new Error('simulated disk error');});
 const result=await service.executePlan(path,plan,'en');
 assert.ok(result.error);
 assert.deepEqual(result.outcomes.map(s=>s.status),['failed']);
 assert.match(result.outcomes[0].output,/destination|upstream|remote/i);
});

test('failed post-execution inspection marks its fallback stale without losing the commit',async t=>{
 const {path,git}=fixture(t),head=git('rev-parse','HEAD');
 writeFileSync(join(path,'file'),'saved before inspection failed');
 const plan=await service.prepareOperation(path,'commit',{message:'save'},'en');
 t.mock.method(ActivityHistory.prototype,'step',()=>{
  renameSync(join(path,'.git'),join(path,'.git-hidden'));
  throw new Error('repository became unavailable');
 });
 const result=await service.executePlan(path,plan,'en');
 renameSync(join(path,'.git-hidden'),join(path,'.git'));
 assert.equal(result.snapshotStale,true);
 assert.equal(result.snapshot.head,head);
 assert.deepEqual(result.outcomes.map(s=>s.status),['completed']);
 assert.equal(git('rev-list','--count','HEAD'),'2');
 assert.equal(git('show','HEAD:file'),'saved before inspection failed');
 assert.equal((await service.getActivityHistory(path)).entries[0].after,undefined);
});
