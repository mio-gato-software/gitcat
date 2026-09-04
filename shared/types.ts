/** Where the branch actually exists: only here, only on a remote, or on both. */
export type BranchPresence = "local" | "remote" | "both";
export type DefaultBranchSource = "remote_head" | "conventional_name";

export type Branch = {
  name: string;
  upstream?: string;
  /** The remote-tracking ref this branch corresponds to, such as "origin/main". */
  remoteRef?: string;
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
};

export type FileChange = {
  code: string;
  path: string;
  /** Where a renamed or copied file used to be. Absent for every other kind of change. */
  from?: string;
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

export type RepoSnapshot = {
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
  /** Against the first parent, which is what a merge commit actually brought in. */
  files: FileChange[];
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
  resolutions: ConflictResolution[];
  /** Files the model would not settle, each with its reason. Leaving one alone is a valid answer. */
  skipped: { path: string; reason: string }[];
  /** What each file looks like right now, so the interface can show the change rather than assert it. */
  current: Record<string, string>;
};

export type Operation =
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
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  /** "question" is the assistant asking for something, not a failure; the interface must not dress it as one. */
  kind: "plan" | "question" | "refusal";
  /** "llm": the model interpreted the request. "guardrail": a direct control or a local safety rule. */
  source: "llm" | "guardrail";
};

export type LlmConfig = {
  provider: "openai";
  model: string;
  configured: boolean;
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
};

export type ExecutionResult = {
  snapshot: RepoSnapshot;
  output: string;
  error?: string;
  /** What each step of the plan actually did, so a sequence that stops halfway is never reported as a success. */
  outcomes?: StepOutcome[];
};

export type CommitDescriptionResult = {
  description: string;
  stateId: string;
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type RestoredWorkspace = {
  projects: RepoSnapshot[];
  activePath?: string;
};

export type GitlineApi = {
  platform: NodeJS.Platform;
  selectProject: () => Promise<RepoSnapshot | null>;
  restoreWorkspace: () => Promise<RestoredWorkspace>;
  saveWorkspace: (paths: string[], activePath?: string) => Promise<void>;
  getSnapshot: (path: string) => Promise<RepoSnapshot>;
  loadHistory: (path: string, request: HistoryRequest) => Promise<HistoryPage>;
  getCommitDetail: (path: string, hash: string) => Promise<CommitDetail>;
  getCommitFileDiff: (path: string, hash: string, file: string) => Promise<CommitDetail>;
  proposeConflictResolution: (path: string, locale?: Locale) => Promise<ConflictProposal>;
  applyConflictResolution: (path: string, resolutions: ConflictResolution[], locale?: Locale) => Promise<RepoSnapshot>;
  planRecovery: (path: string, failure: ExecutionFailure, context?: ConversationMessage[], locale?: Locale) => Promise<ActionPlan>;
  getWorkingFileDiff: (path: string, file: string) => Promise<CommitDetail>;
  planAction: (path: string, request: string, context?: ConversationMessage[], locale?: Locale) => Promise<ActionPlan>;
  prepareOperation: (path: string, operation: Operation, args?: Record<string, string>, locale?: Locale) => Promise<ActionPlan>;
  prepareBranchDelivery: (path: string, request: { stateId: string; mergeToDefault: boolean; message?: string }, locale?: Locale) => Promise<ActionPlan>;
  prepareMergeToDefault: (path: string, branch: string, locale?: Locale) => Promise<ActionPlan>;
  generateCommitDescription: (path: string, locale?: Locale) => Promise<CommitDescriptionResult>;
  executePlan: (path: string, planId: string, locale?: Locale) => Promise<ExecutionResult>;
  getLlmConfig: () => Promise<LlmConfig>;
  saveLlmConfig: (config: LlmConfigInput) => Promise<LlmConfig>;
};
