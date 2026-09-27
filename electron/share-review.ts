import { operationCheckpoint, operationPhase } from "./operation-progress.js";
import { parseRemoteAddress } from './readiness.js';
import { randomUUID } from 'node:crypto';
import type { RemoteReadiness, RepoSnapshot, ShareReviewRequest, ShareReviewPreview, ReviewPullRequest } from '../shared/types.js';

export type ReviewTools = {
 snapshot: (path:string)=>Promise<RepoSnapshot>;
 remote: (path:string,name:string)=>Promise<RemoteReadiness>;
 git: (path:string,args:string[])=>Promise<string>;
 gh: (path:string,args:string[])=>Promise<string>;
 publish: (preview:ShareReviewPreview)=>Promise<void>;
 create: (preview:ShareReviewPreview)=>Promise<void>;
};
const hashPattern=/^[a-f0-9]{40,64}$/;
export function checkedPullRequest(value: unknown, repository: string, head: string, base: string): ReviewPullRequest | undefined {
 if (!value || typeof value!=='object') return;
 const p=value as Record<string,unknown>;
 if (p.headRefName!==head || p.baseRefName!==base || !['OPEN','CLOSED','MERGED'].includes(String(p.state)) || typeof p.url!=='string') return;
 const expected=`https://github.com/${repository}/pull/`;
 if (!p.url.startsWith(expected) || !/^\d+$/.test(p.url.slice(expected.length))) return;
 return {url:p.url,state:p.state as ReviewPullRequest['state'],head,base};
}
async function pullRequest(tools:ReviewTools,path:string,repository:string,head:string,base:string) {
 const values=JSON.parse(await tools.gh(path,['pr','list','--repo',repository,'--head',head,'--base',base,'--state','all','--json','url,state,headRefName,baseRefName','--limit','100']));
 if (!Array.isArray(values)) throw new Error('Pull-request status is unavailable. Check again before publishing.');
 const matches=values.map(v=>checkedPullRequest(v,repository,head,base)).filter((v):v is ReviewPullRequest=>Boolean(v));
 return matches.find(v=>v.state==='OPEN')??matches[0];
}
export async function previewReview(tools:ReviewTools,path:string,input:ShareReviewRequest):Promise<ShareReviewPreview> {
 for (const field of ['remote','head','base','title','body'] as const) if (typeof input[field]!=='string' || input[field].length>(field==='body'?8000:250) || input[field].includes('\0')) throw new Error('Invalid review details.');
 const request={...input,title:input.title.trim()};
 if (!request.title || !request.remote || request.head===request.base) throw new Error('Choose a topic branch and a different base branch, and give the review a title.');
 const snapshot=await tools.snapshot(path);
 if (!snapshot.remotes.includes(request.remote)) throw new Error('Choose a configured remote.');
 for(const name of [request.head,request.base]) { if(name.startsWith('-'))throw new Error('Invalid branch name');await tools.git(path,['check-ref-format','--branch',name]); }
 const remote=await tools.remote(path,request.remote);
 if(remote.status!=='found' || (remote.resolvedHost??remote.host)!=='github.com' || !remote.path || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote.path)) throw new Error('Share for review currently supports GitHub.com. For other hosts, publish through the normal reviewed Push action and open a review on that host.');
 const fetchAddress=parseRemoteAddress(snapshot.remoteUrls[request.remote]??'');
 const pushUrls=(await tools.git(path,['remote','get-url','--push','--all',request.remote])).trim().split('\n');
 if([snapshot.remoteUrls[request.remote]??'',...pushUrls].some(url=>/^https?:\/\/[^/]*@/.test(url)))throw new Error('Remove embedded URL credentials and use the verified account helper before sharing.');
 if(pushUrls.length!==1 || fetchAddress.path!==remote.path || ![remote.host,'github.com'].includes(fetchAddress.host))throw new Error('This remote has different fetch/push repositories or multiple push destinations. Use one explicit GitHub repository for review.');
 if(remote.access!=='ok')throw new Error(`Remote access is ${remote.access}. Check the connection and sign-in in Settings; nothing was published.`);
 const account=remote.account?.accounts.find(a=>a.active)?.login;
 if(!account || remote.account?.differs || remote.account?.verified!==account) throw new Error('The Git push account and active GitHub CLI account must be the same verified account. Review the accounts in Settings; no account was switched.');
 const permission=(await tools.gh(path,['api',`repos/${remote.path}`,'--jq','.permissions.push'])).trim();
 if(permission!=='true') throw new Error('This account cannot publish to this repository. Choose a writable remote or a branch in your fork; no permission checks are bypassed.');
 const headHash=(await tools.git(path,['rev-parse','--verify',`refs/heads/${request.head}`])).trim();
 const raw=await tools.git(path,['ls-remote','--heads',request.remote,`refs/heads/${request.base}`,`refs/heads/${request.head}`]);
 const remoteRefs=new Map(raw.trim().split('\n').filter(Boolean).map(line=>{const [hash,ref]=line.split(/\s+/);return [ref,hash];}));
 const baseHash=remoteRefs.get(`refs/heads/${request.base}`),publishedHash=remoteRefs.get(`refs/heads/${request.head}`);
 if(!hashPattern.test(headHash)||!baseHash||!hashPattern.test(baseHash))throw new Error('The chosen base branch does not exist on that remote. Choose the intended remote base.');
 await tools.git(path,['fetch',request.remote,`+refs/heads/${request.base}:refs/remotes/${request.remote}/${request.base}`,...(publishedHash?[`+refs/heads/${request.head}:refs/remotes/${request.remote}/${request.head}`]:[])]);
 const commits=(await tools.git(path,['log','--reverse','--format=%H%x00%s',`${publishedHash??baseHash}..${headHash}`])).split('\n').filter(Boolean).map(line=>{const [hash,...subject]=line.split('\0');return {hash,subject:subject.join('\0')};});
 const reviewable=Boolean((await tools.git(path,['rev-list','--count',`${baseHash}..${headHash}`])).trim().match(/^[1-9]\d*$/));
 if(publishedHash)await tools.git(path,['merge-base','--is-ancestor',publishedHash,headHash]).catch(()=>{throw new Error('The remote branch contains other work. Receive and review it before sharing; GitCat will not force-push.');});
 const existing=await pullRequest(tools,path,remote.path,request.head,request.base);
 if(!reviewable&&!existing)throw new Error('There are no commits to review against that base. Choose the correct base or save work first.');
 return {id:randomUUID(),repoPath:snapshot.path,request,headHash,baseHash,publishedHash,repository:remote.path,remoteUrl:remote.url,account,commits,existing,reviewable,checkedAt:new Date().toISOString()};
}
export async function publishReview(tools:ReviewTools,preview:ShareReviewPreview) {
 const fresh=await previewReview(tools,preview.repoPath,preview.request);
 if(!fresh.reviewable)throw new Error("There are no remaining commits to review against this base. The live review state is available without publishing again.");
 for(const key of ['headHash','baseHash','publishedHash','repository','remoteUrl','account'] as const)if(fresh[key]!==preview[key])throw new Error('The branch, remote or account changed. Review sharing again; nothing was published.');
 if(fresh.existing?.url!==preview.existing?.url || fresh.existing?.state!==preview.existing?.state)throw new Error('Pull-request status changed. Review sharing again before publishing.');
 operationCheckpoint();
 operationPhase("executing",1,2);
 if(fresh.commits.length) {
  try { await tools.publish(fresh); } catch(error) { throw new Error(`Publishing was not confirmed. Check remote state before retrying. A protected branch or permission rule may require a topic branch or writable fork. No force-push was attempted. ${error instanceof Error?error.message:String(error)}`); }
 }
 operationCheckpoint();
 operationPhase("executing",2,2);
 const publishedRefs=await tools.git(fresh.repoPath,['ls-remote','--heads',fresh.request.remote,`refs/heads/${fresh.request.head}`,`refs/heads/${fresh.request.base}`]);
 const tips=new Map(publishedRefs.trim().split('\n').filter(Boolean).map(line=>{const [hash,ref]=line.split(/\s+/);return [ref,hash];}));
 if(tips.get(`refs/heads/${fresh.request.head}`)!==fresh.headHash || tips.get(`refs/heads/${fresh.request.base}`)!==fresh.baseHash)throw new Error('Publication may have completed, but remote branches moved before review submission. Check live status and review again.');
 let current=await pullRequest(tools,fresh.repoPath,fresh.repository,fresh.request.head,fresh.request.base);
 if(current?.state!=='OPEN') {
  try { await tools.create(fresh); } catch(error) { throw new Error(`The branch may already be published, but review creation was not confirmed. Check the live review status before retrying. ${error instanceof Error?error.message:String(error)}`); }
  current=await pullRequest(tools,fresh.repoPath,fresh.repository,fresh.request.head,fresh.request.base);
 }
 if(!current || current.state!=='OPEN')throw new Error('The branch is published, but an open review could not be verified. Refresh live status before retrying.');
 return {snapshot:await tools.snapshot(fresh.repoPath),pullRequest:current};
}
