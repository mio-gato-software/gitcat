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
};

export type FileChange = {
  code: string;
  path: string;
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
  isRebasing: boolean;
  isDirty: boolean;
  changes: FileChange[];
  branches: Branch[];
  commits: Commit[];
  remotes: string[];
};

export type Operation =
  | "status"
  | "checkout"
  | "create_branch"
  | "delete_branch"
  | "fetch"
  | "pull"
  | "push"
  | "merge"
  | "rebase"
  | "abort_rebase"
  | "continue_rebase"
  | "commit"
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
  planAction: (path: string, request: string, context?: ConversationMessage[]) => Promise<ActionPlan>;
  prepareOperation: (path: string, operation: Operation, args?: Record<string, string>) => Promise<ActionPlan>;
  generateCommitDescription: (path: string) => Promise<CommitDescriptionResult>;
  executePlan: (path: string, planId: string) => Promise<ExecutionResult>;
  getLlmConfig: () => Promise<LlmConfig>;
  saveLlmConfig: (config: LlmConfigInput) => Promise<LlmConfig>;
};
