import type { NativeHostingContext, NativeRepository, ReviewPullRequest, ShareReviewRequest } from "../shared/types.js";
import { object, objects, HostingHttpError } from "./hosting-connections.js";

export type NativeApi = (url:string,method?:string,body?:unknown)=>Promise<unknown>;
const gitNamespace='52d39943-cb85-4d7f-8fa8-c6baac873819';
const guid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const withQuery=(url:string,values:Record<string,string>)=>`${url}?${new URLSearchParams(values)}`;
export type NativeRepositoryFacts = { id:string; projectId?:string };

export async function nativeRepositoryFacts(api:NativeApi,location:NativeRepository,permissions=true):Promise<NativeRepositoryFacts> {
  const row=object(await api(withQuery(location.apiUrl,location.provider==='azure'?{'api-version':'7.1'}:{})));
  if(location.provider==='bitbucket') {
    if(typeof row.uuid!=='string'||!/^\{[a-f0-9-]{36}\}$/i.test(row.uuid)||String(row.full_name).toLowerCase()!==location.repository.toLowerCase())throw new Error('Bitbucket returned a different repository. Check its address before publishing.');
    if(permissions){const result=object(await api(withQuery('https://api.bitbucket.org/2.0/user/permissions/repositories',{q:`repository.uuid=${JSON.stringify(row.uuid)}`,pagelen:'100'})));
      if(!objects(result.values).some(p=>object(p.repository).uuid===row.uuid&&['admin','write'].includes(String(p.permission))))throw new Error('This Bitbucket account cannot publish here. Choose a writable repository or ask its owner for access.');}
    return {id:row.uuid};
  }
  if(location.provider==='bitbucket_dc') {
    if(!Number.isSafeInteger(row.id)||typeof row.id!=='number'||row.slug!==location.name||String(object(row.project).key).toLowerCase()!==location.owner.toLowerCase()||row.archived===true)throw new Error('Bitbucket returned a different or archived repository. Check its address.');
    if(permissions){let found=false,start=0;for(let page=0;page<20;page++){
      const result=object(await api(withQuery(`${location.baseUrl}/rest/api/latest/repos`,{permission:'REPO_WRITE',projectkey:location.owner,name:location.name,limit:'100',start:String(start)})));
      found=objects(result.values).some(r=>r.id===row.id);if(found||result.isLastPage===true)break;
      if(!Number.isSafeInteger(result.nextPageStart)||Number(result.nextPageStart)<=start)throw new Error('Repository permissions were incomplete. Check the account and try again.');start=Number(result.nextPageStart);
    }if(!found)throw new Error('This Bitbucket account cannot publish here. Choose a writable repository or ask its owner for access.');}
    return {id:String(row.id)};
  }
  const project=object(row.project);
  if(!guid(row.id)||!guid(project.id)||row.name!==location.name||project.name!==location.project||row.isDisabled===true||row.isInMaintenance===true)throw new Error('Azure DevOps returned a different or unavailable repository. Check the organization, project and repository.');
  if(permissions){for(const permission of ['4','16384']){
    const result=object(await api(withQuery(`${location.baseUrl}/_apis/permissions/${gitNamespace}/${permission}`,{tokens:`repoV2/${project.id}/${row.id}`,alwaysAllowAdministrators:'true','api-version':'7.1'})));
    if(!Array.isArray(result.value)||result.value.length!==1||result.value[0]!==true)throw new Error('This Azure DevOps account cannot contribute code and pull requests here. Choose a writable repository or ask its owner for access.');
  }}
  return {id:String(row.id),projectId:String(project.id)};
}

export function checkedNativeReview(value:unknown,context:NativeHostingContext,facts:NativeRepositoryFacts,head:string,base:string):ReviewPullRequest|undefined {
  const row=object(value),location=context.location;
  let state:ReviewPullRequest['state']|undefined,id:unknown,url:unknown;
  if(location.provider==='bitbucket') {
    const source=object(row.source),destination=object(row.destination);
    if(object(source.branch).name!==head||object(destination.branch).name!==base||object(source.repository).uuid!==facts.id||object(destination.repository).uuid!==facts.id)return;
    state=row.state==='OPEN'?'OPEN':row.state==='MERGED'?'MERGED':['DECLINED','SUPERSEDED'].includes(String(row.state))?'CLOSED':undefined;
    id=row.id;url=object(object(row.links).html).href;
  }else if(location.provider==='bitbucket_dc') {
    const source=object(row.fromRef),destination=object(row.toRef);
    if(source.id!==`refs/heads/${head}`||destination.id!==`refs/heads/${base}`||String(object(source.repository).id)!==facts.id||String(object(destination.repository).id)!==facts.id)return;
    state=row.state==='OPEN'?'OPEN':row.state==='MERGED'?'MERGED':row.state==='DECLINED'?'CLOSED':undefined;
    id=row.id;url=objects(object(row.links).self)[0]?.href;
  }else {
    if(row.sourceRefName!==`refs/heads/${head}`||row.targetRefName!==`refs/heads/${base}`||object(row.repository).id!==facts.id||row.forkSource)return;
    state=row.status==='active'?'OPEN':row.status==='completed'?'MERGED':row.status==='abandoned'?'CLOSED':undefined;
    id=row.pullRequestId;url=object(row._links??{}).web?object(object(row._links).web).href:undefined;
  }
  if(!state||!Number.isSafeInteger(id)||Number(id)<1)throw new Error('The hosting service returned an unexpected review state. Check live status before publishing.');
  const expected=`${location.webUrl}/${location.provider==='azure'?'pullrequest':'pull-requests'}/${id}`;
  if(url!==undefined&&url!==expected&&!(location.provider==='bitbucket_dc'&&url===expected+'/overview'))throw new Error('The hosting service returned a review link outside the verified repository. Check the repository address before continuing.');
  if(location.provider!=='azure'&&url===undefined)throw new Error('The hosting service returned an incomplete review link. Check live status before publishing.');
  return {url:expected,state,head,base};
}

export async function findNativeReview(api:NativeApi,context:NativeHostingContext,facts:NativeRepositoryFacts,head:string,base:string) {
  const {location}=context;let first:ReviewPullRequest|undefined,start=0;
  for(let page=1;page<=20;page++) {
    const url=location.provider==='bitbucket'?withQuery(location.apiUrl+'/pullrequests',{q:`source.branch.name=${JSON.stringify(head)} AND destination.branch.name=${JSON.stringify(base)}`,state:'ALL',pagelen:'100',page:String(page)})
      :location.provider==='bitbucket_dc'?withQuery(location.apiUrl+'/pull-requests',{state:'ALL',direction:'OUTGOING',at:`refs/heads/${head}`,limit:'100',start:String(start)})
      :withQuery(location.apiUrl+'/pullrequests',{'searchCriteria.status':'all','searchCriteria.sourceRefName':`refs/heads/${head}`,'searchCriteria.targetRefName':`refs/heads/${base}`,'$top':'100','$skip':String(start),'api-version':'7.1'});
    // Bitbucket Cloud accepts repeated state parameters, rather than an ALL state.
    const queryUrl=location.provider==='bitbucket'?url.replace('state=ALL','state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED'):url;
    const result=object(await api(queryUrl)),values=objects(location.provider==='azure'?result.value:result.values);
    for(const value of values){const review=checkedNativeReview(value,context,facts,head,base);if(review?.state==='OPEN')return review;if(review&&!first)first=review;}
    if(location.provider==='bitbucket') { if(result.next===undefined)return first;if(typeof result.next!=='string')throw new Error('The hosting service returned incomplete review pagination. Check live status again.'); }
    else if(location.provider==='bitbucket_dc'){if(result.isLastPage===true)return first;if(!Number.isSafeInteger(result.nextPageStart)||Number(result.nextPageStart)<=start)throw new Error('The hosting service returned incomplete review pagination. Check live status again.');start=Number(result.nextPageStart);}
    else {if(values.length<100)return first;start+=100;}
  }
  throw new Error('There are too many matching reviews to verify safely. Check the hosting service before publishing.');
}

export async function createNativeReview(api:NativeApi,context:NativeHostingContext,facts:NativeRepositoryFacts,request:ShareReviewRequest) {
  const {location}=context;
  if(location.provider==='bitbucket')return api(location.apiUrl+'/pullrequests','POST',{title:request.title,description:request.body,source:{branch:{name:request.head},repository:{uuid:facts.id}},destination:{branch:{name:request.base},repository:{uuid:facts.id}},close_source_branch:false});
  if(location.provider==='bitbucket_dc') {
    const repository={id:Number(facts.id),slug:location.name,project:{key:location.owner}};
    return api(location.apiUrl+'/pull-requests','POST',{title:request.title,description:request.body,fromRef:{id:`refs/heads/${request.head}`,repository},toRef:{id:`refs/heads/${request.base}`,repository}});
  }
  return api(withQuery(location.apiUrl+'/pullrequests',{'api-version':'7.1'}),'POST',{title:request.title,description:request.body,sourceRefName:`refs/heads/${request.head}`,targetRefName:`refs/heads/${request.base}`});
}

export async function nativeCreationFacts(api:NativeApi,location:NativeRepository) {
  let id:string;
  if(location.provider==='bitbucket'){
    const workspace=object(await api(`https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(location.owner)}`));
    if(workspace.slug!==location.owner||typeof workspace.uuid!=='string')throw new Error('Bitbucket returned a different workspace. Check the destination.');id=workspace.uuid;
  }else if(location.provider==='bitbucket_dc'){
    const project=object(await api(`${location.baseUrl}/rest/api/latest/projects/${encodeURIComponent(location.owner)}`));
    if(String(project.key).toLowerCase()!==location.owner.toLowerCase()||project.public!==false||!Number.isSafeInteger(project.id))throw new Error('Choose a private Bitbucket project. A public project cannot be used for private repository creation.');id=String(project.id);
  }else{
    const project=object(await api(withQuery(`${location.baseUrl}/_apis/projects/${encodeURIComponent(location.project!)}`,{'api-version':'7.1'})));
    if(project.name!==location.project||project.visibility!=='private'||!guid(project.id))throw new Error('Choose an existing private Azure DevOps project. Repository visibility is inherited from its project.');id=String(project.id);
  }
  try{await api(withQuery(location.apiUrl,location.provider==='azure'?{'api-version':'7.1'}:{}));}
  catch(error){if(error instanceof HostingHttpError&&error.status===404)return {namespaceId:id};throw error;}
  throw new Error('That repository already exists. Connect its existing address or choose another name.');
}

export async function createNativeRepository(api:NativeApi,location:NativeRepository,namespaceId:string) {
  let created:unknown;
  if(location.provider==='bitbucket')created=await api(location.apiUrl,'POST',{scm:'git',is_private:true,name:location.name});
  else if(location.provider==='bitbucket_dc')created=await api(`${location.baseUrl}/rest/api/latest/projects/${encodeURIComponent(location.owner)}/repos`,'POST',{name:location.name,scmId:'git',forkable:true,public:false});
  else created=await api(withQuery(`${location.baseUrl}/${encodeURIComponent(location.project!)}/_apis/git/repositories`,{'api-version':'7.1'}),'POST',{name:location.name,project:{id:namespaceId}});
  const row=object(created);
  if(location.provider==='bitbucket'&&(row.is_private!==true||String(row.full_name).toLowerCase()!==location.repository.toLowerCase()))throw new Error('The repository may have been created, but its private destination could not be confirmed. Check the service before retrying.');
  if(location.provider==='bitbucket_dc'&&(row.public!==false||row.slug!==location.name||String(object(row.project).id)!==namespaceId))throw new Error('The repository may have been created, but its private destination could not be confirmed. Check the service before retrying.');
  if(location.provider==='azure'&&(row.name!==location.name||object(row.project).id!==namespaceId||object(row.project).visibility!=='private'))throw new Error('The repository may have been created, but its private project could not be confirmed. Check the service before retrying.');
  return created;
}
