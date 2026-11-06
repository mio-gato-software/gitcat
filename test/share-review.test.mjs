import test from 'node:test';import assert from 'node:assert/strict';
const {previewReview,publishReview,checkedPullRequest}=await import('../dist-electron/electron/share-review.js');
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
function fixture(options={}){
 const state={head:a,base:b,published:undefined,account:'alice',verified:'alice',permission:'true',access:'ok',host:'github.com',prs:[],writes:[],failPush:false,failCreate:false,provider:'github',repository:'org/repo',protocol:'ssh',...options};
 const request={...(options.provider?{provider:options.provider}:{}),remote:'origin',head:'feature/work',base:'main',title:'Review work',body:'Please review.'};
 const url=()=>state.protocol==='ssh'?`git@${state.host}:${state.repository}.git`:`https://${state.host}/${state.repository}.git`;
 const snapshot={path:'/project',remotes:['origin'],get remoteUrls(){return {origin:url()};}};
 const tools={snapshot:async()=>snapshot,remote:async()=>({status:'found',host:state.host,protocol:state.protocol,path:state.repository,url:url(),access:state.access,account:{accounts:[{login:state.account,active:true},{login:'other',active:false}],verified:state.verified,differs:state.account!==state.verified}}),
 git:async(_path,args)=>{
  if(args[0]==='check-ref-format'||args[0]==='fetch'||args[0]==='merge-base')return '';
  if(args[0]==='remote')return state.pushUrls??url();
  if(args[0]==='rev-parse')return state.head;
  if(args[0]==='ls-remote')return `${state.base}\trefs/heads/main\n${state.published?`${state.published}\trefs/heads/feature/work\n`:''}`;
  if(args[0]==='log')return state.published===state.head?'':`${state.head}\0Saved work`;
  if(args[0]==='rev-list')return '1';throw new Error('Unexpected Git call '+args.join(' '));
 },glab:async(_path,args,host)=>{assert.equal(host,state.host);if(args[1].startsWith('projects/')&&!args[1].includes('/merge_requests'))return JSON.stringify({id:4,path_with_namespace:state.repository,permissions:{group_access:{access_level:state.permission==='true'?40:10}}});return JSON.stringify(state.prs);},gh:async(_path,args)=>args[0]==='api'?state.permission:JSON.stringify(state.prs),
 publish:async p=>{if(state.failPush)throw new Error('protected branch');state.writes.push(['push',p.headHash]);state.published=p.headHash;},
 create:async p=>{if(state.failCreate)throw new Error('offline');state.writes.push(['create',p.request.head,p.request.base]);state.prs=state.provider==='gitlab'?[{web_url:`https://${state.host}/${state.repository}/-/merge_requests/12`,state:'opened',source_branch:p.request.head,target_branch:p.request.base,source_project_id:4,target_project_id:4}]:[{url:`https://${state.host}/${state.repository}/pull/12`,state:'OPEN',headRefName:p.request.head,baseRefName:p.request.base}];}};
 return {state,request,tools};
}
test('a review names its remote, verified account, base, head and commits before publication',async()=>{const{state,request,tools}=fixture();const p=await previewReview(tools,'/project',request);assert.equal(p.account,'alice');assert.equal(p.commits[0].hash,a);assert.deepEqual(state.writes,[]);const result=await publishReview(tools,p);assert.equal(result.pullRequest.url,'https://github.com/org/repo/pull/12');assert.deepEqual(state.writes,[['push',a],['create','feature/work','main']]);});
test('an existing open review is updated without creating a duplicate',async()=>{const{state,request,tools}=fixture();state.prs=[{url:'https://github.com/org/repo/pull/2',state:'OPEN',headRefName:request.head,baseRefName:request.base}];const p=await previewReview(tools,'/project',request);await publishReview(tools,p);assert.deepEqual(state.writes,[['push',a]]);});
test('closed and merged live states are distinguished and a new review is explicitly created',async()=>{for(const status of ['CLOSED','MERGED']){const{state,request,tools}=fixture();state.prs=[{url:'https://github.com/org/repo/pull/2',state:status,headRefName:request.head,baseRefName:request.base}];const p=await previewReview(tools,'/project',request);assert.equal(p.existing.state,status);assert.equal((await publishReview(tools,p)).pullRequest.state,'OPEN');}});
test('wrong base, offline access, unsupported hosts and multiple-account mismatch block before publication',async()=>{
 for(const change of [{base:''},{access:'offline'},{host:'unknown.test'},{verified:'other'},{permission:'false'}]){const{state,request,tools}=fixture();Object.assign(state,change);await assert.rejects(previewReview(tools,'/project',request));assert.deepEqual(state.writes,[]);}
 const{request,tools}=fixture();await assert.rejects(previewReview(tools,'/project',{...request,base:request.head}),/different base/);
});
test('changes to the head, base, or verified account after preview require a new review',async()=>{for(const field of ['head','base','account']){const{state,request,tools}=fixture();const p=await previewReview(tools,'/project',request);state[field]=field==='account'?'bob':c;if(field==='account')state.verified='bob';await assert.rejects(publishReview(tools,p),/changed/);assert.deepEqual(state.writes,[]);}});
test('protected branch and review-service failure describe the partial result without force or duplicate publication',async()=>{const{state,request,tools}=fixture();let p=await previewReview(tools,'/project',request);state.failPush=true;await assert.rejects(publishReview(tools,p),/No force-push/);assert.deepEqual(state.writes,[]);state.failPush=false;state.failCreate=true;p=await previewReview(tools,'/project',request);await assert.rejects(publishReview(tools,p),/already be published/);assert.deepEqual(state.writes,[['push',a]]);});
test('historical text and untrusted URLs are never accepted as live pull-request status',()=>{assert.equal(checkedPullRequest({url:'https://evil.test/pull/1',state:'OPEN',headRefName:'work',baseRefName:'main'},'org/repo','work','main'),undefined);assert.equal(checkedPullRequest({url:'https://github.com/org/repo/pull/1',state:'UNKNOWN',headRefName:'work',baseRefName:'main'},'org/repo','work','main'),undefined);});
test('base and head at the same remote commit both remain in the ref map',async()=>{const{state,request,tools}=fixture();state.published=b;const p=await previewReview(tools,'/project',request);assert.equal(p.baseHash,b);assert.equal(p.publishedHash,b);});

test('GitLab.com, nested groups, company GitLab and GitHub Enterprise use the same confirmed publication flow',async()=>{
 for(const options of [
  {provider:'gitlab',host:'gitlab.com',repository:'org/team/repo'},
  {provider:'gitlab',host:'code.company.test',repository:'org/subgroup/repo',protocol:'https'},
  {provider:'github',host:'github.company.test'}
 ]){
  const {state,request,tools}=fixture(options);
  const p=await previewReview(tools,'/project',request);
  assert.equal(p.provider,options.provider);assert.equal(p.host,options.host);assert.deepEqual(state.writes,[]);
  const result=await publishReview(tools,p);
  assert.equal(result.pullRequest.url,`https://${state.host}/${state.repository}/${state.provider==='gitlab'?'-/merge_requests':'pull'}/12`);
  assert.deepEqual(state.writes,[['push',a],['create','feature/work','main']]);
 }
});

test('GitLab open, closed and merged reviews are read live; cross-fork matches are excluded',async()=>{
 for(const status of ['opened','closed','merged']){
  const{state,request,tools}=fixture({provider:'gitlab',host:'gitlab.com'});
  const mr={web_url:'https://gitlab.com/org/repo/-/merge_requests/3',state:status,source_branch:request.head,target_branch:request.base,source_project_id:4,target_project_id:4};
  state.prs=[{...mr,source_project_id:99},mr];
  const p=await previewReview(tools,'/project',request);
  assert.equal(p.existing.state,{opened:'OPEN',closed:'CLOSED',merged:'MERGED'}[status]);
  await publishReview(tools,p);assert.equal(state.writes.filter(w=>w[0]==='create').length,status==='opened'?0:1);
 }
});

test('GitLab permissions, wrong-account checks and company-host selection fail before publication',async()=>{
 for(const change of [{permission:'false'},{verified:'other'},{access:'offline'},{pushUrls:'git@gitlab.com:org/other.git'}]){
  const{state,request,tools}=fixture({provider:'gitlab',host:'gitlab.com',...change});
  await assert.rejects(previewReview(tools,'/project',request));assert.deepEqual(state.writes,[]);
 }
 const{state,request,tools}=fixture({host:'code.company.test'});
 await assert.rejects(previewReview(tools,'/project',request),/Choose GitHub or GitLab/);assert.deepEqual(state.writes,[]);
 await assert.rejects(previewReview(tools,'/project',{...request,provider:'other'}),/Choose GitHub or GitLab/);
});

test('GitLab rejects an unexpected review URL and stale identity before any write',async()=>{
 const{state,request,tools}=fixture({provider:'gitlab',host:'gitlab.com'});
 state.prs=[{web_url:'https://evil.test/org/repo/-/merge_requests/3',state:'opened',source_branch:request.head,target_branch:request.base,source_project_id:4,target_project_id:4}];
 await assert.rejects(previewReview(tools,'/project',request),/unexpected review/);assert.deepEqual(state.writes,[]);
 state.prs=[];const p=await previewReview(tools,'/project',request);state.host='other.company.test';
 await assert.rejects(publishReview(tools,p),/changed/);assert.deepEqual(state.writes,[]);
});
