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
  | "branch_last_author"
  | "none";

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
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  source: "llm" | "local-fallback" | "guardrail";
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

export type GitlineApi = {
  selectProject: () => Promise<RepoSnapshot | null>;
  getSnapshot: (path: string) => Promise<RepoSnapshot>;
  planAction: (path: string, request: string) => Promise<ActionPlan>;
  prepareOperation: (path: string, operation: Operation, args?: Record<string, string>) => Promise<ActionPlan>;
  executePlan: (path: string, planId: string) => Promise<ExecutionResult>;
  getLlmConfig: () => Promise<LlmConfig>;
  saveLlmConfig: (config: LlmConfigInput) => Promise<LlmConfig>;
};
