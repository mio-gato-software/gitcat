import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gitcat-hosting-')));
const bin = join(scratch, 'bin');mkdirSync(bin);
writeFileSync(join(bin, process.platform === 'win32' ? 'glab.exe' : 'glab'), '', { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = bin + delimiter + originalPath;
const nativeSpawn = cp.spawn;
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
let current;
mock.method(cp, 'spawn', (executable, args, options) => {
 if (/^glab(?:\.exe)?$/i.test(basename(executable))) return nativeSpawn(process.execPath, [join(root,'test/helpers/hosting-cli.mjs'),current.stateFile,...args],options);
 if (/^git(?:\.exe)?$/i.test(basename(executable)) && args.some(arg => ['ls-remote','fetch','push'].includes(arg))) {
  if (current.failPush && args.includes('push')) return nativeSpawn(process.execPath,['-e',"process.stderr.write('protected branch');process.exit(1)"],options);
  return nativeSpawn(executable,['-c',`url.${current.bare}.insteadOf=https://code.company.test/org/team/repo.git`,...args],options);
 }
 return nativeSpawn(executable,args,options);
});
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:pathToFileURL(join(root,'test/helpers/electron-stub.mjs')).href,shortCircuit:true}:next(specifier,context);}});
const service = await import('../dist-electron/electron/git-service.js');
after(()=>{mock.restoreAll();syncBuiltinESMExports();process.env.PATH=originalPath;rmSync(scratch,{recursive:true,force:true});});

function fixture() {
 const path=join(scratch,`repo-${Math.random()}`);mkdirSync(path);
 const bare=path+'-remote.git';git(path,'init','-q','-b','main');git(path,'config','user.name','QA');git(path,'config','user.email','qa@example.test');
 writeFileSync(join(path,'file.txt'),'base');git(path,'add','.');git(path,'commit','-qm','Base');
 git(path,'init','--bare','-q',bare);git(path,'push',bare,'main');git(path,'switch','-qc','work');
 writeFileSync(join(path,'saved.txt'),'saved');git(path,'add','.');git(path,'commit','-qm','Saved work');
 writeFileSync(join(path,'unsaved.txt'),'keep me');
 git(path,'config','credential.helper','');git(path,'config','--add','credential.helper','!glab auth git-credential');
 const stateFile=path+'-hosting.json';writeFileSync(stateFile,JSON.stringify({account:'anna.work',created:false,reviews:[],calls:[]}));
 current={path,bare,stateFile};return current;
}
const state = () => JSON.parse(readFileSync(current.stateFile,'utf8'));
const changeState = value => writeFileSync(current.stateFile,JSON.stringify({...state(),...value}));

test('GitLab private creation, publishing, account readiness and review creation run through the actual service',async()=>{
 const {path,bare}=fixture();
 const plan=await service.prepareOperation(path,'github_create_repo',{provider:'gitlab',owner:'org/team',host:'code.company.test',name:'repo',source:path,protocol:'https'},'en');
 assert.equal(plan.requiresConfirmation,true);assert.equal(state().created,false);assert.equal(git(path,'remote'),'');
 const created=await service.executePlan(path,plan,'en');assert.equal(created.error,undefined);assert.equal(state().created,true);
 assert.equal(git(path,'remote','get-url','origin'),'https://code.company.test/org/team/repo.git');
 assert.equal(git(path,'rev-parse','HEAD'),git(path,'--git-dir',bare,'rev-parse','work'));
 const ready=await service.checkReadiness(path,{remote:'origin',provider:'gitlab',access:true});
 assert.equal(ready.remote.account.verified,'anna.work');assert.equal(ready.remote.account.cli,'glab');
 git(path,'config','--replace-all','credential.helper','osxkeychain');git(path,'config','--add','credential.helper','!glab auth git-credential');
 const ambiguous=await service.checkReadiness(path,{remote:'origin',provider:'gitlab',access:true});
 assert.equal(ambiguous.remote.helper,'other');assert.equal(ambiguous.remote.account.verified,undefined,'The last configured helper does not prove which one answered');
 git(path,'config','credential.https://code.company.test.helper','');git(path,'config','--add','credential.https://code.company.test.helper','!glab auth git-credential');
 const scoped=await service.checkReadiness(path,{remote:'origin',provider:'gitlab',access:true});
 assert.equal(scoped.remote.account.verified,'anna.work','A host-specific reset makes the selected helper unambiguous');
 const request={remote:'origin',provider:'gitlab',head:'work',base:'main',title:'Review',body:'@literal.md'};
 const preview=await service.previewShareReview(path,request);assert.equal(preview.commits.length,0);assert.equal(state().reviews.length,0);
 const result=await service.publishShareReview(preview);assert.equal(result.pullRequest.state,'OPEN');assert.equal(state().reviews.length,1);
 const again=await service.previewShareReview(path,request);await service.publishShareReview(again);assert.equal(state().reviews.length,1);
 assert.equal(readFileSync(join(path,'unsaved.txt'),'utf8'),'keep me');assert.equal(git(path,'status','--porcelain'),'?? unsaved.txt');
 assert.ok(state().calls.some(args=>args.includes('visibility=private')));
 assert.ok(state().calls.some(args=>args.includes('description=@literal.md')));
 assert.ok(state().calls.every(args=>!args.includes('switch')&&!args.includes('token')));
});

test('a changed GitLab account prevents creation and an execution failure preserves the previous remote configuration',async()=>{
 const {path}=fixture();git(path,'remote','add','origin','https://old.company.test/org/repo.git');git(path,'config','remote.origin.tagOpt','--no-tags');
 const config=readFileSync(join(path,'.git/config'),'utf8');
 const args={provider:'gitlab',owner:'org/team',host:'code.company.test',name:'repo',source:path,protocol:'https',replaceRemote:'true'};
 let plan=await service.prepareOperation(path,'github_create_repo',args,'en');changeState({account:'other'});
 const stale=await service.executePlan(path,plan,'en');assert.match(stale.error,/account or namespace changed/);assert.equal(state().created,false);assert.equal(readFileSync(join(path,'.git/config'),'utf8'),config);
 changeState({account:'anna.work'});plan=await service.prepareOperation(path,'github_create_repo',args,'en');current.failPush=true;
 const failed=await service.executePlan(path,plan,'en');assert.match(failed.error,/remote repository was created/);assert.equal(state().created,true);
 assert.equal(readFileSync(join(path,'.git/config'),'utf8'),config);assert.equal(readFileSync(join(path,'unsaved.txt'),'utf8'),'keep me');
});
