import { createHash, randomUUID } from "node:crypto";
import type { Locale, PlanStep, PushDestination, RepoSnapshot } from "../shared/types.js";
import { isBranchNameSafe } from "./branch-operation.js";
import { localized } from "./i18n.js";
import { displayUrl } from "./readiness.js";
import { redactText } from "./outbound-content.js";
import { remoteNamePattern } from "./repository-plan.js";

type ReadGit = (args: string[]) => Promise<{ code: number; stdout: string }>;
const valueOptions = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
const gitGlobalValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--list-cmds"]);
const commitHashPattern = /^[0-9a-f]{40,64}$/;

export type PushOperation =
  | { kind: "default"; noVerify: boolean }
  | { kind: "set_upstream"; remote: string; branch: string; noVerify: boolean }
  | { kind: "branch"; remote: string; branch: string; noVerify: boolean }
  | { kind: "refspec"; remote: string; commit: string; branch: string; noVerify: false };

export function parsePushOperation(args: Record<string, string>, locale: Locale = "es"): PushOperation {
  if (args.noVerify !== undefined && args.noVerify !== "" && args.noVerify !== "true") {
    throw new Error(localized(locale, "Los argumentos de publicación no son válidos.", "The push arguments are invalid."));
  }
  const noVerify = args.noVerify === "true";
  const hasSetUpstream = args.setUpstream !== undefined;
  const hasRemote = args.remote !== undefined;
  const hasCommit = args.commit !== undefined;
  if (hasSetUpstream && hasRemote) {
    throw new Error(localized(locale, "Los argumentos de publicación no son válidos.", "The push arguments are invalid."));
  }
  if (hasCommit) {
    if (hasSetUpstream || noVerify || !hasRemote || !commitHashPattern.test(args.commit)) {
      throw new Error(localized(locale, "Los argumentos de publicación no son válidos.", "The push arguments are invalid."));
    }
    if (!remoteNamePattern.test(args.remote)) {
      throw new Error(localized(locale, `El remoto ${args.remote} no existe en este repositorio.`, `Remote ${args.remote} does not exist in this repository.`));
    }
    if (!isBranchNameSafe(args.branch)) {
      throw new Error(localized(locale, "Nombre de rama no válido.", "Invalid branch name."));
    }
    return { kind: "refspec", remote: args.remote, commit: args.commit, branch: args.branch, noVerify: false };
  }
  if (hasSetUpstream || hasRemote) {
    const remote = hasSetUpstream ? args.setUpstream : args.remote;
    if (!remoteNamePattern.test(remote)) {
      throw new Error(localized(locale, `El remoto ${remote} no existe en este repositorio.`, `Remote ${remote} does not exist in this repository.`));
    }
    if (!isBranchNameSafe(args.branch)) {
      throw new Error(localized(locale, "Solo se puede publicar la rama activa, y no es la que nombra este plan.", "Only the active branch can be published, and it is not the one this plan names."));
    }
    return hasSetUpstream
      ? { kind: "set_upstream", remote, branch: args.branch, noVerify }
      : { kind: "branch", remote, branch: args.branch, noVerify };
  }
  if (args.branch !== undefined && args.branch !== "") {
    throw new Error(localized(locale, "Los argumentos de publicación no son válidos.", "The push arguments are invalid."));
  }
  return { kind: "default", noVerify };
}

export function pushArguments(push: PushOperation): string[] {
  switch (push.kind) {
    case "default":
      return ["push", ...(push.noVerify ? ["--no-verify"] : [])];
    case "set_upstream":
      return ["push", ...(push.noVerify ? ["--no-verify"] : []), "--set-upstream", push.remote, push.branch];
    case "branch":
      return ["push", ...(push.noVerify ? ["--no-verify"] : []), push.remote, push.branch];
    case "refspec":
      return ["push", push.remote, `${push.commit}:refs/heads/${push.branch}`];
  }
}

export function validatePushOperation(
  push: PushOperation,
  snapshot: Pick<RepoSnapshot, "remotes" | "currentBranch">,
  locale: Locale = "es"
) {
  if (push.kind === "default") return;
  if (!snapshot.remotes.includes(push.remote)) {
    throw new Error(localized(locale, `El remoto ${push.remote} no existe en este repositorio.`, `Remote ${push.remote} does not exist in this repository.`));
  }
  if (push.kind === "refspec") return;
  if (snapshot.currentBranch === "HEAD" || push.branch !== snapshot.currentBranch) {
    throw new Error(localized(locale, "Solo se puede publicar la rama activa, y no es la que nombra este plan.", "Only the active branch can be published, and it is not the one this plan names."));
  }
}

function pushCommandArgs(argv: string[]): string[] | undefined {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") return undefined;
    if (gitGlobalValueOptions.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token === "push" ? argv.slice(index + 1) : undefined;
  }
  return undefined;
}

/** A null target tells Git to choose its default. Undefined means this is another operation. */
export function pushRepository(step: PlanStep): string | null | undefined {
  if (step.operation === "push") {
    const push = parsePushOperation(step.args, "en");
    return push.kind === "default" ? null : push.remote;
  }
  if (step.operation !== "git_command" || !step.argv?.length) return undefined;
  const args = pushCommandArgs(step.argv);
  if (!args) return undefined;
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
