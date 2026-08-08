# Branchline development guide

Read this file before starting a task in this repository.

## Product spirit

Branchline is for people who need Git, not necessarily for people who already know Git. A user may
be unfamiliar with branches, commits, remotes, conflicts, or the terminology of tools such as
GitKraken, and should still be able to make progress without buying another tool or learning a
specialized workflow first.

- Start from the user's goal, not from Git commands. Translate intent into the safest useful action.
- Explain what Git is about to do in plain language, including what will change, what will stay safe,
  and what the user needs to decide.
- Treat the assistant as a patient guide: surface missing context, detect surprising states, and ask
  a focused question when guessing could lose work.
- Treat errors as moments to guide, not as terminal walls. Translate raw tool output, explain what is
  still safe, and offer concrete alternatives that the current repository state actually supports.
- Do not leave a blocked action at an error message. Recovery should be attempted after preparation
  failures, execution failures, and stale-state failures; the assistant should propose a safe next
  action or ask the smallest question needed to choose one. This applies to every Git workflow; any
  specific error used in a test or example is illustrative, not a special case or an exhaustive list.
- Keep advanced Git power available without making Git knowledge a prerequisite. Expert users should
  get efficient paths, while newer users should get understandable labels, summaries, and recovery.
- Never make a user feel at fault for not knowing a Git concept. The product owns the translation.

## Product principles

- Keep Git operations observable and confirmable. Never silently change history or hide a partial operation.
- Treat the repository snapshot as the source of truth. Do not infer branch state from names, UI labels, or stale conversation text.
- Preserve uncommitted work. A branch tip does not include working-tree changes until they are committed.
- Prefer the LLM for ambiguous intent and repository-aware decisions. Use deterministic guardrails for validation, safety, and facts Git can prove.
- When a task changes behavior, add a focused regression test and keep the user-facing explanation concrete.

## Before editing

- Check the current branch and worktree status; preserve existing user changes.
- Trace the existing UI, IPC/preload bridge, service validation, and execution path before adding a parallel path.
- Read the relevant tests and update the smallest contract that expresses the new behavior.

## Git safety

- Never treat an empty or already-contained branch as a meaningful merge.
- Never claim uncommitted changes were merged. Decide explicitly whether they belong in a commit, need review, or must remain untouched.
- Validate plans against the latest repository state immediately before execution.
- Keep destructive operations behind the existing confirmation and guardrail layers.

## Validation

- Run `npm run typecheck` for TypeScript changes.
- Run `npm test` for behavioral or contract changes.
- Run `npm run build` when renderer, Electron, or packaging paths change.
