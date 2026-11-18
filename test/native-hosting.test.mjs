import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { nativeFixture } from './helpers/native-hosting-fixture.mjs';
import { HostingConnections, nativeGitConfig, HostingHttpError } from '../dist-electron/electron/hosting-connections.js';
import { nativeRepositoryFacts, findNativeReview, createNativeReview, checkedNativeReview, nativeCreationFacts, createNativeRepository } from '../dist-electron/electron/native-reviews.js';
import { hostingBase, nativeRepository, inferHostingBase } from '../dist-electron/shared/native-hosting.js';
import { buildRepositoryPlan, assertRepositoryPlan } from '../dist-electron/electron/repository-plan.js';

function fixture(t,provider='bitbucket') {
 const directory=mkdtempSync(join(tmpdir(),'gitcat-native-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'hosting.json'),key=randomBytes(32);
 const encryption={isEncryptionAvailable:()=>true,encryptString:value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},decryptString:value=>{const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
 const state=nativeFixture(provider),store=new HostingConnections(path,encryption,state.transport);
 const connect=()=>store.connect({provider,baseUrl:state.baseUrl,username:state.username,token:state.token});
 return {state,store,path,encryption,connect};
}

test('native service addresses cover Cloud, Data Center contexts, legacy Azure and SSH without accepting path escapes',()=>{
 const bb=nativeRepository('bitbucket','https://bitbucket.org','https://anna@bitbucket.org/team/repo.git');assert.equal(bb.gitUrl,'https://bitbucket.org/team/repo.git');
 const dc=nativeRepository('bitbucket_dc','https://code.company.test/bitbucket','ssh://git@code.company.test:7999/TEAM/repo.git');assert.equal(dc.gitUrl,'https://code.company.test/bitbucket/scm/TEAM/repo.git');
 const azure=nativeRepository('azure','https://dev.azure.com/acme','git@ssh.dev.azure.com:v3/acme/My%20Project/repo');assert.equal(azure.gitUrl,'https://dev.azure.com/acme/My%20Project/_git/repo');
 assert.equal(nativeRepository('azure','https://dev.azure.com/acme','https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/repo').gitUrl,azure.gitUrl);
 const server=nativeRepository('azure','https://server.test/tfs/Collection','https://server.test/tfs/Collection/Project/_git/repo');assert.equal(server.project,'Project');
 assert.equal(hostingBase('azure','https://acme.visualstudio.com'),'https://dev.azure.com/acme');assert.equal(inferHostingBase('azure',azure.gitUrl),'https://dev.azure.com/acme');
 for(const url of ['https://bitbucket.org/team/repo%2Fother.git','https://bitbucket.org/team/repo.git?secret=x','http://bitbucket.org/team/repo.git','https://token:secret@bitbucket.org/team/repo.git','https://evil.test/team/repo.git'])assert.throws(()=>nativeRepository('bitbucket','https://bitbucket.org',url));
 assert.throws(()=>nativeRepository('azure','https://dev.azure.com/acme','git@ssh.dev.azure.com:v3/other/Project/repo'));
});

for(const provider of ['bitbucket','bitbucket_dc','azure']) {
 test(`${provider}: personal account tokens are verified, encrypted and never returned in account metadata`,async t=>{
  const{state,store,path,connect,encryption}=fixture(t,provider);const list=await connect();
  assert.equal(list.connections[0].accountId,state.accountId);assert.ok(!JSON.stringify(list).includes(state.token));assert.ok(!readFileSync(path,'utf8').includes(state.token));
  const connection=list.connections[0];assert.equal((await store.verify(connection.id)).accountId,state.accountId);
  assert.equal(new HostingConnections(path,encryption,state.transport).list().connections[0].id,connection.id);
  const config=nativeGitConfig(state.location,store.authorization(connection.id,true));
  assert.ok(!config.args.some(arg=>arg.includes(state.token)));assert.ok(!config.args.some(arg=>arg.includes(store.authorization(connection.id,true))));assert.ok(config.env.GITCAT_HOST_AUTH.startsWith('Authorization: Basic '));
  if(provider==='bitbucket')assert.equal(Buffer.from(config.env.GITCAT_HOST_AUTH.split(' ').at(-1),'base64').toString(),`x-bitbucket-api-token-auth:${state.token}`);
  const before=readFileSync(path,'utf8');state.failIdentity=true;await assert.rejects(connect(),/expired or was refused/);assert.equal(readFileSync(path,'utf8'),before);state.failIdentity=false;
  const calls=state.calls.length;await assert.rejects(store.request(connection.id,'https://evil.test/steal'),/outside/);assert.equal(state.calls.length,calls);
  assert.ok(state.calls.every(call=>call.redirect==='error'));
 });

 test(`${provider}: writable repository checks and open/closed/merged live reviews keep exact branch and repository identities`,async t=>{
  const{state,store,connect}=fixture(t,provider);const connection=(await connect()).connections[0],api=(...args)=>store.request(connection.id,...args),context={connectionId:connection.id,location:state.location,accountId:state.accountId,label:state.label};
  const facts=await nativeRepositoryFacts(api,state.location);assert.equal(facts.id,state.repoId);
  for(const status of ['OPEN','CLOSED','MERGED']){state.reviews=[state.review('work','main',3,status)];assert.equal((await findNativeReview(api,context,facts,'work','main')).state,status);}
  await createNativeReview(api,context,facts,{head:'work',base:'main',title:'@literal',body:':branch\n$(literal)'});assert.equal((await findNativeReview(api,context,facts,'work','main')).state,'OPEN');
  const body=state.calls.filter(c=>c.method==='POST').at(-1).body;assert.equal(body.title,'@literal');assert.equal(body.description,':branch\n$(literal)');
  if(provider==='bitbucket_dc')for(const ref of [body.fromRef,body.toRef])assert.deepEqual(ref.repository,{id:Number(facts.id),slug:state.location.name,project:{key:state.location.owner}});
  state.writable=false;await assert.rejects(nativeRepositoryFacts(api,state.location),/cannot/);
 });

 test(`${provider}: private creation rechecks the destination and refuses existing repositories`,async t=>{
  const{state,store,connect}=fixture(t,provider);const id=(await connect()).connections[0].id,api=(...args)=>store.request(id,...args);
  await assert.rejects(nativeCreationFacts(api,state.location),/already exists/);state.exists=false;
  if(provider!=='bitbucket'){state.private=false;await assert.rejects(nativeCreationFacts(api,state.location),/private/);state.private=true;}
  const facts=await nativeCreationFacts(api,state.location);await createNativeRepository(api,state.location,facts.namespaceId);assert.equal(state.exists,true);assert.equal(state.private,true);
  const plan=buildRepositoryPlan({provider,host:new URL(state.baseUrl).host,serviceUrl:state.baseUrl,connectionId:id,owner:state.location.owner,repository:'repo',localPath:'/project',protocol:'https'});
  assert.equal(plan.remoteUrl,state.location.gitUrl);assert.doesNotThrow(()=>assertRepositoryPlan(plan));
 });
}

test('a changed saved identity, unreadable encrypted token or unavailable secure storage never silently chooses another account',async t=>{
 const{state,store,path,connect,encryption}=fixture(t);const id=(await connect()).connections[0].id;state.accountId='{99999999-9999-4999-8999-999999999999}';await assert.rejects(store.verify(id),/different account/);
 const locked=new HostingConnections(path,{...encryption,isEncryptionAvailable:()=>false},state.transport);await assert.rejects(locked.connect({provider:'bitbucket',baseUrl:state.baseUrl,username:state.username,token:state.token}),/Secure storage/);
 writeFileSync(path,'corrupted');assert.throws(()=>store.list(),/preserved/);assert.equal(readFileSync(path,'utf8'),'corrupted');
});

test('a basic-text storage fallback refuses tokens before making an authentication request',async t=>{
 const{state,path,encryption}=fixture(t);const store=new HostingConnections(path,{...encryption,getSelectedStorageBackend:()=> 'basic_text'},state.transport);
 assert.equal(store.list().secureStorage,false);
 await assert.rejects(store.connect({provider:'bitbucket',baseUrl:state.baseUrl,username:state.username,token:state.token}),/Secure storage/);
 assert.equal(state.calls.length,0);
});

test('untrusted and cross-fork review results never become open-review links',async t=>{
 const{state,store,connect}=fixture(t,'azure');const id=(await connect()).connections[0].id,api=(...args)=>store.request(id,...args),context={connectionId:id,location:state.location,accountId:state.accountId,label:state.label},facts=await nativeRepositoryFacts(api,state.location),review=state.review('work','main');
 assert.equal(checkedNativeReview({...review,forkSource:{repository:{id:'other'}}},context,facts,'work','main'),undefined);
 assert.throws(()=>checkedNativeReview({...review,_links:{web:{href:'https://evil.test/pullrequest/1'}}},context,facts,'work','main'),/outside/);
 assert.throws(()=>checkedNativeReview({...review,status:'toString'},context,facts,'work','main'),/unexpected review state/);
 assert.ok(new HostingHttpError(404,'missing') instanceof Error);
});
