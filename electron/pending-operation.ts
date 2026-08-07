import type { Conflict, ConflictKind, PendingOperation, PendingOperationKind } from "../shared/types.js";

/**
 * A Git operation that stopped part-way is a state, not an error. Rebase, merge, cherry-pick and
 * revert all leave the repository holding a half-finished job, and until now the application knew
 * only that "a rebase is happening" — not which commit of how many, onto what, or which files are
 * standing in the way. Without that, the one thing the assistant cannot do is say how to continue,
 * which is exactly when a person needs it most.
 */

/** What each two-letter status code means when both sides touched the same path. */
const conflictKinds: Record<string, ConflictKind> = {
  DD: "both-deleted",
  AU: "added-by-us",
  UD: "deleted-by-them",
  UA: "added-by-them",
  DU: "deleted-by-us",
  AA: "both-added",
  UU: "both-modified"
};

export const conflictLabels: Record<ConflictKind, string> = {
  "both-deleted": "los dos lados lo borraron",
  "added-by-us": "lo añadimos nosotros, el otro lado no lo tiene",
  "deleted-by-them": "nosotros lo cambiamos, el otro lado lo borró",
  "added-by-them": "lo añadió el otro lado, nosotros no lo tenemos",
  "deleted-by-us": "nosotros lo borramos, el otro lado lo cambió",
  "both-added": "los dos lados lo crearon por separado",
  "both-modified": "los dos lados lo cambiaron"
};

export function conflictKind(code: string): ConflictKind | undefined {
  return conflictKinds[code];
}

/** The conflicted paths, read from the same status the working tree already reports. */
export function conflictsFrom(changes: { code: string; path: string }[]): Conflict[] {
  return changes.flatMap((change) => {
    const kind = conflictKind(change.code);
    return kind ? [{ path: change.path, kind }] : [];
  });
}

/**
 * `git rebase` keeps its progress in plain files. "msgnum"/"end" for an interactive or merge rebase,
 * "next"/"last" for the patch-based one, and "head-name" names the branch being replayed.
 */
export function parseRebaseProgress(files: Record<string, string | undefined>): Partial<PendingOperation> {
  const number = (value: string | undefined) => {
    const parsed = Number.parseInt((value ?? "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const branch = (files["head-name"] ?? "").trim().replace(/^refs\/heads\//, "");
  return {
    step: number(files.msgnum) ?? number(files.next),
    total: number(files.end) ?? number(files.last),
    branch: branch || undefined,
    onto: (files["onto-name"] ?? files.onto ?? "").trim().slice(0, 40) || undefined
  };
}

/** How to describe the pending job in one line, in the interface's own language. */
export const pendingLabels: Record<PendingOperationKind, string> = {
  rebase: "Rebase en curso",
  merge: "Fusión en curso",
  cherry_pick: "Cherry-pick en curso",
  revert: "Revert en curso"
};

/** Only a rebase and a cherry-pick can drop the commit they are stuck on and carry on. */
export function canSkip(kind: PendingOperationKind) {
  return kind === "rebase" || kind === "cherry_pick";
}

/** The Git subcommand each pending job continues, aborts or skips with. */
export const pendingCommands: Record<PendingOperationKind, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert"
};

/**
 * Which side of a conflict a resolution keeps, translated into what Git actually has to be told. A
 * path one side deleted cannot be checked out from that side, so "keep ours" on a file we deleted is
 * a removal rather than a checkout. Getting this wrong would stage the opposite of what was asked.
 */
export function resolutionFor(kind: ConflictKind, side: "ours" | "theirs"): "checkout" | "add" | "remove" {
  /**
   * Which sides hold the file at all. Both flags are needed: inverting one to get the other is wrong
   * the moment both sides have it, which is the most common conflict there is.
   */
  const holders: Record<ConflictKind, { ours: boolean; theirs: boolean }> = {
    "both-modified": { ours: true, theirs: true },
    "both-added": { ours: true, theirs: true },
    "added-by-us": { ours: true, theirs: false },
    "deleted-by-them": { ours: true, theirs: false },
    "added-by-them": { ours: false, theirs: true },
    "deleted-by-us": { ours: false, theirs: true },
    "both-deleted": { ours: false, theirs: false }
  };
  const held = holders[kind];
  if (!held[side]) return "remove";
  // Only when both sides hold content does Git have two versions to pick between in the index.
  return held.ours && held.theirs ? "checkout" : "add";
}
