import type { HostingProvider } from "./types.js";

export const hostingProviders: HostingProvider[] = ["github", "gitlab", "bitbucket", "bitbucket_dc", "azure"];
export const hostingLabels: Record<HostingProvider, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket Cloud", bitbucket_dc: "Bitbucket Data Center", azure: "Azure DevOps" };
export function isNativeProvider(provider: HostingProvider): provider is "bitbucket" | "bitbucket_dc" | "azure" { return provider !== "github" && provider !== "gitlab"; }

/** A company domain needs an explicit choice; a name containing "gitlab" proves nothing. */
export function hostingProvider(host: string | undefined, requested?: HostingProvider): HostingProvider | undefined {
  const known = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : host === "dev.azure.com" || host === "ssh.dev.azure.com" || host?.endsWith(".visualstudio.com") ? "azure" : undefined;
  if (requested !== undefined && !hostingProviders.includes(requested)) throw new Error("Choose GitHub or GitLab, Bitbucket, or Azure DevOps as the hosting service.");
  if (known && requested && known !== requested) throw new Error(`The selected service does not match ${host}.`);
  return known ?? requested;
}

export function validHostingHost(host: string): boolean {
  try {
    return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host)
      && !host.includes("..") && new URL(`https://${host}`).host === host;
  } catch { return false; }
}

export function validHostingRepository(path: string, provider: HostingProvider): boolean {
  const parts = path.split("/");
  if (provider === "azure") return parts.length >= 2 && parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(p) && p !== "." && p !== "..");
  if (provider === "bitbucket_dc") return parts.length === 2 && parts.every(p => /^~?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && p !== "." && p !== "..");
  return parts.length >= 2 && (provider === "gitlab" || parts.length === 2)
    && parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && p !== "." && p !== ".." && !p.endsWith(".git"));
}
