import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingProvider, validHostingHost, validHostingRepository } from '../dist-electron/shared/hosting.js';
import { checkedReview, createReviewArgs, findReview } from '../dist-electron/electron/review-provider.js';
import { assertGitlabProjectAvailable, createGitlabProjectArgs, gitlabCreationFacts } from '../dist-electron/electron/gitlab-repository.js';
import { buildRepositoryPlan, assertRepositoryPlan, validateRepositoryFields } from '../dist-electron/electron/repository-plan.js';
import { accountReadiness, credentialHelperKind } from '../dist-electron/electron/readiness.js';
import { parseSshGreeting } from '../dist-electron/electron/host-identity.js';

test('company hosts require a service choice and repository paths cannot escape their namespace',()=>{
 assert.equal(hostingProvider('gitlab.com'),'gitlab');assert.equal(hostingProvider('github.com'),'github');
 assert.equal(hostingProvider('gitlab-looking.example'),undefined);
 assert.equal(hostingProvider('company.example','gitlab'),'gitlab');
 assert.throws(()=>hostingProvider('github.com','gitlab'),/does not match/);
 for(const host of ['company.example','company.example:8443','localhost'])assert.equal(validHostingHost(host),true);
 for(const host of ['bad:99999','-option','company.test@evil.test','company.test/path','company..test','https://company.test'])assert.equal(validHostingHost(host),false);
 assert.equal(validHostingRepository('team/subgroup/repo','gitlab'),true);
 for(const path of ['team/../repo','team//repo','team/repo?x=1','team/repo#fragment','team/repo%2Fother'])assert.equal(validHostingRepository(path,'gitlab'),false);
 assert.equal(validHostingRepository('team/subgroup/repo','github'),false);
});

test('GitLab greeting and exclusive credential helpers distinguish the actual publishing account',()=>{
 assert.equal(parseSshGreeting('Welcome to GitLab, @anna.work_2!'),'anna.work_2');
 const accounts=[{login:'anna.work_2',active:true}];
 assert.equal(credentialHelperKind(['', '!glab auth git-credential']),'glab');
 const ready=accountReadiness({cli:'glab',ghInstalled:true,accounts,protocol:'https',helper:'glab',access:'ok'});
 assert.equal(ready.verified,'anna.work_2');assert.equal(ready.verifiedBy,'glab');
 assert.equal(credentialHelperKind(['osxkeychain','!glab auth git-credential']),'other');
 assert.equal(credentialHelperKind(['!echo glab auth git-credential']),'other');
 assert.equal(credentialHelperKind(['!glab auth git-credential; echo other']),'other');
 assert.equal(credentialHelperKind(['!"C:\\Program Files\\glab.exe" auth git-credential']),'glab');
 assert.equal(accountReadiness({cli:'glab',ghInstalled:true,accounts,protocol:'https',helper:'gh',access:'ok'}).verified,undefined);
});

test('GitLab creation plans preserve nested namespaces and the explicit company service',()=>{
 const plan=buildRepositoryPlan({provider:'gitlab',host:'code.company.test',owner:'org/team',repository:'app',localPath:'/project',protocol:'ssh'});
 assert.equal(plan.remoteUrl,'git@code.company.test:org/team/app.git');assert.equal(plan.provider,'gitlab');assert.doesNotThrow(()=>assertRepositoryPlan(plan));
 assert.throws(()=>assertRepositoryPlan({...plan,provider:'github'}));
 assert.equal(validateRepositoryFields({host:'code.company.test'}).issues.some(i=>i.field==='provider'),true);
});

test('GitLab review requests pin the selected project, preserve literal text, and never push implicitly',()=>{
 const args=createReviewArgs({provider:'gitlab',host:'code.company.test',repository:'org/team/app',request:{head:'feature/work',base:'main',title:'@title.txt',body:':branch\n$(literal)'}});
 assert.equal(args[1],'projects/org%2Fteam%2Fapp/merge_requests');
 assert.ok(args.includes('title=@title.txt'));assert.ok(args.includes('description=:branch\n$(literal)'));assert.ok(args.includes('--raw-field'));assert.ok(!args.includes('--push'));
 const repo={provider:'gitlab',host:'code.company.test',repository:'org/team/app',projectId:8};
 const mr={source_branch:'work',target_branch:'main',source_project_id:8,target_project_id:8,state:'opened',web_url:'https://code.company.test/org/team/app/-/merge_requests/1'};
 assert.equal(checkedReview(mr,repo,'work','main').state,'OPEN');
 for(const changed of [{source_project_id:9},{web_url:'https://code.company.test.evil/org/team/app/-/merge_requests/1'},{web_url:mr.web_url+'#fragment'},{state:'locked'},{state:'toString'}])assert.equal(checkedReview({...mr,...changed},repo,'work','main'),undefined);
});

test('GitLab pagination finds an existing open review beyond the first page',async()=>{
 const repo={provider:'gitlab',host:'gitlab.com',repository:'org/repo',projectId:8};
 const closed={source_branch:'work',target_branch:'main',source_project_id:8,target_project_id:8,state:'closed',web_url:'https://gitlab.com/org/repo/-/merge_requests/1'};
 const calls=[];
 const review=await findReview(async(provider,host,args)=>{calls.push({provider,host,args});return JSON.stringify(calls.length===1?Array(100).fill(closed):[{...closed,state:'opened'}]);},repo,'work','main');
 assert.equal(review.state,'OPEN');assert.equal(calls.length,2);assert.match(calls[1].args[1],/page=2/);
});

test('GitLab checks group creation permission and rejects redirects, missing access and ambiguous availability',async()=>{
 const api=(changes={})=>async args=>JSON.stringify(({
  user:{id:1,username:'anna'},'namespaces/org%2Fteam':{id:2,kind:'group',full_path:'org/team'},
  'groups/org%2Fteam':{id:3,full_path:'org/team',project_creation_level:'maintainer'},
  'groups/3/members/all/1':{id:1,access_level:40},...changes
 })[args[1]]);
 assert.deepEqual(await gitlabCreationFacts(api(),'org/team'),{account:'anna',namespaceId:'2'});
 await assert.rejects(gitlabCreationFacts(api({'groups/3/members/all/1':{id:1,access_level:30}}),'org/team'),/cannot create/);
 await assert.rejects(gitlabCreationFacts(api({'namespaces/org%2Fteam':{id:2,kind:'group',full_path:'other'}}),'org/team'),/different namespace/);
 await assertGitlabProjectAvailable(async()=>{throw new Error('GET projects: 404 Not Found');},'org/repo');
 await assert.rejects(assertGitlabProjectAvailable(async()=>{throw new Error('connection refused');},'org/repo'),/Could not check/);
 await assert.rejects(assertGitlabProjectAvailable(async()=>'{}','org/repo'),/already exists/);
 const args=createGitlabProjectArgs('app','2');assert.ok(args.includes('visibility=private'));assert.ok(args.includes('namespace_id=2'));assert.ok(args.includes('initialize_with_readme=false'));
});
