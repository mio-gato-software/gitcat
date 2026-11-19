import type { Locale, Operation, RepoSnapshot } from "../shared/types.js";
import { isProtectedBranch } from "../shared/branch-lifecycle.js";
import { localized } from "./i18n.js";

export type BranchOperation =
  | { operation: "checkout"; name: string; ref?: string }
  | { operation: "create_branch"; name: string; from?: string }
  | { operation: "delete_branch"; name: string }
  | { operation: "rename_branch"; name: string; to: string }
  | { operation: "merge"; name: string }
  | { operation: "rebase"; onto: string };

const branchNamePattern = /^[A-Za-z0-9._/@-]+$/;

export function isBranchNameSafe(name: unknown): name is string {
  return typeof name === "string" && branchNamePattern.test(name) && !name.includes("..") && !name.includes("@{") &&
    !name.startsWith("-") && !name.startsWith(".") && !name.startsWith("/") && !name.endsWith("/") &&
    !name.endsWith(".") && !name.includes("//") && !name.includes("/.") && !name.endsWith(".lock");
}

function requiredName(name: unknown, missing: string, locale: Locale): string {
  if (name === undefined || name === "") throw new Error(missing);
  if (!isBranchNameSafe(name)) throw new Error(localized(locale, "Nombre de rama no válido.", "Invalid branch name."));
  return name;
}

function changedRemote(locale: Locale) {
  return new Error(localized(locale, "La copia local o remota cambió. Revisa la acción de nuevo.", "The local or remote copy changed. Review the action again."));
}

export function parseBranchOperation(operation: Operation, args: Record<string, string>, locale: Locale): BranchOperation | undefined {
  if (operation === "rebase") {
    return { operation, onto: requiredName(args.onto, localized(locale, "Falta la rama base.", "The base branch is missing."), locale) };
  }
  if (operation !== "checkout" && operation !== "create_branch" && operation !== "rename_branch" &&
      operation !== "delete_branch" && operation !== "merge") return undefined;

  const name = requiredName(args.name, localized(locale, "Falta el nombre de la rama.", "The branch name is missing."), locale);
  if (operation === "rename_branch") {
    return { operation, name, to: requiredName(args.to, localized(locale, "Falta el nombre nuevo de la rama.", "The new branch name is missing."), locale) };
  }
  if (operation === "checkout") {
    const ref = args.ref || undefined;
    if (ref !== undefined && !isBranchNameSafe(ref)) throw changedRemote(locale);
    return { operation, name, ref };
  }
  if (operation === "create_branch") {
    const { from } = args;
    // A starting point picked in the graph is a commit ID.
    if (from !== undefined && (typeof from !== "string" || !/^[0-9a-f]{7,40}$/i.test(from))) {
      throw new Error(localized(locale, "El commit de partida no es válido.", "The starting commit is invalid."));
    }
    return { operation, name, from };
  }
  return { operation, name };
}

export function branchArguments(branch: BranchOperation): string[] {
  switch (branch.operation) {
    case "checkout": return branch.ref
      ? ["switch", "--track", "-c", branch.name, `refs/remotes/${branch.ref}`]
      : ["switch", branch.name];
    case "create_branch": return ["switch", "-c", branch.name, ...(branch.from ? [branch.from] : [])];
    case "delete_branch": return ["branch", "-d", "--", branch.name];
    case "rename_branch": return ["branch", "-m", "--", branch.name, branch.to];
    case "merge": return ["merge", "--no-edit", "--", branch.name];
    case "rebase": return ["rebase", branch.onto];
  }
}

function remoteOnly(name: string, locale: Locale) {
  return new Error(localized(locale, `La rama ${name} solo existe en el remoto. Cámbiate a ella primero para tenerla en local.`, `Branch ${name} only exists on the remote. Switch to it first to create it locally.`));
}

export function validateBranchOperation(branch: BranchOperation, snapshot: RepoSnapshot, locale: Locale) {
  const { operation } = branch;
  const findBranch = (name: string) => snapshot.branches.find((item) => item.name === name);
  const upstream = snapshot.branches.find((item) => item.isCurrent)?.upstream;
  if (operation === "rebase") {
    const { onto } = branch;
    const base = findBranch(onto);
    if (base?.presence === "remote") throw remoteOnly(onto, locale);
    if (!base && onto !== upstream && !snapshot.remoteRefs?.some(ref => `refs/remotes/${ref}` === onto)) {
      throw new Error(localized(locale, `La rama base ${onto} no existe. Actualiza la lista.`, `Base branch ${onto} does not exist. Refresh the list.`));
    }
    if (snapshot.currentBranch === "HEAD" || onto === snapshot.currentBranch) {
      throw new Error(localized(locale, "Elige otra rama como base y trabaja desde una rama local.", "Choose another branch as the base and work from a local branch."));
    }
    return;
  }

  const { name } = branch;
  const existing = findBranch(name);
  if (operation === "create_branch") {
    if (existing) throw new Error(localized(locale, `La rama ${name} ya existe.`, `Branch ${name} already exists.`));
    return;
  }
  if (operation === "delete_branch") {
    if (name === snapshot.defaultBranch) throw new Error(localized(locale, `No puedes borrar la rama por defecto (${snapshot.defaultBranch}).`, `You cannot delete the default branch (${snapshot.defaultBranch}).`));
    if (name === snapshot.currentBranch) throw new Error(localized(locale, "No puedes borrar la rama activa.", "You cannot delete the active branch."));
    if (isProtectedBranch(name)) throw new Error(localized(locale, `La rama ${name} está protegida por su prefijo: las ramas de ese tipo existen para conservarse.`, `Branch ${name} is protected by its prefix: branches of this kind are meant to be kept.`));
  }
  if (operation === "rename_branch") {
    const { to } = branch;
    if (name === snapshot.defaultBranch) throw new Error(localized(locale, `No puedes renombrar la rama por defecto (${snapshot.defaultBranch}).`, `You cannot rename the default branch (${snapshot.defaultBranch}).`));
    if (to === name) throw new Error(localized(locale, "El nombre nuevo es el mismo que el actual.", "The new name is the same as the current name."));
    if (findBranch(to)) throw new Error(localized(locale, `La rama ${to} ya existe.`, `Branch ${to} already exists.`));
    if (existing?.checkedOutIn) throw new Error(localized(locale, `La rama ${name} está en uso por el worktree ${existing.checkedOutIn}.`, `Branch ${name} is in use by worktree ${existing.checkedOutIn}.`));
  }
  if (!existing && !(operation === "merge" && name === upstream)) {
    throw new Error(localized(locale, `La rama ${name} no existe localmente.`, `Branch ${name} does not exist locally.`));
  }
  if (operation === "checkout") {
    if (branch.ref && (!snapshot.remoteRefs?.includes(branch.ref) || existing?.presence !== "remote")) throw changedRemote(locale);
  } else if (existing?.presence === "remote") {
    throw remoteOnly(name, locale);
  }
  if (operation === "merge" && name === snapshot.currentBranch) {
    throw new Error(localized(locale, `No puedes fusionar ${name} consigo misma.`, `You cannot merge ${name} into itself.`));
  }
}
