import type { Operation } from "../shared/types.js";
import { isBranchNameSafe } from "./branch-operation.js";
import { remoteNamePattern } from "./repository-plan.js";

export type AssistantCommand =
  | { operation: Exclude<Operation, "git_command">; args: Record<string, string> }
  | { operation: "git_command"; argv: string[] };

const revisionOptions = ["--all", "--branches", "--tags", "--remotes", "--not", "--first-parent", "--ancestry-path", "--reverse", "--topo-order", "--date-order"];
const diffOptions = ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--patch", "-p", "--no-patch"];
const historyOptions = [...revisionOptions, ...diffOptions, "--graph", "--oneline", "--decorate", "--no-decorate", "--follow", "--merges", "--no-merges"];
const queryOptions = new Map<string, { flags: readonly string[]; values?: RegExp }>([
  ["log", { flags: historyOptions, values: /^(?:--(?:format|pretty|date|author|grep|since|until|diff-filter|find-renames)=.+|--(?:skip|max-count)=\d+|-\d+)$/s }],
  ["show", { flags: [...diffOptions, "--oneline", "--no-color"], values: /^--(?:format|pretty|date)=.+$/s }],
  ["diff", { flags: [...diffOptions, "--cached", "--staged", "--no-color", "--no-renames", "--check", "--quiet", "--exit-code"], values: /^--unified=\d+$/ }],
  ["status", { flags: ["--short", "-s", "--branch", "-b", "--porcelain", "--no-ahead-behind", "--untracked-files=no", "--untracked-files=all"] }],
  ["blame", { flags: ["--line-porcelain", "--porcelain", "--show-email", "-e", "--root", "-w"], values: /^-L[\d,+-]+$/ }],
  ["ls-files", { flags: ["--cached", "--deleted", "--modified", "--others", "--exclude-standard", "--stage", "--unmerged"] }],
  ["rev-list", { flags: [...revisionOptions, "--count", "--left-right", "--merges", "--no-merges", "--min-parents=2", "--max-parents=1"], values: /^(?:--(?:skip|max-count)=\d+|-\d+)$/ }],
  ["grep", { flags: ["-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-l", "--files-with-matches", "--cached", "--count"] }]
]);

function localOperand(value: string) {
  return !value.startsWith(":(") && !/^:[!^]?[/\\]/.test(value)
    && !/^(?:[/\\]|[a-z]:)/i.test(value) && !/(?:^|[:/\\)!^])\.\.(?:[/\\]|$)/.test(value);
}

function queryFormatAllowed(option: string) {
  const [kind, ...parts] = option.split("=");
  if (kind !== "--format" && kind !== "--pretty") return true;
  const format = parts.join("=");
  if (kind === "--pretty" && /^(?:oneline|short|medium|full|fuller|reference)$/.test(format)) return true;
  // The model may select fields and punctuation, but cannot print its own claims through Git.
  return /^[\s<>()[\],.:|/-]*$/.test(format.replace(/^(?:t?format):/, "")
    .replace(/%(?:[ac][nNeEdDirsIt]|[HhTtPpsSbBDdfn])/g, ""));
}

/** Only built-in queries and actions that have a matching reviewed GitCat operation are accepted. */
export function parseAssistantCommand(argv: string[]): AssistantCommand | undefined {
  const [verb, ...parameters] = argv;
  if (!verb || argv.some(value => !value.trim() || value.includes("\0"))) return;
  const query = queryOptions.get(verb);
  if (query) {
    const separator = parameters.indexOf("--");
    const options = separator < 0 ? parameters : parameters.slice(0, separator);
    const paths = separator < 0 ? [] : parameters.slice(separator + 1);
    if (options.every(value => value.startsWith("-")
      ? (query.flags.includes(value) || query.values?.test(value)) && queryFormatAllowed(value) : localOperand(value))
        && paths.every(localOperand)) {
      return { operation: "git_command", argv };
    }
    return;
  }
  const [first, second, third] = parameters;
  if (verb === "push") {
    const noVerify = first === "--no-verify" ? { noVerify: "true" } : undefined;
    const operands = noVerify ? parameters.slice(1) : parameters;
    if (!operands.length) return { operation: "push", args: { ...noVerify } };
    if (operands.length === 3 && ["--set-upstream", "-u"].includes(operands[0])
        && remoteNamePattern.test(operands[1]) && isBranchNameSafe(operands[2])) {
      return { operation: "push", args: { ...noVerify, setUpstream: operands[1], branch: operands[2] } };
    }
    if (operands.length === 2 && remoteNamePattern.test(operands[0]) && isBranchNameSafe(operands[1])) {
      return { operation: "push", args: { ...noVerify, remote: operands[0], branch: operands[1] } };
    }
    return;
  }
  if ((verb === "switch" || verb === "checkout") && parameters.length === 1 && isBranchNameSafe(first)) {
    return { operation: "checkout", args: { name: first } };
  }
  if (((verb === "switch" && first === "-c") || (verb === "checkout" && first === "-b"))
      && parameters.length === 2 && isBranchNameSafe(second)) return { operation: "create_branch", args: { name: second } };
  if (verb === "branch" && ["-d", "--delete"].includes(first) && parameters.length === 2 && isBranchNameSafe(second)) {
    return { operation: "delete_branch", args: { name: second } };
  }
  if (verb === "branch" && first === "-m" && parameters.length === 3 && isBranchNameSafe(second) && isBranchNameSafe(third)) {
    return { operation: "rename_branch", args: { name: second, to: third } };
  }
  if (verb === "merge" && first === "--no-edit" && parameters.length === 2 && isBranchNameSafe(second)) {
    return { operation: "merge", args: { name: second } };
  }
  if ((verb === "merge" || verb === "rebase") && parameters.length === 1 && isBranchNameSafe(first)) {
    return verb === "merge" ? { operation: "merge", args: { name: first } } : { operation: "rebase", args: { onto: first } };
  }
  if (verb === "pull" && parameters.length === 1 && first === "--ff-only") return { operation: "pull", args: {} };
}

/** The application owns global Git options and disables optional writes and diff helpers for queries. */
export function assistantQueryArguments(argv: string[]) {
  const parsed = parseAssistantCommand(argv);
  if (parsed?.operation !== "git_command") throw new Error("The assistant query is not supported for this project.");
  const [verb, ...args] = parsed.argv;
  const diffOptions = ["diff", "show", "log"].includes(verb) ? ["--no-ext-diff", "--no-textconv"] : [];
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", verb, ...diffOptions, ...args];
}
