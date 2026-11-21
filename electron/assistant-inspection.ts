import type { FileChange, Locale, RepoSnapshot } from "../shared/types.js";
import { isProtectedBranch } from "../shared/branch-lifecycle.js";
import { isUntracked } from "../shared/selected-changes.js";
import { assistantQueryArguments, parseAssistantCommand } from "./assistant-git-command.js";
import { localized } from "./i18n.js";
import { redactText } from "./outbound-content.js";
import { displayUrl } from "./readiness.js";

export const assistantReadKinds = ["repository", "compare_branches", "commit", "file_history", "git"] as const;
export type PlannedRead = { kind: typeof assistantReadKinds[number]; args: string[] };

const repositoryFacts = ["active_branch", "primary_branch", "working_tree", "remotes", "upstream", "deletable_branches"] as const;
type RepositoryFact = typeof repositoryFacts[number];
const historyEvents = ["first_addition", "latest_change", "latest_deletion"] as const;
type FileHistoryEvent = typeof historyEvents[number];
export type AssistantRead =
  | { kind: "repository"; facts: RepositoryFact[] }
  | { kind: "compare_branches"; target: string; source?: string }
  | { kind: "commit"; selector: "tip" | "latest_merge"; ref: string }
  | { kind: "file_history"; event: FileHistoryEvent; path: string; ref: string }
  | { kind: "git"; argv: string[] };
export type AssistantFinding = { text: string; details?: string };

type GitReading = { code: number; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean };
export type ReadGitFacts = (args: string[]) => Promise<GitReading>;

export function parseAssistantRead({ kind, args }: PlannedRead): AssistantRead | undefined {
  if (!args.length || args.some(arg => !arg.trim() || arg.includes("\0"))) return;
  const [first, second, third] = args;
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
    case "file_history": {
      const event = historyEvents.find(value => value === first);
      if (event && second && args.length <= 3 && (third === undefined || ref(third)) &&
          parseAssistantCommand(["log", "--", second])?.operation === "git_command") {
        return { kind, event, path: second, ref: third ?? "HEAD" };
      }
      return;
    }
    case "git": {
      const command = parseAssistantCommand(args);
      if (command?.operation === "git_command") return { kind, argv: command.argv };
    }
  }
}

function describeWorkingTree(snapshot: RepoSnapshot, locale: Locale) {
  if (!snapshot.isDirty) return localized(locale, "No tienes cambios sin guardar.", "You have no uncommitted changes.");
  const conflictPaths = new Set(snapshot.conflicts.map(item => item.path));
  const prepared: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: FileChange[] = [];
  const conflicting: FileChange[] = [];
  const other: FileChange[] = [];
  for (const change of snapshot.changes) {
    if (conflictPaths.has(change.path)) conflicting.push(change);
    else if (isUntracked(change)) untracked.push(change);
    else if (change.xy?.length === 2) {
      if (change.xy[0] !== " ") prepared.push(change);
      if (change.xy[1] !== " ") unstaged.push(change);
    } else other.push(change);
  }
  const groups: [FileChange[], string][] = [
    [prepared, localized(locale, "Preparados para el próximo commit", "Ready for the next commit")],
    [unstaged, localized(locale, "Con cambios que aún no están preparados", "With changes that aren't staged")],
    [untracked, localized(locale, "Archivos nuevos que Git aún no sigue", "New files Git doesn't track yet")],
    [conflicting, localized(locale, "Conflictos por resolver", "Conflicts to resolve")],
    [other, localized(locale, "Otros cambios", "Other changes")]
  ];
  return groups.filter(([files]) => files.length).map(([files, label]) => {
    const listed = files.slice(0, 8).map(file => file.from ? `${file.from} → ${file.path}` : file.path).join(", ");
    const remaining = files.length > 8 ? localized(locale, ` y ${files.length - 8} más`, ` and ${files.length - 8} more`) : "";
    return `${label} (${files.length})\n${listed}${remaining}`;
  }).join("\n\n");
}

async function describeRemotes(read: ReadGitFacts, names: string[], locale: Locale) {
  if (!names.length) return localized(locale, "Este repositorio no tiene remotos configurados.", "This repository has no configured remotes.");
  return (await Promise.all(names.map(async name => {
    const [fetch, push] = await Promise.all([
      read(["remote", "get-url", "--all", "--", name]),
      read(["remote", "get-url", "--push", "--all", "--", name])
    ]);
    const display = (result: GitReading) => complete(result) && result.stdout.trim() ?
      result.stdout.trim().split("\n").map(url => redactText(displayUrl(url)).text).join(", ")
      : localized(locale, "Git no pudo comprobar la dirección.", "Git could not verify the address.");
    const fetchUrl = display(fetch);
    const pushUrl = display(push);
    return complete(fetch) && complete(push) && fetch.stdout.trim() && fetch.stdout.trim() === push.stdout.trim()
      ? localized(locale, `Traes y publicas cambios en ${name} con la misma dirección: ${fetchUrl}`, `You fetch and push to ${name} at the same address: ${fetchUrl}`)
      : localized(locale, `Para traer cambios de ${name}: ${fetchUrl}\nPara publicar en ${name}: ${pushUrl}`, `To fetch from ${name}: ${fetchUrl}\nTo push to ${name}: ${pushUrl}`);
  }))).join("\n\n");
}

export async function describeRepositoryFacts(read: ReadGitFacts, snapshot: RepoSnapshot, facts: RepositoryFact[], locale: Locale): Promise<AssistantFinding> {
  const sections = await Promise.all(facts.map(async fact => {
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
        return describeWorkingTree(snapshot, locale);
      case "remotes":
        return describeRemotes(read, snapshot.remotes, locale);
      case "upstream": {
        const branch = snapshot.branches.find(value => value.isCurrent);
        if (!branch) return localized(locale, "No hay una rama activa para comprobar qué referencia sigue.", "There is no active branch to check for an upstream.");
        if (!branch.upstream) return localized(locale, `${branch.name} no tiene una rama de seguimiento configurada.`, `${branch.name} has no upstream branch configured.`);
        const comparison = await read(["rev-list", "--left-right", "--count", `${snapshot.head}...${branch.name}@{upstream}`, "--"]);
        const counts = complete(comparison) ? comparison.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
        return counts
          ? localized(locale, `${branch.name} sigue a ${branch.upstream}. Según la referencia local, hay ${counts[1]} commits por enviar y ${counts[2]} por traer.`,
            `${branch.name} tracks ${branch.upstream}. The local tracking ref shows ${counts[1]} commits ahead and ${counts[2]} behind.`)
          : localized(locale, `${branch.name} sigue a ${branch.upstream}, pero Git no pudo comparar las referencias locales.`,
            `${branch.name} tracks ${branch.upstream}, but Git could not compare the local refs.`);
      }
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
  }));
  return { text: sections.join("\n\n") };
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

export async function inspectBranches(read: ReadGitFacts, targetName: string, sourceName: string | undefined, locale: Locale): Promise<AssistantFinding> {
  const [listed, shallow] = await Promise.all([
    read(["for-each-ref", "--format=%(refname) %(objectname) %(tree) %(symref)", "refs/heads", "refs/remotes"]),
    read(["rev-parse", "--is-shallow-repository"])
  ]);
  if (!complete(listed) || !complete(shallow)) {
    return { text: localized(locale, "Git no pudo leer todas las referencias o comprobar el historial local.", "Git could not read all refs or verify the local history.") };
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
  if (missing !== undefined || !target) return { text: localized(locale, `Git no encontró la rama ${missing} en las referencias locales.`, `Git could not find branch ${missing} in the local refs.`) };
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
  if (!candidates.length) return { text: localized(locale, `No hay otras ramas locales para comparar con ${targetName}.`, `There are no other local branches to compare with ${targetName}.`) };
  const omitted = unknown.length - selected.length;
  if (unknown.length > selected.length) {
    rows.push(localized(locale, `Ramas que faltan por comprobar: ${omitted}. Puedes consultar una rama concreta.`, `Branches still to check: ${omitted}. You can ask about a specific branch.`));
  }
  if ([...comparisons.values()].some(result => result.kind === "patches" && (result.unmatched > 0 || result.merges > 0))) {
    rows.push(localized(locale, "La comparación de parches individuales puede pasar por alto cambios combinados en un squash.",
      "Comparing individual patches can miss changes combined in a squash."));
  }
  const details = [heading, ...rows].join("\n");
  if (candidates.length === 1) {
    const tip = candidates[0];
    const name = tip.ref.replace(/^refs\/(?:heads|remotes)\//, "");
    const result = comparisons.get(tip.ref)!;
    const text = result.kind === "contained"
      ? localized(locale, `${targetName} ya contiene el historial de ${name}. No queda nada por fusionar de esa rama.`,
        `${targetName} already contains the history of ${name}. There is nothing left to merge from that branch.`)
      : result.kind === "same_tree"
        ? localized(locale, `No quedan cambios de contenido de ${name} por integrar en ${targetName}. Las dos ramas tienen exactamente los mismos archivos.`,
          `There are no content changes from ${name} left to integrate into ${targetName}. Both branches have exactly the same files.`)
        : `${name} → ${targetName}. ${describeComparison(result, locale)}`;
    return { text, details };
  }
  const confirmed = [...comparisons.values()].filter(result => result.kind === "contained" || result.kind === "same_tree").length;
  const review = candidates.filter(tip => {
    const outcome = comparisons.get(tip.ref)?.kind;
    return outcome && outcome !== "contained" && outcome !== "same_tree";
  });
  const first = localized(locale, `${confirmed} de ${candidates.length} ramas locales ya están en el historial de ${targetName} o tienen los mismos archivos.`,
    `${confirmed} of ${candidates.length} local branches are already in ${targetName}'s history or have the same files.`);
  const reviewNames = review.slice(0, 5).map(tip => tip.ref.replace(/^refs\/heads\//, "")).join(", ");
  const rest = review.length ? localized(locale, `Conviene revisar ${reviewNames}${review.length > 5 ? ` y ${review.length - 5} más` : ""} para saber si quedan cambios por integrar.`,
    `To check what still needs to be integrated, review ${reviewNames}${review.length > 5 ? ` and ${review.length - 5} more` : ""}.`) : "";
  const incomplete = omitted ? localized(locale, `Quedaron ${omitted} sin comprobar.`, `${omitted} remain unchecked.`) : "";
  return { text: [first, rest, incomplete].filter(Boolean).join(" "), details };
}

function historyLimit(shallow: boolean | undefined, locale: Locale) {
  return shallow ? localized(locale, "Esta copia tiene historial superficial. Git solo puede contar o buscar en la parte disponible.",
    "This is a shallow copy. Git can only count or search the available history.") : "";
}

export async function inspectFileHistory(
  read: ReadGitFacts, query: Extract<AssistantRead, { kind: "file_history" }>, snapshot: RepoSnapshot, locale: Locale
): Promise<AssistantFinding> {
  const { event, path, ref } = query;
  const limit = historyLimit(snapshot.isShallow, locale);
  if (limit && event === "first_addition") return { text: localized(locale,
    `No puedo comprobar cuándo apareció por primera vez ${path}. ${limit}`,
    `I can't verify when ${path} first appeared. ${limit}`) };
  const tip = ref === "HEAD" ? snapshot.head : (await read(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
  if (!objectHash.test(tip)) return { text: localized(locale, `Git no encontró un commit para ${ref}.`, `Git found no commit for ${ref}.`) };
  const args = ["--literal-pathspecs", "log", "--no-patch", "--follow", "--format=%h%x00%an%x00%aI%x00%s",
    ...(event === "first_addition" ? ["--diff-filter=A"] : event === "latest_deletion" ? ["-1", "--diff-filter=D"] : ["-1"]), tip, "--", path];
  const result = await read(args);
  if (!complete(result)) return { text: localized(locale, `Git no pudo completar la búsqueda en el historial de ${path}.`, `Git could not complete the history search for ${path}.`) };
  const rows = result.stdout.trim().split("\n").filter(Boolean);
  const entry = event === "first_addition" ? rows.at(-1) : rows[0];
  if (!entry) return { text: localized(locale, `El historial disponible de ${ref} no muestra ese cambio en ${path}.`, `The available history of ${ref} doesn't show that change to ${path}.`) };
  const [hash, author, date, subject] = entry.split("\0");
  const action = event === "first_addition" ? localized(locale, "añadió", "added")
    : event === "latest_deletion" ? localized(locale, "eliminó", "deleted") : localized(locale, "modificó", "changed");
  const day = date.slice(0, 10);
  const text = limit
    ? localized(locale, `La última entrada disponible de ${path} es ${hash}, de ${author}, el ${day}. ${limit}`,
      `The latest available entry for ${path} is ${hash}, by ${author}, on ${day}. ${limit}`)
    : localized(locale, `${author} ${action} ${path} el ${day} en el commit ${hash}.`, `${author} ${action} ${path} on ${day} in commit ${hash}.`);
  return { text, details: `${ref} · ${hash}\n${subject}\n${date}` };
}

export async function inspectGit(read: ReadGitFacts, argv: string[], snapshot: RepoSnapshot, locale: Locale): Promise<AssistantFinding> {
  const result = await read(assistantQueryArguments(argv));
  const [verb, ...args] = argv;
  const options = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined);
  const diffStatus = verb === "diff" && (options.includes("--exit-code") || options.includes("--quiet"));
  const validExitOne = result.code === 1 && !result.stderr.trim() && (diffStatus || verb === "grep");
  const ok = result.code === 0 || validExitOne;
  const stdout = result.stdout.trim();
  const cut = result.stdoutTruncated || result.stderrTruncated || stdout.length > 8000 || result.stderr.length > 1000;
  const limit = ["rev-list", "log", "show", "blame"].includes(verb) ? historyLimit(snapshot.isShallow, locale) : "";
  const label = ["git", ...argv.map(arg => /[\s\p{Cc}]/u.test(arg) ? JSON.stringify(arg) : arg)].join(" ");
  const details = [label, stdout.slice(0, 8000), result.stderr.trim().slice(0, 1000),
    cut ? localized(locale, "Resultado recortado.", "Output shortened.") : ""].filter(Boolean).join("\n");
  if (ok && !cut && !result.stderr.trim() && verb === "rev-list" && args.length === 2 && args[0] === "--count"
      && !args[1].startsWith("-") && /^\d+$/.test(stdout)) {
    const ref = args[1] === "HEAD" && snapshot.currentBranch !== "HEAD" ? snapshot.currentBranch : args[1];
    const quantity = `${stdout} ${stdout === "1" ? "commit" : "commits"}`;
    const text = args[1].includes("..")
      ? localized(locale, `En el rango ${ref}, Git contó ${quantity}.`, `Git counted ${quantity} in the range ${ref}.`)
      : localized(locale, `En esta copia, Git cuenta ${quantity} en el historial de ${ref}.`, `In this copy, Git counts ${quantity} in ${ref}'s history.`);
    return { text: [text, limit].filter(Boolean).join(" "), details };
  }
  const outcome = !ok
    ? localized(locale, "Git no pudo completar esta comprobación. El detalle explica qué falló.", "Git could not complete this check. See the details for what failed.")
    : diffStatus && !stdout
      ? validExitOne
        ? localized(locale, "Git encontró diferencias.", "Git found differences.")
        : localized(locale, "Git no encontró diferencias.", "Git found no differences.")
      : !stdout ? localized(locale, "Git no encontró coincidencias para esta consulta.", "Git found no matches for this query.")
        : !cut && stdout.length <= 240 && stdout.split("\n").length <= 4
          ? stdout
          : localized(locale, "Git encontró resultados. Puedes revisar el extracto de esta lectura en Detalles técnicos.",
            "Git found results. Technical details shows an excerpt from this read.");
  return { text: [outcome, limit].filter(Boolean).join(" "), details };
}
