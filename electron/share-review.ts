import { operationCheckpoint, operationPhase } from "./operation-progress.js";
import { parseRemoteAddress } from './readiness.js';
import { randomUUID } from 'node:crypto';
import type { HostingProvider, NativeHostingContext, RemoteReadiness, RepoSnapshot, ShareReviewRequest, ShareReviewPreview } from '../shared/types.js';
import { hostingProvider, validHostingHost, validHostingRepository, isNativeProvider } from '../shared/hosting.js';
import { nativeRepository } from '../shared/native-hosting.js';
import { findNativeReview, nativeRepositoryFacts } from './native-reviews.js';
import { checkedReview, checkReviewPermission, findReview, type ReviewCommand } from './review-provider.js';

export type ReviewTools = {
 snapshot: (path:string)=>Promise<RepoSnapshot>;
 remote: (path:string,name:string,provider?:HostingProvider,connectionId?:string)=>Promise<RemoteReadiness>;
 git: (path:string,args:string[],hosting?:NativeHostingContext)=>Promise<string>;
 gh: (path:string,args:string[],host:string)=>Promise<string>;
 glab: (path:string,args:string[],host:string)=>Promise<string>;
 api?: (context:NativeHostingContext,url:string,method?:string,body?:unknown)=>Promise<unknown>;
 publish: (preview:ShareReviewPreview)=>Promise<void>;
 create: (preview:ShareReviewPreview)=>Promise<void>;
};
const hashPattern=/^[a-f0-9]{40,64}$/;
export function checkedPullRequest(value: unknown, repository: string, head: string, base: string) {
 return checkedReview(value,{provider:'github',host:'github.com',repository},head,base);
}
const commandFor=(tools:ReviewTools,path:string):ReviewCommand=>(provider,host,args)=>(provider==='github'?tools.gh:tools.glab)(path,args,host);
export async function previewReview(tools:ReviewTools,path:string,input:ShareReviewRequest):Promise<ShareReviewPreview> {
 for (const field of ['remote','head','base','title','body'] as const) if (typeof input[field]!=='string' || input[field].length>(field==='body'?8000:250) || input[field].includes('\0')) throw new Error('Invalid review details.');
 if(input.connectionId!==undefined&&(typeof input.connectionId!=='string'||! /^[A-Za-z0-9-]{1,80}$/.test(input.connectionId)))throw new Error('Choose a saved hosting account.');
 const request={...input,title:input.title.trim()};
 if (!request.title || !request.remote || request.head===request.base) throw new Error('Choose a topic branch and a different base branch, and give the review a title.');
 const snapshot=await tools.snapshot(path);
 if (!snapshot.remotes.includes(request.remote)) throw new Error('Choose a configured remote.');
 for(const name of [request.head,request.base]) { if(name.startsWith('-'))throw new Error('Invalid branch name');await tools.git(path,['check-ref-format','--branch',name]); }
 const remote=await tools.remote(path,request.remote,request.provider,request.connectionId);
 if(remote.status!=='found')throw new Error('Choose a configured remote.');
 const pushAddress=parseRemoteAddress(remote.url);
 const hostname=remote.resolvedHost??remote.host;
 const provider=hostingProvider(hostname,request.provider??remote.provider);
 if(!provider)throw new Error('Choose GitHub or GitLab, Bitbucket Data Center, or Azure DevOps for this company host. For another service, publish with Push and open a review on that service.');
 const host=`${hostname??''}${pushAddress.protocol==='https'&&pushAddress.port?`:${pushAddress.port}`:''}`;
 if(!validHostingHost(host)||!remote.path||(!isNativeProvider(provider)&&!validHostingRepository(remote.path,provider))||!['ssh','https'].includes(remote.protocol)||/^http:\/\//i.test(remote.url))throw new Error('Use an HTTPS or SSH repository address for this service. Check the company host and repository path in Settings.');
 const fetchAddress=parseRemoteAddress(snapshot.remoteUrls[request.remote]??'');
 const pushUrls=(await tools.git(path,['remote','get-url','--push','--all',request.remote])).trim().split('\n');
 if([snapshot.remoteUrls[request.remote]??'',...pushUrls].some(url=>/^https?:\/\/[^/]*@/.test(url)&&(!isNativeProvider(provider)||Boolean(new URL(url).password))))throw new Error('Remove embedded URL credentials and use the verified account helper before sharing.');
 const actualPush=parseRemoteAddress(pushUrls[0]??'');
 if(pushUrls.length!==1 || (!isNativeProvider(provider)&&(fetchAddress.path!==remote.path || ![remote.host,hostname].includes(fetchAddress.host))) || actualPush.path!==remote.path || actualPush.host!==remote.host || actualPush.port!==pushAddress.port)throw new Error('This remote has different fetch/push repositories or multiple push destinations. Use one explicit repository for review.');
 let hosting=remote.hosting;
 if(isNativeProvider(provider)){
  if(!hosting||remote.account?.verified!==hosting.accountId||remote.access!=='ok')throw new Error(remote.detail??'Connect and verify the matching account in Settings → Hosting accounts, then choose it in Share for review.');
  const fetch=nativeRepository(provider,hosting.location.baseUrl,snapshot.remoteUrls[request.remote]??'',fetchAddress.host===remote.host?remote.resolvedHost:undefined);
  const push=nativeRepository(provider,hosting.location.baseUrl,pushUrls[0],remote.resolvedHost);
  if(fetch.gitUrl!==hosting.location.gitUrl||push.gitUrl!==hosting.location.gitUrl)throw new Error('Fetch and push point to different repositories. Choose one explicit repository for review.');
 }
 if(remote.access!=='ok')throw new Error(`Remote access is ${remote.access}. Check the connection and sign-in in Settings; nothing was published.`);
 const account=remote.account?.accounts.find(a=>a.active)?.login;
 const cli=provider==='github'?'gh':'glab';
 if(!isNativeProvider(provider)&&remote.account?.gh==='missing')throw new Error(`Install ${provider==='github'?'GitHub':'GitLab'} CLI (${cli}), then sign in with ${cli} auth login --hostname ${host} and check again. Ordinary Push remains available with your existing Git access.`);
 if(remote.protocol==='ssh'&&remote.account?.accounts.length&&!remote.account.verified)throw new Error(`GitCat could not verify the publishing account for this SSH configuration. Use a standard git@ SSH address and key, or HTTPS with ${cli} as the credential helper, then check again. Ordinary Push remains available.`);
 if(remote.protocol==='https'&&account&&!remote.account?.verified)throw new Error(`The HTTPS sign-in does not prove which account publishes. To make Git use the active ${cli} account on ${host}, run ${provider==='github'?`gh auth setup-git --hostname ${host}`:`glab auth login --hostname ${host} --setup-git-credential-helper`} in a terminal, then check again. No sign-in settings were changed by GitCat.`);
 if(!account || remote.account?.differs || remote.account?.verified?.toLowerCase()!==account.toLowerCase()) throw new Error(`Publishing and review must use the same verified account. In a terminal, run ${cli} auth login --hostname ${host}${provider==='gitlab'?' --setup-git-credential-helper':''}, then check again. For SSH, choose a key for the active ${cli} account. No account was switched.`);
 const command=commandFor(tools,path);
 const api=hosting?(url:string,method?:string,body?:unknown)=>tools.api!(hosting!,url,method,body):undefined;
 const facts=hosting?await nativeRepositoryFacts(api!,hosting.location):undefined;
 if(hosting&&facts)hosting={...hosting,repositoryId:facts.id,...(facts.projectId?{projectId:facts.projectId}:{})};
 const repository=hosting?undefined:await checkReviewPermission(command,{provider,host,repository:remote.path});
 const remoteGit=(args:string[])=>tools.git(path,args,hosting);
 const headHash=(await tools.git(path,['rev-parse','--verify',`refs/heads/${request.head}`])).trim();
 const raw=await remoteGit(['ls-remote','--heads',request.remote,`refs/heads/${request.base}`,`refs/heads/${request.head}`]);
 const remoteRefs=new Map(raw.trim().split('\n').filter(Boolean).map(line=>{const [hash,ref]=line.split(/\s+/);return [ref,hash];}));
 const baseHash=remoteRefs.get(`refs/heads/${request.base}`),publishedHash=remoteRefs.get(`refs/heads/${request.head}`);
 if(!hashPattern.test(headHash)||!baseHash||!hashPattern.test(baseHash))throw new Error('The chosen base branch does not exist on that remote. Choose the intended remote base.');
 await remoteGit(['fetch',request.remote,`+refs/heads/${request.base}:refs/remotes/${request.remote}/${request.base}`,...(publishedHash?[`+refs/heads/${request.head}:refs/remotes/${request.remote}/${request.head}`]:[])]);
 const commits=(await tools.git(path,['log','--reverse','--format=%H%x00%s',`${publishedHash??baseHash}..${headHash}`])).split('\n').filter(Boolean).map(line=>{const [hash,...subject]=line.split('\0');return {hash,subject:subject.join('\0')};});
 const reviewable=Boolean((await tools.git(path,['rev-list','--count',`${baseHash}..${headHash}`])).trim().match(/^[1-9]\d*$/));
 if(publishedHash)await tools.git(path,['merge-base','--is-ancestor',publishedHash,headHash]).catch(()=>{throw new Error('The remote branch contains other work. Receive and review it before sharing; GitCat will not force-push.');});
 const existing=hosting?await findNativeReview(api!,hosting,facts!,request.head,request.base):await findReview(command,repository!,request.head,request.base);
 if(!reviewable&&!existing)throw new Error('There are no commits to review against that base. Choose the correct base or save work first.');
 return {id:randomUUID(),repoPath:snapshot.path,request,provider,host,...(hosting?{hosting}:{}),headHash,baseHash,publishedHash,repository:hosting?.location.repository??remote.path,remoteUrl:remote.url,account,commits,existing,reviewable,checkedAt:new Date().toISOString()};
}
export async function publishReview(tools:ReviewTools,preview:ShareReviewPreview) {
 const fresh=await previewReview(tools,preview.repoPath,preview.request);
 if(!fresh.reviewable)throw new Error("There are no remaining commits to review against this base. The live review state is available without publishing again.");
 for(const key of ['provider','host','headHash','baseHash','publishedHash','repository','remoteUrl','account'] as const)if(fresh[key]!==preview[key])throw new Error('The branch, remote or account changed. Review sharing again; nothing was published.');
 if(JSON.stringify(fresh.hosting)!==JSON.stringify(preview.hosting))throw new Error('The hosting account or remote repository identity changed. Review sharing again; nothing was published.');
 if(fresh.existing?.url!==preview.existing?.url || fresh.existing?.state!==preview.existing?.state)throw new Error('Pull-request status changed. Review sharing again before publishing.');
 operationCheckpoint();
 operationPhase("executing",1,2);
 if(fresh.commits.length) {
  try { await tools.publish(fresh); } catch(error) { throw new Error(`Publishing was not confirmed. Check remote state before retrying. A protected branch or permission rule may require a topic branch or writable fork. No force-push was attempted. ${error instanceof Error?error.message:String(error)}`, {cause:error}); }
 }
 operationCheckpoint();
 operationPhase("executing",2,2);
 const publishedRefs=await tools.git(fresh.repoPath,['ls-remote','--heads',fresh.request.remote,`refs/heads/${fresh.request.head}`,`refs/heads/${fresh.request.base}`],fresh.hosting);
 const tips=new Map(publishedRefs.trim().split('\n').filter(Boolean).map(line=>{const [hash,ref]=line.split(/\s+/);return [ref,hash];}));
 if(tips.get(`refs/heads/${fresh.request.head}`)!==fresh.headHash || tips.get(`refs/heads/${fresh.request.base}`)!==fresh.baseHash)throw new Error('Publication may have completed, but remote branches moved before review submission. Check live status and review again.');
 const command=commandFor(tools,fresh.repoPath);
 const api=fresh.hosting?(url:string,method?:string,body?:unknown)=>tools.api!(fresh.hosting!,url,method,body):undefined;
 const facts=fresh.hosting?await nativeRepositoryFacts(api!,fresh.hosting.location):undefined;
 if(facts&&facts.id!==fresh.hosting!.repositoryId)throw new Error('The branch may be published, but the remote repository identity changed. Check live status before retrying.');
 const repository=fresh.hosting?undefined:await checkReviewPermission(command,{provider:fresh.provider,host:fresh.host,repository:fresh.repository});
 const live=()=>fresh.hosting?findNativeReview(api!,fresh.hosting,facts!,fresh.request.head,fresh.request.base):findReview(command,repository!,fresh.request.head,fresh.request.base);
 let current=await live();
 if(current?.state!=='OPEN') {
  try { await tools.create(fresh); } catch(error) { throw new Error(`The branch may already be published, but review creation was not confirmed. Check the live review status before retrying. ${error instanceof Error?error.message:String(error)}`, {cause:error}); }
  current=await live();
 }
 if(!current || current.state!=='OPEN')throw new Error('The branch is published, but an open review could not be verified. Refresh live status before retrying.');
 return {snapshot:await tools.snapshot(fresh.repoPath),pullRequest:current};
}
