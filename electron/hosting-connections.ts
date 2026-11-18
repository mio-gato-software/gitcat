import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostingConnection, HostingConnectionInput, NativeHostingProvider, NativeRepository } from "../shared/types.js";
import { hostingBase, nativeRepository, nativeCreationLocation } from "../shared/native-hosting.js";

export const nativeProviders: NativeHostingProvider[] = ["bitbucket", "bitbucket_dc", "azure"];
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The hosting service returned an unexpected response. Check the connection and try again.");return value as Record<string,unknown>; }
export function objects(value: unknown): Record<string, unknown>[] { if (!Array.isArray(value)) throw new Error("The hosting service returned an incomplete list. Check again before publishing.");return value.map(object); }
export class HostingHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
type Stored = HostingConnection & { encryptedToken: string };
type Encryption = { isEncryptionAvailable(): boolean; getSelectedStorageBackend?():string; encryptString(value:string):Buffer; decryptString(value:Buffer):string };
type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Tokens remain in encrypted local storage and main-process memory, never in renderer responses or logs. */
export class HostingConnections {
  constructor(private path:string, private encryption:Encryption, private transport:Transport = (url,init)=>fetch(url,init)) {}
  private secure() { try{return this.encryption.isEncryptionAvailable()&&this.encryption.getSelectedStorageBackend?.()!=='basic_text';}catch{return false;} }
  private read(): Stored[] {
    if (!existsSync(this.path)) return [];
    try {
      const values:unknown = JSON.parse(readFileSync(this.path,"utf8"));
      if (!Array.isArray(values) || values.length > 100) throw new Error("invalid connections");
      return values.map(value=>{
        const row=object(value);
        if(typeof row.id!=="string"||! /^[A-Za-z0-9-]{1,80}$/.test(row.id)||!nativeProviders.includes(row.provider as NativeHostingProvider)||typeof row.baseUrl!=="string"||hostingBase(row.provider as NativeHostingProvider,row.baseUrl)!==row.baseUrl||["username","accountId","label","encryptedToken"].some(key=>typeof row[key]!=="string"))throw new Error("invalid connection");
        return row as Stored;
      });
    } catch { throw new Error("Saved hosting accounts could not be read. The file was preserved; restore it or reconnect after checking your local settings."); }
  }
  private write(rows:Stored[]) {
    mkdirSync(dirname(this.path),{recursive:true});const temporary=`${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary,JSON.stringify(rows),{mode:0o600});renameSync(temporary,this.path);
  }
  private public(row:Stored):HostingConnection { const {id,provider,baseUrl,username,accountId,label}=row;return {id,provider,baseUrl,username,accountId,label}; }
  list() { return { secureStorage:this.secure(), connections:this.read().map(row=>this.public(row)) }; }
  remove(id:string) { const rows=this.read();if(!rows.some(row=>row.id===id))throw new Error("This saved account is no longer available. Refresh the account list.");this.write(rows.filter(row=>row.id!==id));return this.list(); }
  private secret(id:string) {
    const row=this.read().find(row=>row.id===id);
    if(!row)throw new Error("Connect the account in Settings → Hosting accounts, then choose it in Share for review.");
    if(!this.secure())throw new Error("Secure storage is unavailable. Unlock your system account storage and check again.");
    let token:string;
    try { token=this.encryption.decryptString(Buffer.from(row.encryptedToken,"base64")); } catch { throw new Error("The saved hosting sign-in could not be unlocked. Reconnect this account in Settings."); }
    return {row,token};
  }
  authorization(id:string,git=false) {
    const {row,token}=this.secret(id);
    const username=row.provider==='azure'?'gitcat':git&&row.provider==='bitbucket'?'x-bitbucket-api-token-auth':row.username;
    return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  }
  private async send(provider:NativeHostingProvider,baseUrl:string,authorization:string,url:string,method="GET",body?:unknown) {
    const target=new URL(url),allowed=provider==='bitbucket'?'https://api.bitbucket.org/2.0':baseUrl;
    if(target.protocol!=='https:'||target.username||target.password||target.hash||!(target.href.startsWith(allowed+'/')))throw new Error("The hosting request is outside the selected account's service address.");
    let response:Response;
    try { response=await this.transport(target.href,{method,redirect:"error",signal:AbortSignal.timeout(20_000),headers:{Authorization:authorization,Accept:"application/json",...(body!==undefined?{"Content-Type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}); }
    catch { throw new Error(method==='GET'?"Could not reach the hosting service. Your files and saved connection are unchanged; check the network and try again.":"The hosting request was not confirmed. Check the live repository or review before trying again; the service may have completed it."); }
    if(!response.ok)throw new HostingHttpError(response.status,response.status===401?"The hosting sign-in expired or was refused. Reconnect this account in Settings.":response.status===403?"This account or token lacks permission. Check its account-read, repository and pull-request scopes, or choose an account with access.":response.status===404?"The hosting service could not find this repository or project. Check its address and account access.":`The hosting service could not complete the request (HTTP ${response.status}). Check the live state before retrying.`);
    const reader=response.body?.getReader();let text="";let bytes=0;
    if(reader){const decoder=new TextDecoder();try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2_000_000){await reader.cancel();throw new Error("The hosting response was too large to verify. Narrow the request or check it on the service.");}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
    let value:unknown;try{value=text?JSON.parse(text):{};}catch{throw new Error("The hosting service returned an unreadable response. Check the live state before retrying.");}
    return {value,username:response.headers.get('x-ausername')};
  }
  async request(id:string,url:string,method="GET",body?:unknown):Promise<unknown> {
    const {row}=this.secret(id);return (await this.send(row.provider,row.baseUrl,this.authorization(id),url,method,body)).value;
  }
  private async identity(provider:NativeHostingProvider,baseUrl:string,username:string,token:string) {
    const authorization=`Basic ${Buffer.from(`${provider==='azure'?'gitcat':username}:${token}`).toString('base64')}`;
    const get=async(path:string)=>this.send(provider,baseUrl,authorization,path);
    if(provider==='bitbucket') {
      const user=object((await get('https://api.bitbucket.org/2.0/user')).value);
      if(typeof user.uuid!=='string'||!/^\{[a-f0-9-]{36}\}$/i.test(user.uuid)||typeof user.display_name!=='string')throw new Error("Bitbucket could not identify the account. Use a personal API token with account-read access.");
      return {accountId:user.uuid,label:user.display_name};
    }
    if(provider==='azure') {
      const data=object((await get(`${baseUrl}/_apis/connectionData?connectOptions=0&api-version=7.1-preview.1`)).value);
      const user=object(data.authenticatedUser),authorized=object(data.authorizedUser);
      if(typeof user.id!=='string'||!/^[a-f0-9-]{36}$/i.test(user.id)||/^0+-0+-0+-0+-0+$/.test(user.id)||authorized.id!==user.id||user.isActive===false)throw new Error("Azure DevOps could not verify the signed-in account. Use a personal access token for this organization or collection.");
      return {accountId:user.id,label:String(user.providerDisplayName??user.customDisplayName??user.id)};
    }
    // This endpoint requires an authenticated personal user. Project/repository bearer tokens are not accepted.
    const inbox=await get(`${baseUrl}/rest/api/latest/inbox/pull-requests?limit=1`);object(inbox.value);
    const user=object((await get(`${baseUrl}/rest/api/latest/users/${encodeURIComponent(username)}`)).value);
    if(typeof user.id!=='number'||!Number.isSafeInteger(user.id)||typeof user.name!=='string'||user.name.toLowerCase()!==username.toLowerCase()||user.active!==true||(inbox.username&&inbox.username.toLowerCase()!==user.name.toLowerCase()))throw new Error("Bitbucket could not verify this personal account. Use your Bitbucket username and a personal HTTP access token.");
    return {accountId:String(user.id),label:String(user.displayName??user.name)};
  }
  async connect(input:HostingConnectionInput) {
    if(!input||!nativeProviders.includes(input.provider)||typeof input.baseUrl!=='string'||typeof input.username!=='string'||typeof input.token!=='string')throw new Error("Choose the service, address and personal sign-in details.");
    const baseUrl=hostingBase(input.provider,input.baseUrl),username=input.username.trim(),token=input.token.trim();
    if((input.provider!=='azure'&&!username)||username.length>254||/[\r\n:]/.test(username)||username.includes('\0')||!token||token.length>8192||/[\r\n]/.test(token)||token.includes('\0'))throw new Error("Enter a valid account and personal access token. Passwords and shared project tokens are not supported.");
    if(input.provider==='bitbucket'&&!/^[^@\s]+@[^@\s]+$/.test(username))throw new Error("Bitbucket Cloud API tokens use your Atlassian account email, rather than a Bitbucket username.");
    if(!this.secure())throw new Error("Secure storage is unavailable. Unlock your system account storage before connecting.");
    this.read();const identity=await this.identity(input.provider,baseUrl,username,token),rows=this.read();
    const existing=rows.find(row=>row.provider===input.provider&&row.baseUrl===baseUrl&&row.accountId===identity.accountId);
    if(rows.length>=100&&!existing)throw new Error('The saved account limit was reached. Remove an unused account before connecting another.');
    const label=identity.label.split(token).join('[hidden]').split(Buffer.from(`${username}:${token}`).toString('base64')).join('[hidden]').slice(0,250);
    const saved:Stored={id:existing?.id??randomUUID(),provider:input.provider,baseUrl,username,...identity,label,encryptedToken:this.encryption.encryptString(token).toString('base64')};
    this.write([...rows.filter(row=>row.id!==saved.id),saved]);return this.list();
  }
  async verify(id:string) {
    const {row,token}=this.secret(id),identity=await this.identity(row.provider,row.baseUrl,row.username,token);
    if(identity.accountId!==row.accountId)throw new Error("The saved sign-in now identifies a different account. Reconnect it in Settings and review again; no account was switched.");
    return this.public(row);
  }
  select(provider:NativeHostingProvider,remote:string,resolvedHost?:string,id?:string) {
    const candidates=this.read().filter(row=>row.provider===provider&&(!id||row.id===id)).flatMap(row=>{
      try { return [{connection:this.public(row),location:nativeRepository(provider,row.baseUrl,remote,resolvedHost)}]; }catch{return [];}
    });
    if(candidates.length!==1)throw new Error(candidates.length?'Several accounts match this service. Choose the intended saved account in Share for review.':'Connect the matching service account in Settings → Hosting accounts, then choose it in Share for review.');
    return candidates[0];
  }
  creation(provider:NativeHostingProvider,host:string,owner:string,name:string,id?:string) {
    const candidates=this.read().filter(row=>row.provider===provider&&(!id||row.id===id)&&new URL(row.baseUrl).host===host).flatMap(row=>{
      try{return [{connection:this.public(row),location:nativeCreationLocation(provider,row.baseUrl,owner,name)}];}catch{return [];}
    });
    if(candidates.length!==1)throw new Error('Choose a matching saved hosting account in Settings. For Azure, include the organization/collection and project in the owner path.');
    return candidates[0];
  }
}

export function nativeGitConfig(location:NativeRepository,authorization:string) {
  // Authentication is supplied only to this process, scoped to the exact reviewed HTTPS repository.
  // Neither the token nor its encoded header appears in arguments, plans, activity, or Git configuration.
  return {args:['-c','credential.helper=','-c','http.extraHeader=','-c',`http.${location.gitUrl}.extraHeader=`,
    `--config-env=http.${location.gitUrl}.extraHeader=GITCAT_HOST_AUTH`,'-c',`http.${location.gitUrl}.followRedirects=false`],
    env:{GITCAT_HOST_AUTH:`Authorization: ${authorization}`,GIT_ASKPASS:'',GCM_INTERACTIVE:'never'}};
}
