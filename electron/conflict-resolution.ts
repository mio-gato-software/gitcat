import { jsonCandidates } from "./llm-plan.js";

/**
 * Asking the model to settle a conflict is the one place where its answer becomes file content rather
 * than a command, so nothing here writes anything: it produces a proposal, and the proposal is shown
 * as a diff for a person to accept or throw away. The decision stays human; the drafting is what the
 * model is good at.
 *
 * It also travels through its own channel rather than the plan machinery, because a plan is a list of
 * Git operations and a resolution is a file — forcing one into the other would mean carrying whole
 * files inside every plan's arguments.
 */

export type ConflictResolution = {
  path: string;
  /** The whole file as it should end up. Never a patch: a partial answer here is a broken file. */
  content: string;
  /** One line on what was kept from each side, for the person reviewing to check against the diff. */
  rationale: string;
  /** The model's own honesty about whether this needs a human to look closely. */
  confidence: "high" | "low";
};

export type ConflictProposal = {
  resolutions: ConflictResolution[];
  /** Files it chose not to settle, and why. Leaving one alone is a valid answer. */
  skipped: { path: string; reason: string }[];
};

export const resolutionKeys = ["confidence", "content", "path", "rationale"];
export const skippedKeys = ["path", "reason"];
export const proposalKeys = ["resolutions", "skipped"];

/** Bigger than this and neither the model nor the person reviewing is reading it properly. */
export const conflictFileLimit = 120_000;

export const resolutionResponseFormat = {
  type: "json_schema",
  name: "gitcat_conflict_resolution",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: proposalKeys,
    properties: {
      resolutions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: resolutionKeys,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            rationale: { type: "string" },
            confidence: { type: "string", enum: ["high", "low"] }
          }
        }
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: skippedKeys,
          properties: { path: { type: "string" }, reason: { type: "string" } }
        }
      }
    }
  }
} as const;

export function buildResolutionInstructions(context: {
  operation: string;
  branch?: string;
  onto?: string;
  ours: string;
  theirs: string;
}) {
  return `You are resolving Git merge conflicts inside GitCat. A ${context.operation} is in progress${
    context.branch ? ` replaying "${context.branch}"` : ""}${context.onto ? ` onto "${context.onto}"` : ""}.

"ours" is ${context.ours}. "theirs" is ${context.theirs}. Get this the right way round: in a rebase they
are the reverse of what people expect, because the commits being replayed are "theirs".

For each file you are given, return the complete final content, with every conflict marker
("<<<<<<<", "=======", ">>>>>>>") gone and nothing else changed. Keep both sides' intent whenever they
touch different things; that is what most conflicts are. Where the two sides genuinely contradict each
other and only a person can know which is wanted, do not guess: leave the file out of "resolutions"
and say why in "skipped".

Never invent code that was in neither side. Never drop a side's work silently — if you keep only one
side, say so in "rationale" and set "confidence" to "low". Preserve the file's existing indentation,
line endings and trailing newline. Return every file either in "resolutions" or in "skipped", and
never a path you were not given.

"rationale" is one line, written in the same language as the conversation, saying what you kept from
each side. It is what the person reads before accepting, so it has to be true and specific.`;
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join("\0") === keys.join("\0");
}

/** The same strictness the plan schema gets: a shape that is not exactly right is not an answer. */
export function parseConflictProposal(text: string): ConflictProposal | undefined {
  for (const candidate of jsonCandidates(text.trim())) {
    try {
      const value = JSON.parse(candidate);
      if (!hasExactKeys(value, proposalKeys)) continue;
      const record = value as { resolutions: unknown; skipped: unknown };
      if (!Array.isArray(record.resolutions) || !Array.isArray(record.skipped)) continue;
      const resolutions = record.resolutions as ConflictResolution[];
      const skipped = record.skipped as { path: string; reason: string }[];
      if (!resolutions.every((entry) => hasExactKeys(entry, resolutionKeys) &&
        typeof entry.path === "string" && typeof entry.content === "string" &&
        typeof entry.rationale === "string" && ["high", "low"].includes(entry.confidence))) continue;
      if (!skipped.every((entry) => hasExactKeys(entry, skippedKeys) &&
        typeof entry.path === "string" && typeof entry.reason === "string")) continue;
      return { resolutions, skipped };
    } catch { /* try the next safely bounded candidate */ }
  }
  return undefined;
}

/** A resolution is only worth showing if it is about a real conflict and actually removes it. */
export function validateProposal(proposal: ConflictProposal, allowed: string[]): ConflictProposal {
  const paths = new Set(allowed);
  const seen = new Set<string>();
  const resolutions = proposal.resolutions.filter((resolution) => {
    if (!paths.has(resolution.path) || seen.has(resolution.path)) return false;
    // A "resolution" that still carries markers has not resolved anything.
    if (/^(<{7}|={7}|>{7})/m.test(resolution.content)) return false;
    seen.add(resolution.path);
    return true;
  });
  const skipped = proposal.skipped.filter((entry) => paths.has(entry.path) && !seen.has(entry.path));
  const answered = new Set([...seen, ...skipped.map((entry) => entry.path)]);
  return {
    resolutions,
    // Anything the model simply forgot is reported as unanswered rather than quietly dropped.
    skipped: [...skipped, ...allowed.filter((path) => !answered.has(path))
      .map((path) => ({ path, reason: "El modelo no dijo nada sobre este archivo." }))]
  };
}
