import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
registerHooks({ resolve(s,c,n) { return s === 'electron' ? { url: new URL('./helpers/electron-stub.mjs', import.meta.url).href, shortCircuit: true } : n(s,c); } });
const { trackOperation, cancelOperation, listOperations, operationCheckpoint } = await import('../dist-electron/electron/operation-progress.js');
const service = await import('../dist-electron/electron/git-service.js');

test('cancellation rejects late read results, isolates repositories and rejects duplicate requests', async () => {
 let release;
 const waiting = new Promise(resolve => { release = resolve; });
 const events = [];
 const pending = trackOperation('/a', 'planning', p => events.push(p), () => waiting);
 assert.equal(cancelOperation('/b', events[0].id), false);
 await assert.rejects(trackOperation('/a', 'planning', () => {}, async () => 0), /already running/);
 assert.equal(cancelOperation('/a', events[0].id), true);
 const rejected = assert.rejects(pending, /Operation stopped/);
 release('late executable plan'); await rejected;
 assert.equal(events.at(-1).state, 'stopped');
 assert.equal(listOperations().length, 0);
 assert.equal(await trackOperation('/a', 'planning', () => {}, async () => 42), 42);
});

test('a stop before a queued step prevents it from running', async () => {
 let release; const gate = new Promise(r => release = r); let ran = false; let id;
 const pending = trackOperation('/queue', 'planning', p => id = p.id, async () => { await gate; operationCheckpoint(); ran = true; });
 cancelOperation('/queue', id); const rejected = assert.rejects(pending, /Operation stopped/); release(); await rejected;
 assert.equal(ran, false);
});

function fixture(t) {
 const path = mkdtempSync(join(tmpdir(), 'gitcat-progress-'));
 t.after(() => rmSync(path, { recursive: true, force: true }));
 const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
 git('init','-q','-b','main'); git('config','user.name','QA'); git('config','user.email','qa@example.test');
 writeFileSync(join(path,'file'),'base'); git('add','.'); git('commit','-qm','base'); git('switch','-qc','work');
 return {path,git};
}
test('an in-flight save finishes and later integration steps are skipped with a fresh snapshot', async t => {
 const {path,git} = fixture(t);
 writeFileSync(join(path,'file'),'saved work');
 const before = await service.getSnapshot(path);
 const plan = await service.prepareBranchDelivery(path,{stateId:before.stateId,message:'Save',mergeToDefault:true},'en');
 const events = [];
 const result = await trackOperation(path,'executing', p => {
   events.push(p);
   if (p.phase === 'executing' && p.step === 1 && !p.stopping) cancelOperation(path,p.id);
 }, () => service.executePlan(path,plan,'en'),true);
 assert.deepEqual(result.outcomes.map(o => o.status), ['completed','skipped','skipped']);
 assert.equal(git('show','HEAD:file'),'saved work');
 assert.equal(result.snapshot.currentBranch,'work');
 assert.equal(result.snapshot.head,git('rev-parse','HEAD'));
 assert.match(result.error,/nothing was rolled back/);
 assert.equal(events.at(-1).state,'stopped');
});

test('a timeout waits for the Git child to exit before repository inspection and keeps partial effects', async t => {
 const {path,git} = fixture(t);
 // Git alias simulates a slow mutation without network or paid services.
 git('config','alias.slow','!touch partial; sleep 10');
 await assert.rejects(service.runGit(path,['slow'],100), /timed out/);
 assert.equal(existsSync(join(path,'partial')),true);
 assert.equal((await service.getSnapshot(path)).changes.some(f => f.path === 'partial'),true);
});

test('provider abort reaches fetch and late provider data cannot become a result', async () => {
 const original = globalThis.fetch;
 try {
   globalThis.fetch = async () => ({ ok:true, json:async () => ({output_text:'ok'}) });
   await service.saveLlmConfig({ apiKey:'test-key',model:'gpt-5.6-luna' });
   let observed = false, id;
   globalThis.fetch = (_url, {signal}) => new Promise((_resolve, reject) => {
     signal.addEventListener('abort', () => { observed = true; reject(new Error('aborted')); });
     cancelOperation('/provider', id);
   });
   await assert.rejects(trackOperation('/provider','planning', p => { id = p.id; }, () => service.verifyLlmConfig()), /Operation stopped/);
   assert.equal(observed,true);
 } finally { globalThis.fetch = original; }
});
