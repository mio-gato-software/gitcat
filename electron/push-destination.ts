import { createHash, randomUUID } from "node:crypto";
import type { PlanStep, PushDestination, RepoSnapshot } from "../shared/types.js";
import { displayUrl } from "./readiness.js";
import { redactText } from "./outbound-content.js";

type ReadGit = (args: string[]) => Promise<{ code: number; stdout: string }>;
const valueOptions = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);

export function pushArguments(args: Record<string, string>) {
  const remote = args.setUpstream || args.remote;
  return ["push", ...(args.noVerify === "true" ? ["--no-verify"] : []),
    ...(args.setUpstream ? ["--set-upstream"] : []), ...(remote ? [remote, args.branch] : [])];
}

/** A null target tells Git to choose its default. Undefined means this is another operation. */
export function pushRepository(step: PlanStep): string | null | undefined {
  if (step.operation === "push") return step.args.setUpstream || step.args.remote || null;
  if (step.operation !== "git_command" || step.argv?.[0] !== "push") return undefined;
  const args = step.argv.slice(1);
  let repository: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--") return args[index + 1] ?? repository;
    if (valueOptions.has(token)) {
      if (token === "--repo") repository = args[index + 1] ?? null;
      index++;
    } else if (token.startsWith("--repo=")) repository = token.slice("--repo=".length);
    else if (!token.startsWith("-")) return token;
  }
  return repository;
}

export function displayPushAddress(address: string) {
  // Credentials may be in user info or a query. The unredacted value only enters the binding.
  const display = displayUrl(address).replace(/^([a-z][a-z+.-]*:\/\/)[^/@]*@/i, "$1");
  return redactText(display.includes("://") ? display.split(/[?#]/, 1)[0] : display).text;
}

export async function readPushDestination(
  read: ReadGit,
  snapshot: Pick<RepoSnapshot, "remotes" | "currentBranch">,
  target: string | null
): Promise<PushDestination> {
  const config = await read(["config", "--null", "--get-regexp", "^(branch\\.|remote\\.|push\\.)"]);
  if (config.code !== 0 && config.code !== 1) throw new Error("Git could not read the publishing configuration.");
  const settings = new Map<string, string[]>();
  for (const entry of config.stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    settings.set(key, [...(settings.get(key) ?? []), value]);
  }
  const branch = `branch.${snapshot.currentBranch}.`;
  const last = (key: string) => settings.get(key)?.at(-1);
  const chosen = target ?? (last(branch + "pushremote") || last("remote.pushdefault") || last(branch + "remote")
    || (snapshot.remotes.length === 1 ? snapshot.remotes[0] : snapshot.remotes.find(name => name === "origin")));
  const remote = chosen && snapshot.remotes.includes(chosen) ? chosen : undefined;
  let urls: string[] = [];
  if (chosen) {
    // Let Git resolve URL rewrites for both named remotes and explicit addresses without connecting.
    const temporary = `gitcat-url-${randomUUID()}`;
    const args = remote ? [] : ["-c", `remote.${temporary}.url=${chosen}`];
    const result = await read([...args, "remote", "get-url", "--push", "--all", "--", remote ?? temporary]);
    if (result.code !== 0) throw new Error("Git could not verify the publishing destination.");
    urls = result.stdout.trimEnd().split("\n").filter(Boolean);
    if (!urls.length) throw new Error("Git returned an empty publishing destination.");
  }
  const routing = [...settings].filter(([key]) => key.startsWith("push.") || key === branch + "merge"
    || (remote && [`remote.${remote}.push`, `remote.${remote}.mirror`].includes(key)));
  const binding = createHash("sha256").update(JSON.stringify([snapshot.currentBranch, chosen, urls, routing])).digest("hex");
  return { binding, remote, urls: urls.map(displayPushAddress) };
}
