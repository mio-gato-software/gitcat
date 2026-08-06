export type Branch = {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  isCurrent: boolean;
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

export type ActionPlan = {
  id: string;
  repoPath: string;
  head: string;
  stateId: string;
  allowed: boolean;
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
