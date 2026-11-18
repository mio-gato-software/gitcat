import type { NativeHostingProvider, NativeRepository } from "./types.js";

export function cleanSegment(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("The repository address contains an invalid encoded name."); }
  if (!decoded || decoded === "." || decoded === ".." || /[\\/?#%]/.test(decoded) || [...decoded].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)) throw new Error("Check the repository address: each name must be a single path segment.");
  return decoded;
}
const segments = (path: string) => path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map(cleanSegment);
const encoded = (parts: string[]) => parts.map(encodeURIComponent).join("/");

/** The service scope is also the boundary for sending the saved sign-in. */
export function hostingBase(provider: NativeHostingProvider, input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter the service's full HTTPS address."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS service address without a username, token, query or fragment.");
  let parts = segments(url.pathname);
  if (provider === "bitbucket") {
    if (url.host !== "bitbucket.org" || parts.length) throw new Error("Bitbucket Cloud uses https://bitbucket.org. For a company server, choose Bitbucket Data Center.");
  } else if (provider === "azure") {
    if (url.hostname.endsWith(".visualstudio.com")) {
      if (parts.length) throw new Error("Enter the Azure organization address without a project path.");
      parts = [url.hostname.slice(0, -".visualstudio.com".length)];
      url = new URL("https://dev.azure.com");
    }
    if (url.hostname === "dev.azure.com" && (parts.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parts[0]))) throw new Error("Use https://dev.azure.com/YOUR_ORGANIZATION, or the HTTPS collection address of your Azure DevOps Server.");
  }
  return url.origin + (parts.length ? "/" + encoded(parts) : "");
}

export function nativeRepository(provider: NativeHostingProvider, inputBase: string, remote: string, resolvedHost?: string): NativeRepository {
  const baseUrl = hostingBase(provider, inputBase), base = new URL(baseUrl);
  const scp = remote.match(/^(?:[^@/:\s]+@)?([^@/:\s]+):(.+)$/);
  let ssh: boolean, host: string, parts: string[];
  if (remote.includes("://")) {
    const url = new URL(remote);
    if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash) throw new Error("Use an HTTPS or SSH repository address without embedded secrets.");
    ssh = url.protocol === "ssh:";
    host = resolvedHost ?? url.hostname;
    if (!ssh && url.host !== base.host && !(provider === "azure" && url.hostname.endsWith(".visualstudio.com"))) throw new Error("The saved account belongs to a different service host. Choose the matching account in Share for review.");
    parts = segments(url.pathname);
  } else if (scp) { ssh = true; host = resolvedHost ?? scp[1]; parts = segments(scp[2]); }
  else throw new Error("Use an HTTPS or SSH repository address.");
  if(!parts.length)throw new Error('Choose a repository address, rather than only its host.');
  parts[parts.length - 1] = parts.at(-1)!.replace(/\.git$/i, "");
  let owner: string, name: string, project: string | undefined;
  let gitUrl: string, webUrl: string, apiUrl: string;
  if (provider === "bitbucket") {
    if (host !== "bitbucket.org" || parts.length !== 2) throw new Error("A Bitbucket Cloud address must name its workspace and repository.");
    [owner, name] = parts;
    webUrl = `${baseUrl}/${encoded(parts)}`; gitUrl = webUrl + ".git";
    apiUrl = `https://api.bitbucket.org/2.0/repositories/${encoded(parts)}`;
  } else if (provider === "bitbucket_dc") {
    if (host !== base.hostname) throw new Error("The SSH host and saved Bitbucket server differ. Use that server's HTTPS repository address or a matching SSH alias.");
    if (!ssh) {
      const prefix = [...segments(base.pathname), "scm"];
      if (parts.slice(0, prefix.length).join("/") !== prefix.join("/")) throw new Error("The repository address does not belong to this Bitbucket server path.");
      parts = parts.slice(prefix.length);
    }
    if (parts.length !== 2 || !parts.every(p => /^~?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p))) throw new Error("Use a Bitbucket project/repository address.");
    [owner, name] = parts;
    gitUrl = `${baseUrl}/scm/${encoded(parts)}.git`;
    webUrl = `${baseUrl}/projects/${encodeURIComponent(owner)}/repos/${encodeURIComponent(name)}`;
    apiUrl = `${baseUrl}/rest/api/latest/projects/${encodeURIComponent(owner)}/repos/${encodeURIComponent(name)}`;
  } else {
    const baseParts = segments(base.pathname);
    if (ssh) {
      if (host !== "ssh.dev.azure.com" || base.hostname !== "dev.azure.com" || parts.length !== 4 || parts[0] !== "v3" || parts[1].toLowerCase() !== baseParts[0].toLowerCase()) throw new Error("Use the SSH address for this Azure organization, or its HTTPS repository address.");
      parts = [parts[2], "_git", parts[3]];
    } else if (host.endsWith(".visualstudio.com")) {
      if (base.hostname !== "dev.azure.com" || host.slice(0, -".visualstudio.com".length).toLowerCase() !== baseParts[0].toLowerCase()) throw new Error("Choose the account for this Azure organization.");
      if (parts[0] === "DefaultCollection") parts.shift();
    } else {
      if (host !== base.hostname || parts.slice(0, baseParts.length).join("/").toLowerCase() !== baseParts.join("/").toLowerCase()) throw new Error("The repository is outside the saved Azure organization or collection.");
      parts = parts.slice(baseParts.length);
    }
    if (parts.length !== 3 || parts[1] !== "_git") throw new Error("An Azure Repos address must include PROJECT/_git/REPOSITORY.");
    [project, , name] = parts; owner = [...baseParts, project].join("/");
    webUrl = `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`; gitUrl = webUrl;
    apiUrl = `${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(name)}`;
  }
  if (!name) throw new Error("Choose a repository name.");
  return { provider, baseUrl, gitUrl, webUrl, apiUrl, repository: `${owner}/${name}`, owner, name, ...(project ? { project } : {}) };
}

export function inferHostingBase(provider: NativeHostingProvider, remote: string): string | undefined {
  try {
    if (provider === "bitbucket") return "https://bitbucket.org";
    if (provider === "azure") {
      const scp = remote.match(/^(?:git@)?ssh\.dev\.azure\.com:v3\/([^/]+)\//);
      if (scp) return hostingBase(provider, `https://dev.azure.com/${scp[1]}`);
      const url = new URL(remote);
      if (url.hostname === "dev.azure.com") return hostingBase(provider, `${url.origin}/${segments(url.pathname)[0]}`);
      if (url.hostname.endsWith(".visualstudio.com")) return hostingBase(provider, url.origin);
      if (url.protocol === "https:") { const index = url.pathname.indexOf("/_git/"); if (index > 0) { const prefix = url.pathname.slice(0,index).split("/");prefix.pop();return hostingBase(provider,url.origin+prefix.join("/")); } }
    }
    if (provider === "bitbucket_dc") { const url = new URL(remote);const index=url.pathname.indexOf("/scm/");if(url.protocol==='https:'&&index>=0)return hostingBase(provider,url.origin+url.pathname.slice(0,index)); }
  } catch { /* The user can choose the exact service address in Settings. */ }
  return undefined;
}

export function nativeCreationLocation(provider:NativeHostingProvider,inputBase:string,owner:string,name:string):NativeRepository {
  const baseUrl=hostingBase(provider,inputBase),url=new URL(baseUrl);let gitUrl:string;
  cleanSegment(name);
  if(provider==='azure'){
    const prefix=segments(url.pathname).join('/');
    if(prefix&&!owner.startsWith(prefix+'/'))throw new Error('For Azure, include the organization or collection and project in the owner path.');
    const project=prefix?owner.slice(prefix.length+1):owner;cleanSegment(project);
    gitUrl=`${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`;
  }else{
    cleanSegment(owner);
    gitUrl=provider==='bitbucket'?`${baseUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`:`${baseUrl}/scm/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
  }
  return nativeRepository(provider,baseUrl,gitUrl);
}
