import { nativeRepository } from '../../dist-electron/shared/native-hosting.js';

export function nativeFixture(provider='bitbucket') {
 const state={provider,username:provider==='bitbucket'?'anna@example.test':provider==='bitbucket_dc'?'anna':'',token:'synthetic-personal-token',accountId:provider==='bitbucket'?'{11111111-1111-4111-8111-111111111111}':provider==='bitbucket_dc'?'17':'11111111-1111-4111-8111-111111111111',label:'Anna Work',repoId:provider==='bitbucket'?'{22222222-2222-4222-8222-222222222222}':provider==='bitbucket_dc'?'22':'22222222-2222-4222-8222-222222222222',projectId:provider==='azure'?'33333333-3333-4333-8333-333333333333':'3',exists:true,private:true,writable:true,failReview:false,failIdentity:false,failCreate:false,reviews:[],calls:[]};
 state.baseUrl=provider==='bitbucket'?'https://bitbucket.org':provider==='bitbucket_dc'?'https://code.company.test/bitbucket':'https://dev.azure.com/acme';
 state.remote=provider==='bitbucket'?'git@bitbucket.org:team/repo.git':provider==='bitbucket_dc'?'ssh://git@code.company.test:7999/TEAM/repo.git':'git@ssh.dev.azure.com:v3/acme/My%20Project/repo';
 state.location=nativeRepository(provider,state.baseUrl,state.remote);
 const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
 const row=()=>provider==='bitbucket'?{uuid:state.repoId,full_name:'team/repo',is_private:state.private}:provider==='bitbucket_dc'?{id:22,slug:'repo',public:!state.private,project:{key:'TEAM',id:3}}:{id:state.repoId,name:'repo',project:{id:state.projectId,name:'My Project',visibility:state.private?'private':'public'}};
 state.review=(head,base,id=1,status='OPEN')=>provider==='bitbucket'?{id,state:status==='CLOSED'?'DECLINED':status,title:'Review',source:{branch:{name:head},repository:{uuid:state.repoId}},destination:{branch:{name:base},repository:{uuid:state.repoId}},links:{html:{href:`${state.location.webUrl}/pull-requests/${id}`}}}:provider==='bitbucket_dc'?{id,state:status==='CLOSED'?'DECLINED':status,fromRef:{id:`refs/heads/${head}`,repository:{id:22}},toRef:{id:`refs/heads/${base}`,repository:{id:22}},links:{self:[{href:`${state.location.webUrl}/pull-requests/${id}`}]}}:{pullRequestId:id,status:{OPEN:'active',CLOSED:'abandoned',MERGED:'completed'}[status],sourceRefName:`refs/heads/${head}`,targetRefName:`refs/heads/${base}`,repository:{id:state.repoId},_links:{web:{href:`${state.location.webUrl}/pullrequest/${id}`}}};
 state.transport=async(input,init={})=>{
  const url=new URL(input),method=init.method??'GET',authorization=init.headers?.Authorization;
  const body=init.body?JSON.parse(init.body):undefined;
  state.calls.push({url:url.href,method,authorization,body,redirect:init.redirect});
  const expected=`Basic ${Buffer.from(`${provider==='azure'?'gitcat':state.username}:${state.token}`).toString('base64')}`;
  if(authorization!==expected)return response({error:'bad credentials'},401);
  if(state.failIdentity&&(url.pathname.endsWith('/user')||url.pathname.endsWith('/connectionData')||url.pathname.endsWith('/inbox/pull-requests')))return response({},401);
  if(provider==='bitbucket'&&url.pathname==='/2.0/user')return response({uuid:state.accountId,display_name:state.label});
  if(provider==='azure'&&url.pathname.endsWith('/_apis/connectionData'))return response({authenticatedUser:{id:state.accountId,providerDisplayName:state.label,isActive:true},authorizedUser:{id:state.accountId}});
  if(provider==='bitbucket_dc'&&url.pathname.endsWith('/inbox/pull-requests'))return response({values:[],isLastPage:true},200,{'X-AUSERNAME':state.username});
  if(provider==='bitbucket_dc'&&url.pathname.endsWith('/users/'+state.username))return response({id:17,name:state.username,displayName:state.label,active:true});
  if(url.href.split('?')[0]===state.location.apiUrl){
   if(method==='POST'){
    if(state.failCreate)return response({},403);state.exists=true;state.private=body.is_private===true;return response(row());
   }
   return state.exists?response(row()):response({},404);
  }
  if(provider==='bitbucket'&&url.pathname==='/2.0/user/permissions/repositories')return response({values:state.writable?[{permission:'write',repository:{uuid:state.repoId}}]:[]});
  if(provider==='bitbucket'&&url.pathname==='/2.0/workspaces/team')return response({slug:'team',uuid:'{44444444-4444-4444-8444-444444444444}'});
  if(provider==='bitbucket_dc'&&url.pathname.endsWith('/rest/api/latest/repos'))return response({values:state.writable?[row()]:[],isLastPage:true});
  if(provider==='bitbucket_dc'&&url.pathname.endsWith('/projects/TEAM'))return response({id:3,key:'TEAM',public:!state.private});
  if(provider==='azure'&&url.pathname.includes('/_apis/permissions/'))return response({value:[state.writable],count:1});
  if(provider==='azure'&&decodeURIComponent(url.pathname).endsWith('/_apis/projects/My Project'))return response({id:state.projectId,name:'My Project',visibility:state.private?'private':'public'});
  if((provider==='bitbucket_dc'&&url.pathname.endsWith('/projects/TEAM/repos'))||(provider==='azure'&&url.pathname.endsWith('/_apis/git/repositories'))){
   if(method!=='POST')throw new Error('Unexpected listing');if(state.failCreate)return response({},403);state.exists=true;return response(row());
  }
  if(url.pathname.endsWith('/pullrequests')||url.pathname.endsWith('/pull-requests')){
   if(method==='POST'){
    if(state.failReview)return response({},503);
    const head=body.source?.branch?.name??body.fromRef?.id?.slice(11)??body.sourceRefName?.slice(11);
    const base=body.destination?.branch?.name??body.toRef?.id?.slice(11)??body.targetRefName?.slice(11);
    const review=state.review(head,base,state.reviews.length+1);state.reviews.unshift(review);return response(review,201);
   }
   return response(provider==='azure'?{value:state.reviews,count:state.reviews.length}:provider==='bitbucket_dc'?{values:state.reviews,isLastPage:true}:{values:state.reviews});
  }
  throw new Error('Unexpected hosting request: '+method+' '+url.href);
 };
 return state;
}
