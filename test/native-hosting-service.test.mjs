import test,{after,mock} from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { registerHooks,syncBuiltinESMExports } from 'node:module';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,join } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { nativeFixture } from './helpers/native-hosting-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),scratch=realpathSync(mkdtempSync(join(tmpdir(),'gitcat-native-service-'))),originalSpawn=cp.spawn,originalFetch=globalThis.fetch;
let current;
const git=(cwd,...args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
mock.method(cp,'spawn',(executable,args,options)=>{
 if(/^git(?:\.exe)?$/i.test(basename(executable))&&args.some(a=>['ls-remote','fetch','push'].includes(a))){
  const operation=args.find(a=>['ls-remote','fetch','push'].includes(a));
  if(options.env.GITCAT_HOST_AUTH){
   assert.equal(options.env.GITCAT_HOST_AUTH,`Authorization: Basic ${Buffer.from(`${current.provider==='bitbucket'?'x-bitbucket-api-token-auth':current.provider==='azure'?'gitcat':current.username}:${current.token}`).toString('base64')}`);
   assert.ok(!args.join(' ').includes(current.token));current.gitCalls.push(operation);
  }
  if(current.failPush&&operation==='push')return originalSpawn(process.execPath,['-e',"process.stderr.write('protected branch');process.exit(1)"],options);
  return originalSpawn(executable,['-c',`url.${current.bare}.insteadOf=${current.location.gitUrl}`,...args],options);
 }
 return originalSpawn(executable,args,options);
});
syncBuiltinESMExports();
globalThis.fetch=(...args)=>current.transport(...args);
registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:pathToFileURL(join(root,'test/helpers/electron-stub.mjs')).href,shortCircuit:true}:next(specifier,context);}});
const service=await import('../dist-electron/electron/git-service.js');
after(()=>{mock.restoreAll();syncBuiltinESMExports();globalThis.fetch=originalFetch;rmSync(scratch,{recursive:true,force:true});});

async function fixture(provider,{connect=true}={}){
 const state=nativeFixture(provider),path=join(scratch,`repo-${Math.random()}`);mkdirSync(path);state.path=path;state.bare=path+'-remote.git';state.gitCalls=[];current=state;
 git(path,'init','-q','-b','main');git(path,'config','user.name','Hosting QA');git(path,'config','user.email','qa@example.test');
 writeFileSync(join(path,'base.txt'),'base');git(path,'add','.');git(path,'commit','-qm','Base');git(path,'init','-q','--bare',state.bare);git(path,'push',state.bare,'main');
 git(path,'switch','-qc','work');writeFileSync(join(path,'saved.txt'),'saved');git(path,'add','.');git(path,'commit','-qm','Saved work');writeFileSync(join(path,'unsaved.txt'),'keep local');
 git(path,'remote','add','origin',state.remote);
 if(connect){const result=await service.connectHosting({provider,baseUrl:state.baseUrl,username:state.username,token:state.token});state.connectionId=result.connections.find(c=>c.provider===provider&&c.baseUrl===state.baseUrl).id;}
 return state;
}

for(const provider of ['bitbucket','bitbucket_dc','azure']){
 test(`${provider}: the actual service previews saved commits, publishes with the verified account and reuses its live review`,async()=>{
  const state=await fixture(provider),{path,bare}=state,config=readFileSync(join(path,'.git/config'),'utf8'),index=git(path,'write-tree');
  const request={provider,connectionId:state.connectionId,remote:'origin',head:'work',base:'main',title:'Review',body:'Please review only saved work.'};
  const preview=await service.previewShareReview(path,request);assert.equal(preview.hosting.accountId,state.accountId);assert.equal(preview.commits.length,1);assert.ok(!state.gitCalls.includes('push'));assert.equal(state.reviews.length,0);
  const result=await service.publishShareReview(preview);assert.equal(result.pullRequest.state,'OPEN');assert.equal(git(path,'rev-parse','HEAD'),git(path,'--git-dir',bare,'rev-parse','work'));assert.equal(state.reviews.length,1);
  await service.publishShareReview(await service.previewShareReview(path,request));assert.equal(state.reviews.length,1);assert.equal(state.gitCalls.filter(c=>c==='push').length,1);
  assert.equal(git(path,'status','--porcelain'),'?? unsaved.txt');assert.equal(git(path,'write-tree'),index);assert.equal(readFileSync(join(path,'.git/config'),'utf8'),config);
  assert.equal(readFileSync(join(path,'unsaved.txt'),'utf8'),'keep local');
 });

 test(`${provider}: private creation is confirmed, binds the intended project and leaves unsaved files local`,async()=>{
  const state=await fixture(provider),{path}=state;state.exists=false;git(path,'remote','remove','origin');
  const args={provider,connectionId:state.connectionId,host:new URL(state.baseUrl).host,owner:state.location.owner,name:'repo',source:path,protocol:'https'};
  const plan=await service.prepareOperation(path,'github_create_repo',args,'en');assert.equal(plan.requiresConfirmation,true);assert.equal(state.exists,false);assert.equal(git(path,'remote'),'');assert.ok(!JSON.stringify(plan).includes(state.token));
  const result=await service.executePlan(path,plan,'en');assert.equal(result.error,undefined);assert.equal(state.exists,true);assert.equal(git(path,'remote','get-url','origin'),state.location.gitUrl);assert.equal(git(path,'rev-parse','@{upstream}'),git(path,'rev-parse','HEAD'));assert.equal(readFileSync(join(path,'unsaved.txt'),'utf8'),'keep local');
 });
}

test('a partial review-creation failure keeps publication visible and retry creates only the missing review',async()=>{
 const state=await fixture('bitbucket'),request={provider:'bitbucket',connectionId:state.connectionId,remote:'origin',head:'work',base:'main',title:'Review',body:''};
 const preview=await service.previewShareReview(state.path,request);state.failReview=true;await assert.rejects(service.publishShareReview(preview),/already be published/);assert.equal(state.gitCalls.filter(c=>c==='push').length,1);
 state.failReview=false;await service.publishShareReview(await service.previewShareReview(state.path,request));assert.equal(state.reviews.length,1);assert.equal(state.gitCalls.filter(c=>c==='push').length,1);
});

test('stale accounts and repository identities stop before publishing, while failed private publication preserves prior remote settings',async()=>{
 let state=await fixture('azure'),request={provider:'azure',connectionId:state.connectionId,remote:'origin',head:'work',base:'main',title:'Review',body:''};
 let preview=await service.previewShareReview(state.path,request);state.accountId='99999999-9999-4999-8999-999999999999';await assert.rejects(service.publishShareReview(preview),/different account/);assert.ok(!state.gitCalls.includes('push'));
 state=await fixture('azure');request={...request,connectionId:state.connectionId};preview=await service.previewShareReview(state.path,request);state.repoId='99999999-9999-4999-8999-999999999999';await assert.rejects(service.publishShareReview(preview),/identity changed/);assert.ok(!state.gitCalls.includes('push'));
 state=await fixture('bitbucket_dc');state.exists=false;git(state.path,'remote','set-url','origin','https://old.company.test/scm/TEAM/old.git');git(state.path,'config','remote.origin.tagOpt','--no-tags');const config=readFileSync(join(state.path,'.git/config'),'utf8');
 const plan=await service.prepareOperation(state.path,'github_create_repo',{provider:'bitbucket_dc',connectionId:state.connectionId,host:new URL(state.baseUrl).host,owner:'TEAM',name:'repo',source:state.path,protocol:'https',replaceRemote:'true'},'en');state.failPush=true;
 const failed=await service.executePlan(state.path,plan,'en');assert.match(failed.error,/remote repository was created/);assert.equal(readFileSync(join(state.path,'.git/config'),'utf8'),config);assert.equal(readFileSync(join(state.path,'unsaved.txt'),'utf8'),'keep local');
});
