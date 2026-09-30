/** Where the branch actually exists: only here, only on a remote, or on both. */
export type BranchPresence = "local" | "remote" | "both";
export type DefaultBranchSource = "remote_head" | "conventional_name";

export type Branch = {
  name: string;
  upstream?: string;
  /** The remote-tracking ref this branch corresponds to, such as "origin/main". */
  remoteRef?: string;
  /** Comparison with remoteRef, including counterparts without a configured upstream. */
  remoteAhead?: number;
  remoteBehind?: number;
  presence: BranchPresence;
  /**
   * Reference branches whose history already contains this branch's tip, so its work is integrated
   * there and deleting it loses nothing. Empty means it is integrated into none of them. Note that
   * ahead/behind compare against the upstream only, and say nothing about this.
   */
  mergedInto: string[];
  ahead: number;
  behind: number;
  isCurrent: boolean;
  /**
   * The worktree holding this branch, when it is another one. Git refuses to check out the same branch
   * twice, so this is what explains a switch that cannot happen; the open repository is never named
   * here, because that branch is already the current one.
   */
  checkedOutIn?: string;
  /**
   * The branch this one continues: its tip is an ancestor of this one's and its name opens this
   * one's. Verified against Git, not guessed from the name, and only ever a direct relation.
   */
  stackedOn?: string;
  lastCommit?: Commit;
};

export type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  refs: string[];
  /** Parent hashes in Git's own order, so the first is the one the branch continues. The edges of the graph. */
  parents: string[];
  /** The message after its subject line, when the history page carried it. */
  body?: string;
  /** How much the commit changed against its first parent. Only history pages measure it. */
  stats?: CommitStats;
};

export type CommitStats = { files: number; additions: number; deletions: number };

/** Lines one file gained and lost. Binary files have no lines to count, and say so. */
export type FileStats = { additions: number; deletions: number; binary: boolean };

export type FileChange = {
  code: string;
  path: string;
  /** Where a renamed or copied file used to be. Absent for every other kind of change. */
  from?: string;
  /**
   * Git's own two-letter status for an uncommitted change: the first letter is the staged side, the
   * second the working-tree side, so "MM" is a file with both staged and unstaged edits. Absent in
   * commit details, which have no such split.
   */
  xy?: string;
  /**
   * What this uncommitted change looks like right now: the commit it sits on, its status, its staged
   * entries and its bytes on disk. A save of selected files is bound to these, so an edit to a file
   * that was left out does not invalidate the review, and an edit to a selected one always does.
   */
  version?: string;
};

/** One file picked for a save, with the version the person reviewed. */
export type SelectedChange = { path: string; version: string };

/**
 * A save from the Changes view. Without `selection` every listed file is saved and the whole
 * repository state is the binding; with it, only those files are saved and each one's version is.
 */
export type DeliveryRequest = {
  stateId: string; mergeToDefault: boolean; message?: string; selection?: SelectedChange[];
};

/** The shape a local check recognised. Never the matched text: a finding must be safe to show and log. */
export type SecretKind =
  | "credential_file" | "private_key" | "aws_access_key" | "github_token" | "slack_token" | "stripe_key"
  | "api_key" | "google_api_key" | "jwt" | "credential_url" | "secret_assignment";

/** Where something looks like a credential: a file, the line when there is one, and what it resembles. */
export type SecretFinding = { path: string; line?: number; kind: SecretKind };

/**
 * A file whose content did not go to the provider. The model reads a placeholder that names it and
 * the reason, and the interface says the same, so an answer limited by it is never silently limited.
 */
export type WithheldFile = { path: string; reason: "excluded" | "likely_secret"; findings?: SecretFinding[] };

/** What a request to the provider is for. Each one reads a different part of the repository. */
export type AiSharingPurpose = "planning" | "description" | "conflicts" | "recovery";

/**
 * What happens to one file in a request: its content is sent, sent because the person reviewed it,
 * or withheld because it is excluded or looks like it holds a credential.
 */
export type AiSharingFile = { path: string; status: "sent" | "reviewed" | "excluded" | "likely_secret"; findings: SecretFinding[] };

/** Everything the disclosure shows before repository content leaves this computer for the configured provider. */
export type AiSharingPreview = {
  repoPath: string;
  provider: "openai";
  model: string;
  /** The host requests go to. */
  destination: string;
  /** Whether the person already agreed to share this repository with the assistant. */
  acknowledged: boolean;
  acknowledgedAt?: string;
  purpose: AiSharingPurpose;
  /** Path patterns this repository never shares, stored on this computer rather than in the repository. */
  exclusions: string[];
  /** The files this request would read, and what happens to each one. */
  files: AiSharingFile[];
};

/**
 * A Git job that stopped part-way. It is a state the repository is in, not a failure that happened:
 * rebase, merge, cherry-pick and revert all leave one behind, and knowing which one — and how far it
 * got — is what makes it possible to say how to continue instead of only that something broke.
 */
export type PendingOperationKind = "rebase" | "merge" | "cherry_pick" | "revert";

export type PendingOperation = {
  kind: PendingOperationKind;
  /** Which commit of how many, when the operation replays a sequence. */
  step?: number;
  total?: number;
  /** The branch being replayed, and what it is being replayed onto. */
  branch?: string;
  onto?: string;
};

export type ConflictKind =
  | "both-modified" | "both-added" | "both-deleted"
  | "added-by-us" | "added-by-them" | "deleted-by-us" | "deleted-by-them";

export type Conflict = {
  path: string;
  kind: ConflictKind;
};

export type Worktree = {
  path: string;
  head: string;
  branch?: string;
  isCurrent: boolean;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
  /** Read-only status for this folder; absent when the folder cannot be inspected. */
  changes?: FileChange[];
  statusUnavailable?: boolean;
};

export type RepoSnapshot = {
  /** Exact remote-tracking names, including branches with copies on several remotes. */
  remoteRefs?: string[];
  /** Entries available to restore with Stash pop, including entries created outside GitCat. */
  stashCount?: number;
  /** All working folders reported by Git, including detached and unavailable entries. */
  worktrees?: Worktree[];
  path: string;
  name: string;
  head: string;
  stateId: string;
  currentBranch: string;
  /** The branch integration is measured against, resolved from the remote HEAD or a conventional name. */
  defaultBranch?: string;
  /** How the default branch was identified; absent means the repository did not expose one. */
  defaultBranchSource?: DefaultBranchSource;
  /** Kept as the plain question it always answered; `pending` is the detail behind it. */
  isRebasing: boolean;
  /** The half-finished job the repository is holding, when it is holding one. */
  pending?: PendingOperation;
  /** Paths both sides changed. Nothing can continue until these are settled. */
  conflicts: Conflict[];
  isDirty: boolean;
  changes: FileChange[];
  branches: Branch[];
  commits: Commit[];
  remotes: string[];
  /** Each remote's URL, keyed by its name: which one a push would actually reach. */
  remoteUrls: Record<string, string>;
  /**
   * Saved commits on the current branch that the default branch does not contain yet, counted by
   * Git. Absent when there is nothing to compare: detached, before the first save, or on the default.
   */
  integration?: { target: string; notIntegrated: number };
};

/**
 * What slice of the history the middle column is showing. Until now it was always every ref at once,
 * which meant the list never had anything to do with the branch anyone was looking at.
 */
export type HistoryScope = "all" | "branch" | "branch-only";

export type HistoryRequest = {
  scope: HistoryScope;
  /** Required by every scope but "all". Validated against the repository before it reaches Git. */
  branch?: string;
  limit?: number;
  skip?: number;
};

export type HistoryPage = {
  commits: Commit[];
  /** Git had more behind this page, so the list can say so instead of implying it is complete. */
  hasMore: boolean;
  scope: HistoryScope;
  branch?: string;
  /** What "branch-only" measured against; absent when the repository exposes no default branch. */
  comparedTo?: string;
};

export type CommitDetail = {
  hash: string;
  /** The message after the subject line, so the detail can show everything the author wrote. */
  body?: string;
  /** Against the first parent, which is what a merge commit actually brought in. */
  files: FileChange[];
  /** Line counts per file, keyed by the path the file has after the change. */
  stats: Record<string, FileStats>;
  diff: string;
  /** A diff too large to hand over whole was cut, and says so rather than looking complete. */
  truncated: boolean;
};

export type ConflictResolution = {
  path: string;
  /** The whole file as the model proposes it should end up. Nothing is written until a person says so. */
  content: string;
  rationale: string;
  confidence: "high" | "low";
};

export type ConflictProposal = {
  /**
   * Issued by the main process, which keeps the reviewed content and what it was drafted against.
   * Applying names this id and the accepted paths; the renderer never sends file content back.
   */
  id: string;
  /** The repository the proposal was drafted in. Applying it anywhere else is refused. */
  repoPath: string;
  resolutions: ConflictResolution[];
  /** Files the model would not settle, each with its reason. Leaving one alone is a valid answer. */
  skipped: { path: string; reason: string }[];
  /** What each file looks like right now, so the interface can show the change rather than assert it. */
  current: Record<string, string>;
  /** Conflicted files whose content was not sent, and why. They are listed in `skipped` as well. */
  withheld?: WithheldFile[];
};

/**
 * What happened to one accepted file. "changed" means the file, its conflict or the operation moved on
 * after the review, so it was left exactly as it is; "not_applied" means it was never reached.
 */
export type ConflictFileOutcome = {
  path: string;
  status: "applied" | "changed" | "not_applied" | "failed";
  /** For a failure: whether the file was put back exactly as it was before GitCat touched it. */
  restored?: boolean;
  /** What Git or the file system said, for a failure. */
  detail?: string;
};

export type ConflictApplyResult = {
  snapshot: RepoSnapshot;
  /** True only when every accepted file was written and marked resolved. */
  complete: boolean;
  /**
   * Why nothing was written: the reviewed files changed, the operation holding the conflicts moved
   * on, or the proposal belongs to another repository. A fresh review is the way forward.
   */
  stale?: "files" | "operation" | "repository";
  outcomes: ConflictFileOutcome[];
};

/**
 * Git's own names for the two versions of a conflicted file. "ours" is always index stage 2 and
 * "theirs" stage 3, whatever the operation; what each one *means* depends on the operation, which is
 * why the guide names them with real branches and commits instead of these words.
 */
export type ConflictSideId = "ours" | "theirs";

/**
 * What a side of the operation is, in the terms a person recognises. During a rebase the branch
 * underneath is "ours" and the person's own commit being replayed is "theirs", the reverse of what
 * most people expect; the role carries that so the interface can say it plainly.
 */
export type ConflictSideRole =
  | "current_branch" | "incoming_branch" | "rebase_base" | "replayed_commit" | "picked_commit" | "reverted_commit";

export type ConflictSideIdentity = {
  id: ConflictSideId;
  role: ConflictSideRole;
  /** A branch name when one is known; otherwise the short commit hash. */
  name: string;
  /** The commit this side's content comes from. */
  commit?: { shortHash: string; subject: string };
};

/** One side's copy of a conflicted file, read from the index stage Git is holding. */
export type ConflictFileVersion = {
  /** Whether this side has the file at all. A side that deleted or renamed it away does not. */
  present: boolean;
  binary: boolean;
  size?: number;
  /** The text itself, for a readable file, so the choice is made looking at it. */
  preview?: string;
  previewTruncated?: boolean;
};

/** A path one side renamed, when the conflict is about a rename rather than an edit. */
export type ConflictRename = { side: ConflictSideId; from: string; to: string };

/**
 * What a person can decide for one file without any assistant. Keeping a side checks out that side's
 * version (or removes the file when that side deleted it); "delete" keeps the deletion; "edited"
 * marks the file resolved exactly as it is on disk, and is refused while conflict markers remain.
 */
export type ConflictChoice = "ours" | "theirs" | "delete" | "edited";

export type ConflictGuideFile = {
  path: string;
  kind: ConflictKind;
  /** Any version is binary, a symlink or a submodule: only whole-version choices make sense. */
  binary: boolean;
  renames: ConflictRename[];
  ours: ConflictFileVersion;
  theirs: ConflictFileVersion;
  /** The common ancestor's copy, when there is one. */
  base: { present: boolean };
  /** What the file on disk holds right now. */
  working: { present: boolean; binary: boolean; markers: boolean };
  /** The only choices this file's shape supports, in the order they are offered. */
  choices: ConflictChoice[];
};

/**
 * Every open conflict explained from the repository alone: which job holds them, what each side is,
 * and the choices each file supports. Issued by the main process, which keeps what it was read
 * against; choosing names this id, never file content.
 */
export type ConflictGuide = {
  id: string;
  repoPath: string;
  operation?: PendingOperationKind;
  /** Which commit of how many, for a sequence. */
  step?: number;
  total?: number;
  /** Commits still waiting after the current one; each of them may stop with new conflicts. */
  remaining: number;
  branch?: string;
  sides: { ours: ConflictSideIdentity; theirs: ConflictSideIdentity };
  files: ConflictGuideFile[];
};

export type ConflictChoiceRequest = { path: string; choice: ConflictChoice };

/**
 * What happened to one chosen file. "refused" means the choice itself cannot be applied to the file
 * as it is — conflict markers are still in it, or it is not on disk — and nothing was written.
 */
export type ConflictChoiceOutcome = {
  path: string;
  choice: ConflictChoice;
  status: "applied" | "changed" | "not_applied" | "failed" | "refused";
  reason?: "markers" | "missing";
  restored?: boolean;
  detail?: string;
};

export type ConflictChoiceResult = {
  snapshot: RepoSnapshot;
  complete: boolean;
  stale?: "files" | "operation" | "repository";
  outcomes: ConflictChoiceOutcome[];
};

export type Operation =
  | "sync_remote"
  | "stash_push"
  | "stash_pop"
  | "status"
  | "checkout"
  | "create_branch"
  | "delete_branch"
  | "rename_branch"
  | "fetch"
  | "pull"
  | "push"
  | "merge"
  | "rebase"
  | "abort_operation"
  | "continue_operation"
  | "skip_operation"
  | "resolve_conflict"
  | "commit"
  | "git_command"
  | "github_create_repo"
  /** Adds one anchored line to .gitignore for an untracked file. Only a direct control prepares it; the model never can. */
  | "ignore_path"
  /** Sets the name and email commits are signed with, for this repository or globally (`scope`). Direct control only. */
  | "set_identity"
  /** Connects this repository to a remote address the person typed. Direct control only. */
  | "add_remote"
  | "none";

export type GitProtocol = "ssh" | "https";

export type RepositoryPlan = {
  action: "create_repository" | "create_repository_and_push";
  host: string;
  owner: string;
  repository: string;
  localPath: string;
  protocol: GitProtocol;
  /** SSH host or ~/.ssh/config alias that authenticates as `owner`. Empty for HTTPS. */
  sshHost: string;
  remoteUrl: string;
  requiresConfirmation: true;
};

/** One Git operation inside a plan. The model orders the steps; this shape is what the code validates and runs. */
export type PlanStep = {
  operation: Operation;
  args: Record<string, string>;
  /** Free-form git_command steps: the argument list handed to git verbatim, without the leading "git". */
  argv?: string[];
  /**
   * For a commit that saves selected files only: every path it records, including both sides of a
   * rename. Absent means the commit saves every change, as a planned commit always has.
   */
  paths?: string[];
  command: string;
  summary: string;
  risk: "low" | "medium" | "high";
};

export type StepOutcome = {
  command: string;
  summary: string;
  status: "completed" | "failed" | "skipped";
  output: string;
};

export type ActionPlan = {
  switchWork?: SwitchWorkRequest;
  recovery?: HistoryRecovery;
  id: string;
  repoPath: string;
  head: string;
  stateId: string;
  allowed: boolean;
  /**
   * Everything the plan will run, in order, approved as a whole. A request like "merge this branch
   * into main" needs more than one operation, so a plan is never assumed to be a single step.
   */
  steps: PlanStep[];
  operation: Operation;
  args: Record<string, string>;
  command: string;
  summary: string;
  rationale: string;
  answer?: string;
  effects?: string[];
  repositoryPlan?: RepositoryPlan;
  targetPath?: string;
  targetHead?: string;
  targetStateId?: string;
  /**
   * A save of selected files is bound to those files, not to the whole repository: `binding` covers
   * the commit, the branch, each selected file's reviewed version and, when integrating, the target
   * branch tip. It replaces the `stateId` comparison at execution.
   */
  selection?: { changes: SelectedChange[]; binding: string; target?: string };
  /** Files whose content the model did not read while preparing this, so the answer says what it is missing. */
  withheld?: WithheldFile[];
  /** Nothing was sent: the person has not yet agreed to share this repository with the assistant. */
  sharingRequired?: boolean;
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  /** "question" is the assistant asking for something, not a failure; the interface must not dress it as one. */
  kind: "plan" | "question" | "refusal";
  /** "llm": the model interpreted the request. "guardrail": a direct control or a local safety rule. */
  source: "llm" | "guardrail";
  /**
   * The assistant could not answer: it is not set up, it did not reply in time, it could not be
   * reached, or it failed. The interface keeps what was typed and leans on what GitCat can prove.
   */
  assistantUnavailable?: AssistantUnavailable;
};

export type AssistantUnavailable = "not_configured" | "timeout" | "unreachable" | "error";

/**
 * Why the AI assistant could not be connected or stopped answering, told apart so the interface can
 * say it in plain words and offer the way on: fix the key, pick another model, set up billing on the
 * provider, wait for the provider, check the network, or unlock this computer's secure storage.
 */
export type AiProblemKind =
  | "invalid_key" | "unknown_model" | "no_access" | "billing" | "rate_limited"
  | "outage" | "unreachable" | "timeout" | "storage_unavailable" | "unexpected";

export type AiConnectionProblem = {
  kind: AiProblemKind;
  /** The provider's or the system's own words, with anything that looks like a key masked. */
  detail: string;
  at: string;
};

export type LlmConfig = {
  provider: "openai";
  model: string;
  /** A key is saved and was verified with the provider when it was saved. */
  configured: boolean;
  /** Whether this computer can encrypt a key. Without it no key is saved: never as plain text. */
  secureStorage: boolean;
  /** A key was saved before, but this computer's secure storage cannot unlock it right now. It is kept. */
  storedKeyUnreadable?: boolean;
  /** The last request with the saved key that failed; the next one that works clears it. */
  lastProblem?: AiConnectionProblem;
};

/** Connecting or checking the assistant never throws for a provider problem: it says which one. */
export type LlmConnectResult =
  | { ok: true; config: LlmConfig }
  | { ok: false; config: LlmConfig; problem: AiConnectionProblem };

/** Provider pages GitCat may open in the browser. The main process holds the only addresses. */
export type ProviderPage = "api_keys" | "billing";

/** Setup pages GitCat may open in the browser from the readiness checks. The main process holds the only addresses. */
export type HelpPage = "github_ssh_keys" | "git_download" | "gh_install";

/** Where a Git setting comes from, as `git config --show-scope` names it. */
export type ConfigScope = "local" | "worktree" | "global" | "system" | "command";

/** Which settings file `set_identity` writes: this repository's, or the one every repository on this computer reads. */
export type IdentityScope = "local" | "global";

export type GitToolReadiness =
  | { status: "ok"; path: string; version: string }
  /** Found, but it does not run: on a Mac, usually Apple's developer tools still need installing. */
  | { status: "unusable"; path: string; detail: string }
  | { status: "missing"; searched: number };

export type IdentityValues = { name?: string; email?: string };

/**
 * Who a save is attributed to. This is a label written into each commit, never a login: publishing
 * uses a separate sign-in, reported under the remote.
 */
export type AuthorReadiness = {
  status: "ok" | "partial" | "missing";
  /** The values Git will actually use, and the settings file each one comes from. */
  name?: { value: string; scope: ConfigScope };
  email?: { value: string; scope: ConfigScope };
  /** What this repository sets for itself, and what every repository on this computer falls back to. */
  repository: IdentityValues;
  global: IdentityValues;
  /** The repository sets its own values and they differ from the global ones. */
  overridesGlobal: boolean;
};

/** Whether this computer can reach and read the remote with the sign-in it already has, from Git's own answer. */
export type RemoteAccess = "ok" | "denied" | "not_found" | "credentials" | "offline" | "host_key" | "unknown" | "not_checked";
export type RemoteProtocol = "https" | "ssh" | "local" | "other";
/** What keeps an HTTPS sign-in on this computer, by kind only. Its contents are never read. */
export type CredentialHelper = "gh" | "osxkeychain" | "manager" | "store" | "cache" | "other" | "none";

export type AccountReadiness = {
  /** GitHub CLI is not installed, is installed with nobody signed in, or has accounts. */
  gh: "missing" | "signed_out" | "signed_in";
  accounts: { login: string; active: boolean }[];
  /** Who the SSH key on this computer signs in as, from the host's own greeting. */
  sshLogin?: string;
  /** The account this remote is proven to use, when GitCat could tell, and how it knows. */
  verified?: string;
  verifiedBy?: "ssh" | "gh";
  /** The SSH key and GitHub CLI's active account belong to different accounts. */
  differs: boolean;
};

export type RemoteReadiness =
  | { status: "none"; remotes: string[] }
  | {
    status: "found";
    name: string;
    /** Where a push goes, with any user name or token removed. */
    url: string;
    protocol: RemoteProtocol;
    host?: string;
    /** The real host behind an SSH alias from ~/.ssh/config. */
    resolvedHost?: string;
    /** owner/repository, as the address writes it. */
    path?: string;
    /** Why this remote: the one asked for, the branch's upstream, origin, the only one, or the first of several. */
    source: "requested" | "upstream" | "origin" | "only" | "first";
    upstream?: string;
    remotes: string[];
    access: RemoteAccess;
    /** What Git answered, with anything shaped like a credential masked. */
    detail?: string;
    helper?: CredentialHelper;
    /** Accounts on GitHub, when the remote is there. */
    account?: AccountReadiness;
  };

/** What Git needs before a first save or a publish, read from this computer. Checking never changes anything. */
export type ReadinessReport = {
  repoPath?: string;
  checkedAt: string;
  git: GitToolReadiness;
  author: AuthorReadiness;
  remote: RemoteReadiness;
};

export type ReadinessRequest = {
  /** A remote to check instead of the one GitCat would pick. */
  remote?: string;
  /** Contact the remote to check access. Without it, only this computer is read. */
  access?: boolean;
};

export type LlmConfigInput = {
  apiKey: string;
  model: string;
  clearApiKey?: boolean;
};

export type Locale = "en" | "es";

/** What the interface hands back to the model after a plan stopped part-way. */
export type ExecutionFailure = {
  command: string;
  summary: string;
  error: string;
  /** The steps that never ran, so the model plans from where the repository actually is. */
  skipped: string[];
  /**
   * The plan that stopped, when there was one. The main process keeps what each of its steps did, so
   * what completed, failed and never ran is read from that record, not from what the interface says.
   */
  planId?: string;
  /** Where it stopped: before anything ran, while running, or because the repository moved under the plan. */
  stage?: FailureStage;
};

/** Why a Git action stopped, as far as Git's own output and the repository state can prove it. */
export type FailureKind =
  | "network" | "auth" | "missing_upstream" | "no_remote" | "divergent" | "conflict" | "pending"
  | "hook" | "identity" | "stale" | "lock" | "unknown";

export type FailureStage = "prepare" | "execute" | "stale";

/**
 * A way on that GitCat can offer without interpreting anything. Each one maps to something that
 * already exists: a re-read, a view, or an allow-listed operation that goes through the usual
 * preparation and confirmation. None of them runs a change by itself.
 */
export type RecoveryActionKind =
  /** Re-read the repository. Changes nothing. */
  | "refresh"
  /** Prepare, against a fresh read, only the steps of the stopped plan that never completed. */
  | "retry"
  /** Open the uncommitted work, with the save draft as it was. */
  | "inspect_changes"
  /** Ask for a name and an email, then prepare `set_identity`. */
  | "configure_identity"
  /** Ask for a remote address, then prepare `add_remote`. */
  | "configure_remote"
  /** Reopen conflict resolution. */
  | "resolve_conflicts"
  /** An allow-listed operation, prepared by `prepareOperation` and confirmed as usual. */
  | "prepare"
  /** Leave everything exactly as it is. Only offered as one answer to a choice. */
  | "keep";

/** Which answer an action is, so the interface can name it and say what it costs. */
export type RecoveryOption =
  | "fetch" | "pull" | "publish" | "merge_upstream" | "rebase_upstream" | "push_no_verify" | "abort" | "continue";

export type RecoveryAction = {
  kind: RecoveryActionKind;
  option?: RecoveryOption;
  operation?: Operation;
  args?: Record<string, string>;
};

/** What the repository shows right now, read again after the failure. */
export type RecoveryFacts = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remotes: string[];
  /** The remote the failed step talked to, when it can be told. */
  remote?: string;
  pending?: PendingOperation;
  conflicts: number;
  /** Uncommitted changes, which stay exactly as they were. */
  changes: number;
  /** The hook that stopped the step, such as "pre-commit". */
  hook?: string;
  /** A lock file Git left behind, relative to the repository. */
  lock?: string;
  /** HEAD is not where the plan was prepared. */
  moved?: boolean;
};

/**
 * A failure explained from facts alone, so it stays actionable with no assistant: what completed,
 * what failed, what never ran, what is still safe and what the repository supports doing next.
 */
export type RecoveryReport = {
  repoPath: string;
  kind: FailureKind;
  stage: FailureStage;
  failedSummary: string;
  /** What Git said. Shown to the person; never interpreted beyond classification. */
  detail: string;
  completed: string[];
  notRun: string[];
  facts: RecoveryFacts;
  /** Ways on that follow from the facts. */
  actions: RecoveryAction[];
  /**
   * More than one reasonable answer and only the person can pick. Present as a focused question;
   * GitCat never chooses one of these by itself.
   */
  choice?: RecoveryAction[];
  /** The assistant's reasoning helps here: the choice is a judgment call or the cause is unknown. */
  needsJudgment: boolean;
};

export type ExecutionResult = {
  snapshot: RepoSnapshot;
  output: string;
  error?: string;
  /** What each step of the plan actually did, so a sequence that stops halfway is never reported as a success. */
  outcomes?: StepOutcome[];
  /**
   * The output shows a file that is excluded or looks like a credential. It is shown to the person, and
   * kept out of the conversation that later goes back to the assistant.
   */
  withheldFromAssistant?: boolean;
};

export type CommitDescriptionResult = {
  description: string;
  stateId: string;
  /** The files the description was written from, with the versions that were read. */
  selection?: SelectedChange[];
  /** Ticked files whose content the model did not read; the description can only reflect their names. */
  withheld?: WithheldFile[];
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Why a saved project could not be read. Only `not_repository` is a fact about the folder itself;
 * the others describe a drive, a permission or a tool that may be back in a minute, so none of them
 * is a reason to forget the project.
 */
export type ProjectUnavailableReason = "storage" | "missing" | "permission" | "tool" | "not_repository";

/** A saved project GitCat could not open, kept with its last known path so it can be retried or found again. */
export type UnavailableProject = {
  path: string;
  name: string;
  reason: ProjectUnavailableReason;
  /** What the filesystem or Git actually said, for the person who wants the raw detail. */
  detail?: string;
  checkedAt: string;
};

export type RestoredWorkspace = {
  projects: RepoSnapshot[];
  /** Saved projects that could not be opened this time. They stay in the workspace until removed explicitly. */
  unavailable: UnavailableProject[];
  /** Every saved path, opened or not, in the saved order. */
  order: string[];
  /** The project that was in front last time, even when it is one of the unavailable ones. */
  activePath?: string;
};

export type ProjectRetryResult = { project: RepoSnapshot } | { unavailable: UnavailableProject };

/**
 * How sure GitCat is that a replacement folder holds the same repository: the same first commit or
 * remote ("same"), nothing saved to compare with ("unverified"), or clearly another one ("different").
 */
export type RepositoryMatch = "same" | "unverified" | "different";

export type ProjectLocateResult =
  | { status: "canceled" }
  /** The chosen folder could not be used; nothing was changed. */
  | { status: "invalid"; path: string; reason: ProjectUnavailableReason; detail?: string }
  /** The folder is a repository GitCat cannot vouch for; it is only used after the person confirms. */
  | { status: "confirm"; candidateId: string; path: string; name: string; match: Exclude<RepositoryMatch, "same"> }
  | { status: "relocated"; previousPath: string; project: RepoSnapshot; match: RepositoryMatch; carriedOver: boolean };

/** Something people usually leave out of a first save, found in the folder. Only ever shown, never written. */
export type GitignoreSuggestion = {
  pattern: string;
  kind: "dependencies" | "system_files" | "secrets" | "python_cache" | "virtualenv" | "logs" | "build_output" | "editor";
  /** How many of the files that would be listed match it. */
  files: number;
};

/** Why an ordinary folder cannot become a project as it is. */
export type FolderBlock = "protected" | "broken_repository";

/** What starting to track an ordinary folder would do, read from the folder before anything is written. */
export type FolderPreview = {
  path: string;
  name: string;
  /** Files that would be listed as ready for the first save, after the folder's own .gitignore. Undefined when counting took too long. */
  files?: number;
  /** The count stopped at a limit; there are at least this many. */
  filesCapped: boolean;
  /** The name the first branch will get: the person's init.defaultBranch, or main. */
  branch: string;
  hasGitignore: boolean;
  suggestions: GitignoreSuggestion[];
  blocked?: FolderBlock;
};

/** Why a chosen folder could not be looked at. Nothing was changed in any of these cases. */
export type FolderProblem = "missing" | "not_folder" | "permission" | "tool";

/**
 * What choosing a folder led to. A folder that is not a repository, or sits inside another one, is
 * explained and waits for the person's choice; the id is the main process's record of that folder.
 */
export type ProjectSelectResult =
  | { status: "canceled" }
  | { status: "opened"; project: RepoSnapshot; alreadyTracked?: boolean }
  | { status: "not_repository"; setupId: string; preview: FolderPreview; intent: "open" | "track" }
  | { status: "inside_repository"; setupId: string; path: string; root: string; rootName: string }
  | { status: "invalid"; path: string; problem: FolderProblem; detail?: string };

export type StartTrackingResult =
  | { status: "started"; project: RepoSnapshot }
  /** The folder changed while the preview was on screen; this is what it looks like now. Nothing was written. */
  | { status: "changed"; result: ProjectSelectResult }
  | { status: "failed"; detail: string; cleaned: boolean };

/** Why an address cannot be cloned from. Checked on this computer before Git is ever run. */
export type CloneUrlProblem = "empty" | "too_long" | "spaces" | "option" | "local" | "transport_helper" | "insecure" | "credentials" | "unsupported" | "malformed";

export type CloneDestinationProblem = "name_invalid" | "parent_missing" | "parent_not_writable" | "destination_not_empty" | "destination_is_file";

export type CloneProblem = CloneUrlProblem | CloneDestinationProblem;

export type ClonePreview =
  | {
    ok: true;
    url: string;
    host: string;
    /** "local" is only reachable from the service's test option; the interface never accepts a local path. */
    protocol: "https" | "ssh" | "local";
    parent: string;
    name: string;
    destination: string;
    /** "new": GitCat creates the folder. "empty": an empty folder of that name is already there and will be filled. */
    destinationState: "new" | "empty";
    /** The destination is inside another repository, which will see the clone as a folder of its own. */
    insideRepository?: string;
  }
  | { ok: false; problem: CloneProblem; detail?: string };

export type CloneFailureReason = "auth" | "not_found" | "network" | "host_key" | "timeout" | "destination" | "tool" | "unknown";

export type CloneResult =
  | { status: "cloned"; project: RepoSnapshot; empty: boolean }
  /** The copy was stopped on request. `cleaned` says whether the partial copy GitCat created was removed. */
  | { status: "cancelled"; cleaned: boolean; leftAt?: string }
  | { status: "failed"; reason: CloneFailureReason; detail: string; cleaned: boolean; leftAt?: string }
  | { status: "invalid"; problem: CloneProblem; detail?: string };

export type CloneParentResult = { status: "canceled" } | { status: "chosen"; parentId: string; path: string };

export type GitlineApi = {
  platform: NodeJS.Platform;
  /** Opens the folder picker. `track` is the "start tracking a folder" entry: an existing repository is simply opened. */
  selectProject: (intent?: "open" | "track", labels?: { title: string; button: string }) => Promise<ProjectSelectResult>;
  /** Runs the start-tracking preview the person confirmed, after checking the folder again. */
  startTracking: (setupId: string) => Promise<StartTrackingResult>;
  /** Opens the repository around a folder that was picked inside it. */
  openParentProject: (setupId: string) => Promise<ProjectSelectResult>;
  chooseCloneParent: (labels: { title: string; button: string }) => Promise<CloneParentResult>;
  previewClone: (url: string, parentId: string, name: string) => Promise<ClonePreview>;
  startClone: (url: string, parentId: string, name: string) => Promise<CloneResult>;
  onCloneProgress: (listener: (progress: { phase: string; percent: number }) => void) => () => void;
  cancelClone: () => Promise<boolean>;
  restoreWorkspace: () => Promise<RestoredWorkspace>;
  saveWorkspace: (paths: string[], activePath?: string) => Promise<void>;
  retryProject: (path: string) => Promise<ProjectRetryResult>;
  locateProject: (path: string, labels: { title: string; button: string }) => Promise<ProjectLocateResult>;
  confirmLocateProject: (candidateId: string) => Promise<ProjectLocateResult>;
  openWorktree: (path: string, target: string, locale?: Locale) => Promise<RepoSnapshot>;
  getSnapshot: (path: string) => Promise<RepoSnapshot>;
  fetchRemotes: (path: string) => Promise<RepoSnapshot>;
  loadHistory: (path: string, request: HistoryRequest) => Promise<HistoryPage>;
  getCommitDetail: (path: string, hash: string) => Promise<CommitDetail>;
  getCommitFileDiff: (path: string, hash: string, file: string) => Promise<CommitDetail>;
  proposeConflictResolution: (path: string, locale?: Locale) => Promise<ConflictProposal>;
  applyConflictResolution: (path: string, proposalId: string, accepted: string[], locale?: Locale) => Promise<ConflictApplyResult>;
  /** Every open conflict explained from the repository alone. Never contacts the assistant. */
  describeConflicts: (path: string, locale?: Locale) => Promise<ConflictGuide>;
  /** Applies explicit per-file choices, bound to the guide they were made in. */
  chooseConflictResolutions: (path: string, guideId: string, choices: ConflictChoiceRequest[], locale?: Locale) => Promise<ConflictChoiceResult>;
  /**
   * Opens one conflicted file in the app the system uses for it, or only shows it in its folder when
   * opening would run it (a script or an installer).
   */
  openConflictFile: (path: string, file: string, locale?: Locale) => Promise<"opened" | "revealed">;
  planRecovery: (path: string, failure: ExecutionFailure, context?: ConversationMessage[], locale?: Locale) => Promise<ActionPlan>;
  /** Explains a failure from facts alone. Never contacts the assistant. */
  describeFailure: (path: string, failure: ExecutionFailure) => Promise<RecoveryReport>;
  /** Prepares, against a fresh read, only the steps of a stopped plan that never completed. */
  prepareRetry: (path: string, planId: string, locale?: Locale) => Promise<ActionPlan>;
  getWorkingFileDiff: (path: string, file: string) => Promise<CommitDetail>;
  planAction: (path: string, request: string, context?: ConversationMessage[], locale?: Locale) => Promise<ActionPlan>;
  prepareOperation: (path: string, operation: Operation, args?: Record<string, string>, locale?: Locale) => Promise<ActionPlan>;
  prepareBranchDelivery: (path: string, request: DeliveryRequest, locale?: Locale) => Promise<ActionPlan>;
  prepareMergeToDefault: (path: string, branch: string, locale?: Locale) => Promise<ActionPlan>;
  generateCommitDescription: (path: string, locale?: Locale, paths?: string[]) => Promise<CommitDescriptionResult>;
  /** Exactly what a save of these files would record, against the last saved version. */
  getSelectionDiff: (path: string, paths: string[], locale?: Locale) => Promise<CommitDetail>;
  createPractice: ()=>Promise<RepoSnapshot>;
  getPracticeInfo: (path:string)=>Promise<PracticeInfo|null>;
  setPracticeLesson: (path:string,lesson:number)=>Promise<PracticeInfo>;
  editPractice: (path:string)=>Promise<RepoSnapshot>;
  removePractice: (path:string)=>Promise<void>;
  previewReview: (path:string, request:ShareReviewRequest)=>Promise<ShareReviewPreview>;
  publishReview: (path:string,id:string)=>Promise<{snapshot:RepoSnapshot;pullRequest:ReviewPullRequest}>;
  openReview: (url:string)=>Promise<void>;
  getSwitchWork: (path: string, target: string) => Promise<SwitchWorkPreview>;
  prepareSwitchWork: (path: string, request: SwitchWorkRequest, locale?: Locale) => Promise<ActionPlan>;
  getActivityHistory: (path: string) => Promise<{ retentionDays: number; entries: ActivityRecord[] }>;
  setActivityRetention: (days: number) => Promise<void>;
  clearActivityHistory: (path: string) => Promise<void>;
  prepareHistoryRecovery: (path: string, id: string, mode: HistoryRecovery['mode'], locale?: Locale) => Promise<ActionPlan>;
  onOperationProgress: (listener: (progress: OperationProgress) => void) => () => void;
  listOperations: () => Promise<OperationProgress[]>;
  cancelOperation: (path: string, id: string) => Promise<boolean>;
  executePlan: (path: string, planId: string, locale?: Locale) => Promise<ExecutionResult>;
  /** What a request to the assistant would send from this repository, and whether sharing was agreed. */
  getAiSharing: (path: string, purpose: AiSharingPurpose, paths?: string[], locale?: Locale) => Promise<AiSharingPreview>;
  acknowledgeAiSharing: (path: string) => Promise<void>;
  setAiSharingExclusions: (path: string, exclusions: string[], locale?: Locale) => Promise<string[]>;
  /** Shares one flagged file at its current version after the person reviewed it, or stops sharing it. */
  setAiSharingReview: (path: string, file: string, share: boolean, locale?: Locale) => Promise<void>;
  getLlmConfig: () => Promise<LlmConfig>;
  /** Verifies the key and model with the provider and saves them only when they answer. */
  saveLlmConfig: (config: LlmConfigInput) => Promise<LlmConnectResult>;
  /** Checks the saved key and model again, without changing them. */
  verifyLlmConfig: () => Promise<LlmConnectResult>;
  openProviderPage: (page: ProviderPage) => Promise<void>;
  /** Reads what Git needs to save and publish, without a repository or for the open one. Never changes configuration. */
  checkReadiness: (path: string | undefined, request?: ReadinessRequest) => Promise<ReadinessReport>;
  openHelpPage: (page: HelpPage) => Promise<void>;
};

/** Facts emitted by the main process. Percentages are never inferred from elapsed time. */
export type OperationProgress = {
  id: string; repoPath: string; startedAt: number;
  phase: 'planning' | 'fetching' | 'executing' | 'inspecting' | 'provider';
  state: 'running' | 'completed' | 'failed' | 'stopped';
  mutation: boolean; stopping: boolean; step?: number; total?: number;
};

export type ActivityRecord = {
  id: string; repoPath: string; startedAt: string; finishedAt?: string;
  state: 'running' | 'completed' | 'failed';
  before: { head: string; branch: string }; after?: { head: string; branch: string };
  steps: { operation: Operation | 'pull_request'; status: 'pending' | StepOutcome['status']; beforeHead?: string; afterHead?: string; at?: string }[];
  error?: string;
};
export type HistoryRecovery = { mode: 'revert' | 'undo' | 'restore'; commit: string; branch?: string };

export type SwitchWorkRequest = { mode: 'carry' | 'set_aside' | 'restore'; target?: string; label?: string; includeUntracked?: boolean; stash?: string };
export type SwitchWorkPreview = { snapshot: RepoSnapshot; target: string; occupied?: string; blockers: string[]; entries: { hash: string; label: string }[] };

export type ShareReviewRequest = { remote:string;head:string;base:string;title:string;body:string };
export type ReviewPullRequest = {url:string;state:'OPEN'|'CLOSED'|'MERGED';head:string;base:string};
export type ShareReviewPreview = {id:string;repoPath:string;request:ShareReviewRequest;headHash:string;baseHash:string;publishedHash?:string;repository:string;remoteUrl:string;account:string;commits:{hash:string;subject:string}[];existing?:ReviewPullRequest;reviewable:boolean;checkedAt:string};

export type PracticeInfo={id:string;path:string;lesson:number};
