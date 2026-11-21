import type { Locale, RepoSnapshot } from "../shared/types.js";
import { isProtectedBranch } from "../shared/branch-lifecycle.js";
import { assistantQueryArguments, parseAssistantCommand } from "./assistant-git-command.js";
import { localized } from "./i18n.js";

export const assistantReadKinds = ["repository", "compare_branches", "commit", "git"] as const;
export type PlannedRead = { kind: typeof assistantReadKinds[number]; args: string[] };

const repositoryFacts = ["active_branch", "primary_branch", "working_tree", "remotes", "deletable_branches"] as const;
type RepositoryFact = typeof repositoryFacts[number];
export type AssistantRead =
  | { kind: "repository"; facts: RepositoryFact[] }
  | { kind: "compare_branches"; target: string; source?: string }
  | { kind: "commit"; selector: "tip" | "latest_merge"; ref: string }
  | { kind: "git"; argv: string[] };

type GitReading = { code: number; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean };
export type ReadGitFacts = (args: string[]) => Promise<GitReading>;

export function parseAssistantRead({ kind, args }: PlannedRead): AssistantRead | undefined {
  if (!args.length || args.some(arg => !arg.trim() || arg.includes("\0"))) return;
  const [first, second] = args;
  const ref = (value: string) => !value.startsWith("-") && !/[\s\p{Cc}]/u.test(value);
  switch (kind) {
    case "repository":
      if (args.every((arg): arg is RepositoryFact => repositoryFacts.some(fact => fact === arg))) {
        return { kind, facts: [...new Set(args)] };
      }
      return;
    case "compare_branches":
      if (args.length <= 2 && args.every(ref)) return { kind, target: first, source: second };
      return;
    case "commit":
      if (args.length <= 2 && (first === "tip" || first === "latest_merge") && (second === undefined || ref(second))) {
        return { kind, selector: first, ref: second ?? "HEAD" };
      }
      return;
    case "git": {
      const command = parseAssistantCommand(args);
      if (command?.operation === "git_command") return { kind, argv: command.argv };
    }
  }
}

export function describeRepositoryFacts(snapshot: RepoSnapshot, facts: RepositoryFact[], locale: Locale) {
  return facts.map(fact => {
    switch (fact) {
      case "active_branch":
        return snapshot.currentBranch === "HEAD"
          ? localized(locale, `Estás en el commit ${snapshot.head.slice(0, 10)}, sin una rama activa.`, `You are on commit ${snapshot.head.slice(0, 10)}, with no active branch.`)
          : localized(locale, `La rama activa es ${snapshot.currentBranch}.`, `The active branch is ${snapshot.currentBranch}.`);
      case "primary_branch":
        if (!snapshot.defaultBranch) return localized(locale, "GitCat no pudo identificar una rama principal.", "GitCat could not identify a primary branch.");
        return snapshot.defaultBranchSource === "remote_head"
          ? localized(locale, `El remoto indica que la rama principal es ${snapshot.defaultBranch}.`, `The remote identifies ${snapshot.defaultBranch} as the primary branch.`)
          : localized(locale, `GitCat identifica ${snapshot.defaultBranch} como rama principal por convención local.`, `By local convention, GitCat identifies ${snapshot.defaultBranch} as the primary branch.`);
      case "working_tree":
        if (!snapshot.isDirty) return localized(locale, "Git no detectó cambios sin guardar.", "Git found no uncommitted changes.");
        return [
          localized(locale, `Archivos con cambios sin guardar (${snapshot.changes.length})`, `Files with uncommitted changes (${snapshot.changes.length})`),
          ...snapshot.changes.slice(0, 30).map(change => `• ${change.from ? `${change.from} → ` : ""}${change.path} (${change.xy?.trim() || change.code})`),
          ...(snapshot.changes.length > 30 ? [localized(locale, "Se muestran los primeros 30.", "Showing the first 30.")] : [])
        ].join("\n");
      case "remotes":
        return snapshot.remotes.length
          ? localized(locale, `Remotos configurados: ${snapshot.remotes.join(", ")}.`, `Configured remotes: ${snapshot.remotes.join(", ")}.`)
          : localized(locale, "El repositorio no tiene remotos configurados.", "The repository has no configured remotes.");
      case "deletable_branches": {
        const target = snapshot.defaultBranch;
        if (!target) return localized(locale, "Hace falta identificar la rama principal para comprobar qué ramas están integradas.", "A primary branch is needed to check which branches are integrated.");
        const candidates = snapshot.branches.filter(branch => branch.presence !== "remote" && branch.name !== target
          && !branch.isCurrent && !branch.checkedOutIn && !isProtectedBranch(branch.name) && branch.mergedInto.includes(target));
        return candidates.length
          ? localized(locale, `Ramas candidatas a eliminar cuyo historial está en ${target}:\n${candidates.map(branch => `• ${branch.name}`).join("\n")}`,
            `Candidate branches to delete whose history is in ${target}:\n${candidates.map(branch => `• ${branch.name}`).join("\n")}`)
          : localized(locale, `No hay ramas candidatas a eliminar según el historial de ${target}.`, `There are no candidate branches to delete based on the history of ${target}.`);
      }
    }
  }).join("\n\n");
}

type BranchTip = { ref: string; hash: string; tree: string };
type BranchComparison =
  | { kind: "contained" | "same_tree" | "unavailable" | "shallow" }
  | { kind: "patches"; equivalent: number; unmatched: number; merges: number };
const branchComparisonLimit = 24;
const objectHash = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function complete(result: GitReading) {
  return result.code === 0 && !result.stdoutTruncated && !result.stderrTruncated;
}

async function compareOne(read: ReadGitFacts, target: BranchTip, source: BranchTip, shallow: boolean): Promise<BranchComparison> {
  if (target.hash === source.hash) return { kind: "contained" };
  const ancestry = await read(["merge-base", "--is-ancestor", source.hash, target.hash]);
  if (complete(ancestry)) return { kind: "contained" };
  if (target.tree === source.tree) return { kind: "same_tree" };
  if (ancestry.code !== 1 || ancestry.stderr) return { kind: "unavailable" };
  if (shallow) return { kind: "shallow" };
  const range = `${target.hash}..${source.hash}`;
  const [patches, merges] = await Promise.all([
    read(["cherry", target.hash, source.hash]),
    read(["rev-list", "--count", "--merges", range, "--"])
  ]);
  if (!complete(patches) || !complete(merges) || !/^\d+$/.test(merges.stdout.trim())) return { kind: "unavailable" };
  const rows = patches.stdout.trim().split("\n").filter(Boolean);
  if (!rows.every(row => /^[+-] [a-f0-9]+$/.test(row))) return { kind: "unavailable" };
  const equivalent = rows.filter(row => row.startsWith("-")).length;
  return { kind: "patches", equivalent, unmatched: rows.length - equivalent, merges: Number(merges.stdout.trim()) };
}

function describeComparison(result: BranchComparison, locale: Locale) {
  switch (result.kind) {
    case "contained":
      return localized(locale, "La rama de destino ya contiene este historial.", "The target branch already contains this history.");
    case "same_tree":
      return localized(locale, "Los archivos de ambas puntas son idénticos. No quedan cambios de contenido por integrar.", "The two tips have identical files. There are no content changes left to integrate.");
    case "shallow":
      return localized(locale, "Los archivos difieren y el historial local es parcial. No alcanza para comprobar qué cambios faltan.", "The files differ and the local history is shallow. It cannot establish which changes are missing.");
    case "unavailable":
      return localized(locale, "Git no pudo completar la comparación.", "Git could not complete the comparison.");
    case "patches": {
      const { equivalent, unmatched, merges } = result;
      if (equivalent && !unmatched && !merges) {
        return localized(locale, "Git encontró parches equivalentes en el historial de destino. Las versiones actuales de los archivos difieren.",
          "Git found equivalent patches in the target history. The current versions of the files differ.");
      }
      return localized(locale, `Parches sin equivalente individual: ${unmatched}. Parches equivalentes: ${equivalent}. Merges fuera del historial de destino: ${merges}.`,
        `Patches without an individual match: ${unmatched}. Equivalent patches: ${equivalent}. Merges outside the target history: ${merges}.`);
    }
  }
}

export async function inspectBranches(read: ReadGitFacts, targetName: string, sourceName: string | undefined, locale: Locale) {
  const [listed, shallow] = await Promise.all([
    read(["for-each-ref", "--format=%(refname) %(objectname) %(tree) %(symref)", "refs/heads", "refs/remotes"]),
    read(["rev-parse", "--is-shallow-repository"])
  ]);
  if (!complete(listed) || !complete(shallow)) {
    return localized(locale, "Git no pudo leer todas las referencias o comprobar el historial local.", "Git could not read all refs or verify the local history.");
  }
  const refs = new Map<string, BranchTip>();
  for (const line of listed.stdout.split("\n")) {
    const [ref, hash, tree, symbolic] = line.trim().split(" ");
    if (ref && objectHash.test(hash) && objectHash.test(tree) && !symbolic) refs.set(ref, { ref, hash, tree });
  }
  const resolve = (name: string) => refs.get(name) ?? refs.get(`refs/heads/${name}`) ?? refs.get(`refs/remotes/${name}`);
  const target = resolve(targetName);
  const source = sourceName === undefined ? undefined : resolve(sourceName);
  const missing = !target ? targetName : !source ? sourceName : undefined;
  if (missing !== undefined || !target) return localized(locale, `Git no encontró la rama ${missing} en las referencias locales.`, `Git could not find branch ${missing} in the local refs.`);
  const candidates = source ? [source] : [...refs.values()].filter(tip => tip.ref.startsWith("refs/heads/") && tip.ref !== target.ref);
  const reachable = source ? undefined : await read([
    "for-each-ref", "--merged", target.hash, "--format=%(objectname)", "refs/heads"
  ]);
  const contained = new Set(reachable && complete(reachable) ? reachable.stdout.trim().split("\n") : []);
  const comparisons = new Map<string, BranchComparison>();
  const unknown: BranchTip[] = [];
  for (const tip of candidates) {
    if (tip.hash === target.hash || contained.has(tip.hash)) comparisons.set(tip.ref, { kind: "contained" });
    else if (!source && tip.tree === target.tree) comparisons.set(tip.ref, { kind: "same_tree" });
    else unknown.push(tip);
  }
  const selected = unknown.slice(0, branchComparisonLimit);
  for (let start = 0; start < selected.length; start += 4) {
    await Promise.all(selected.slice(start, start + 4).map(async tip => {
      comparisons.set(tip.ref, await compareOne(read, target, tip, shallow.stdout.trim() === "true"));
    }));
  }
  const rows = candidates.flatMap(tip => {
    const result = comparisons.get(tip.ref);
    return result ? [`• ${tip.ref.replace(/^refs\/(?:heads|remotes)\//, "")} — ${describeComparison(result, locale)}`] : [];
  });
  const heading = localized(locale, `Comparación con ${targetName} según las referencias locales`, `Comparison with ${targetName} using local refs`);
  if (!rows.length) rows.push(localized(locale, "No hay otras ramas locales para comparar.", "There are no other local branches to compare."));
  if (unknown.length > selected.length) {
    const omitted = unknown.length - selected.length;
    rows.push(localized(locale, `Ramas que faltan por comprobar: ${omitted}. Puedes consultar una rama concreta.`, `Branches still to check: ${omitted}. You can ask about a specific branch.`));
  }
  if ([...comparisons.values()].some(result => result.kind === "patches" && (result.unmatched > 0 || result.merges > 0))) {
    rows.push(localized(locale, "La comparación de parches individuales puede pasar por alto cambios combinados en un squash.",
      "Comparing individual patches can miss changes combined in a squash."));
  }
  return [heading, ...rows].join("\n");
}

export async function inspectGit(read: ReadGitFacts, argv: string[], locale: Locale) {
  const result = await read(assistantQueryArguments(argv));
  const [verb, ...args] = argv;
  const diffStatus = verb === "diff" && (args.includes("--exit-code") || args.includes("--quiet"));
  const validExitOne = result.code === 1 && !result.stderr.trim() && (diffStatus || verb === "grep");
  const ok = result.code === 0 || validExitOne;
  const stdout = result.stdout.trim();
  const cut = result.stdoutTruncated || result.stderrTruncated || stdout.length > 8000 || result.stderr.length > 1000;
  if (ok && !cut && !result.stderr.trim() && verb === "rev-list" && args.length === 2 && args[0] === "--count"
      && !args[1].startsWith("-") && /^\d+$/.test(stdout)) {
    return localized(locale, `Conteo de commits para ${args[1]}: ${stdout}.`, `Commit count for ${args[1]}: ${stdout}.`);
  }
  const label = ["git", ...argv.map(arg => /[\s\p{Cc}]/u.test(arg) ? JSON.stringify(arg) : arg)].join(" ");
  const outcome = !ok
    ? localized(locale, "Git no pudo completar esta lectura.", "Git could not complete this read.")
    : diffStatus && !stdout
      ? validExitOne
        ? localized(locale, "Git encontró diferencias.", "Git found differences.")
        : localized(locale, "Git no encontró diferencias.", "Git found no differences.")
      : !stdout ? localized(locale, "La consulta no devolvió resultados.", "The query returned no results.") : "";
  return [label, outcome, stdout.slice(0, 8000), result.stderr.trim().slice(0, 1000),
    cut ? localized(locale, "Resultado recortado.", "Output shortened.") : ""].filter(Boolean).join("\n");
}
