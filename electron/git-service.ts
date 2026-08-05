import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { safeStorage, app } from "electron";
import type { ActionPlan, Branch, Commit, LlmConfig, LlmConfigInput, Operation, RepoSnapshot } from "../shared/types.js";

type CommandResult = { stdout: string; stderr: string; code: number };
type PlanDraft = Omit<ActionPlan, "id" | "repoPath" | "head" | "stateId">;

const MODEL_FALLBACK = "luna";
const branchNamePattern = /^[A-Za-z0-9._/@-]+$/;
const allowedOperations = new Set<Operation>([
  "status", "checkout", "create_branch", "delete_branch", "fetch", "pull", "push",
  "merge", "rebase", "abort_rebase", "continue_rebase", "commit", "none"
]);

let llmState: LlmConfigInput = { apiKey: "", model: MODEL_FALLBACK };

function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (!settled) {
        settled = true;
        reject(new Error(`git ${args[0] ?? ""} excedió el tiempo máximo de espera.`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2_000_000) stderr += chunk.toString(); });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ stdout, stderr, code: code ?? 1 }); }
    });
  });
}

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} terminó con código ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
}

async function optionalGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  return result.code === 0 ? result.stdout.trim() : "";
}

function parseStatus(raw: string) {
  const records = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2).trim() || "??";
    changes.push({ code, path: record.slice(3) || record });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return changes;
}

function parseTrack(track: string) {
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}

function parseCommit(raw: string): Commit | undefined {
  const [hash, shortHash, author, email, date, subject, refs = ""] = raw.split("\x1f");
  if (!hash || !shortHash) return undefined;
  return { hash, shortHash, subject, author, email, date, refs: refs.split(",").map((ref) => ref.trim()).filter(Boolean) };
}

export async function getSnapshot(cwd: string): Promise<RepoSnapshot> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const head = await optionalGit(repoRoot, ["rev-parse", "HEAD"]);
  const currentBranch = (await optionalGit(repoRoot, ["branch", "--show-current"])) || "HEAD";
  const statusRaw = await checkedGit(repoRoot, ["status", "--short", "-z"]);
  const branchRaw = await checkedGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)%00%(authorname)%00%(authoremail)%00%(authordate:iso-strict)",
    "refs/heads"
  ]);
  const logRaw = head ? await checkedGit(repoRoot, [
    "log", "--all", "-n", "80", "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D"
  ]) : "";
  const commits = logRaw.split("\n").map(parseCommit).filter((commit): commit is Commit => Boolean(commit));
  const commitsByHash = new Map(commits.map((commit) => [commit.shortHash, commit]));
  const branches: Branch[] = branchRaw.split("\n").filter(Boolean).map((line) => {
    const [name, upstream, track, shortHash, subject, author, email, date] = line.split("\0");
    return {
      name,
      upstream: upstream || undefined,
      ...parseTrack(track || ""),
      isCurrent: name === currentBranch,
      lastCommit: shortHash ? (commitsByHash.get(shortHash) ?? {
        hash: shortHash, shortHash, subject, author, email, date, refs: []
      }) : undefined
    };
  });
  const gitDir = await optionalGit(repoRoot, ["rev-parse", "--git-dir"]);
  const rebaseMerge = await optionalGit(repoRoot, ["rev-parse", "--git-path", "rebase-merge"]);
  const rebaseApply = await optionalGit(repoRoot, ["rev-parse", "--git-path", "rebase-apply"]);
  const isRebasing = Boolean(gitDir && ((rebaseMerge && existsSync(resolve(repoRoot, rebaseMerge))) || (rebaseApply && existsSync(resolve(repoRoot, rebaseApply)))));
  const remotes = (await checkedGit(repoRoot, ["remote"])).split("\n").filter(Boolean);

  return {
    path: repoRoot,
    name: basename(repoRoot),
    head,
    stateId: createHash("sha256").update(`${head}\0${statusRaw}`).digest("hex"),
    currentBranch,
    isRebasing,
    isDirty: Boolean(statusRaw.trim()),
    changes: parseStatus(statusRaw),
    branches,
    commits,
    remotes
  };
}

function isBranchNameSafe(name: string) {
  return Boolean(name) && branchNamePattern.test(name) && !name.includes("..") && !name.includes("@{") &&
    !name.startsWith("-") && !name.startsWith(".") && !name.startsWith("/") && !name.endsWith("/") &&
    !name.endsWith(".") && !name.includes("//") && !name.includes("/.") && !name.endsWith(".lock");
}

function refused(reason: string, source: ActionPlan["source"] = "guardrail"): PlanDraft {
  return {
    allowed: false, operation: "none", args: {}, command: "—", summary: "Solicitud rechazada",
    rationale: reason, risk: "low", requiresConfirmation: false, source
  };
}

function localPlan(request: string, snapshot: RepoSnapshot): PlanDraft {
  const text = request.trim();
  const lower = text.toLocaleLowerCase("es");
  if (!isGitRequest(lower)) return refused("Solo puedo ayudarte con ramas, historial, cambios y operaciones Git.");

  const make = (operation: Operation, args: Record<string, string>, summary: string, rationale: string, risk: ActionPlan["risk"] = "low"): PlanDraft => ({
    allowed: true, operation, args, command: buildCommand(operation, args), summary, rationale, risk,
    requiresConfirmation: ["rebase", "merge", "delete_branch", "push", "pull", "commit", "create_branch"].includes(operation),
    source: "local-fallback"
  });

  if (/abortar|cancelar.*rebase|rebase.*cancelar/i.test(lower)) return make("abort_rebase", {}, "Abortar el rebase en curso", "Restaurar el estado previo al rebase.", "high");
  if (/continuar.*rebase|resolver.*conflicto/i.test(lower)) return make("continue_rebase", {}, "Continuar el rebase", "Git continuará después de resolver los conflictos.", "high");

  const rebaseTarget = text.match(/rebase(?:ar)?\s+(?:mi\s+)?(?:la\s+)?(?:rama\s+)?(?:sobre|en|a|onto)\s+([A-Za-z0-9._/@-]+)/i)?.[1]
    ?? text.match(/rebase(?:ar)?\s+([A-Za-z0-9._/@-]+)/i)?.[1];
  if (rebaseTarget) return isBranchNameSafe(rebaseTarget)
    ? make("rebase", { onto: rebaseTarget }, `Rebase de ${snapshot.currentBranch} sobre ${rebaseTarget}`, "Se reescribe la base de la rama actual.", "high")
    : refused("El nombre de la rama de destino no es válido.", "local-fallback");

  const create = text.match(/(?:crear|nueva|nuevo)\s+(?:la\s+)?rama\s+([A-Za-z0-9._/@-]+)/i)?.[1];
  if (create) return isBranchNameSafe(create) ? make("create_branch", { name: create }, `Crear y cambiar a ${create}`, "Crea una rama local desde HEAD.", "medium") : refused("El nombre de la rama no es válido.", "local-fallback");
  const remove = text.match(/(?:borrar|eliminar)\s+(?:la\s+)?rama\s+([A-Za-z0-9._/@-]+)/i)?.[1];
  if (remove) return isBranchNameSafe(remove) ? make("delete_branch", { name: remove }, `Eliminar la rama ${remove}`, "Elimina una rama local ya integrada.", "high") : refused("El nombre de la rama no es válido.", "local-fallback");
  const checkout = text.match(/(?:cambiar(?:me)?|cámbiame|checkout|ir)\s+(?:a\s+)?(?:la\s+)?rama\s+([A-Za-z0-9._/@-]+)/i)?.[1];
  if (checkout) return isBranchNameSafe(checkout) ? make("checkout", { name: checkout }, `Cambiar a ${checkout}`, "Cambia la rama activa sin borrar cambios locales.", "medium") : refused("El nombre de la rama no es válido.", "local-fallback");
  const merge = text.match(/(?:merge|fusionar|mezclar)\s+(?:la\s+)?rama?\s*([A-Za-z0-9._/@-]+)/i)?.[1];
  if (merge) return isBranchNameSafe(merge) ? make("merge", { name: merge }, `Fusionar ${merge}`, "Integra sus commits en la rama actual.", "high") : refused("El nombre de la rama no es válido.", "local-fallback");
  if (/\bfetch\b|actualizar referencias|traer cambios/i.test(lower)) return make("fetch", {}, "Actualizar referencias remotas", "Descarga referencias y elimina remotas obsoletas.");
  if (/\bpull\b|bajar cambios|sincronizar/i.test(lower)) return make("pull", {}, "Actualizar la rama actual", "Usa pull --ff-only para no crear merges implícitos.", "high");
  if (/\bpush\b|subir cambios|publicar/i.test(lower)) return make("push", {}, "Publicar la rama actual", "Envía los commits al remoto configurado.", "high");
  if (/mostrar detalles|ver detalles|detalles del commit|quién hizo cambios/i.test(lower)) return make("status", {}, "Actualizar la vista del repositorio", "Leeré el estado y el historial sin modificar archivos.");
  if (/\bcommit\b|guardar cambios/i.test(lower)) {
    const message = text.match(/(?:commit|guardar cambios)(?:\s+con\s+mensaje)?\s*[:\-]?\s*["“]?(.+?)["”]?$/i)?.[1]?.trim();
    return message ? make("commit", { message }, `Crear commit “${message}”`, "Añade todos los cambios y crea un commit.", "high") : refused("Indica el mensaje del commit para poder prepararlo.", "local-fallback");
  }
  if (/estado|status|cambios|historial|quién|autor|rama actual|log/i.test(lower)) return make("status", {}, "Actualizar la vista del repositorio", "Leeré el estado y el historial sin modificar archivos.");
  return refused("Entendí que se relaciona con Git, pero no pude convertirlo en una operación segura.", "local-fallback");
}

function buildCommand(operation: Operation, args: Record<string, string>) {
  switch (operation) {
    case "checkout": return `git switch ${args.name}`;
    case "create_branch": return `git switch -c ${args.name}`;
    case "delete_branch": return `git branch -d ${args.name}`;
    case "fetch": return "git fetch --prune";
    case "pull": return "git pull --ff-only";
    case "push": return "git push";
    case "merge": return `git merge --no-edit ${args.name}`;
    case "rebase": return `git rebase ${args.onto}`;
    case "abort_rebase": return "git rebase --abort";
    case "continue_rebase": return "git rebase --continue";
    case "commit": return `git add -A && git commit -m "${args.message ?? ""}"`;
    case "status": return "git status";
    default: return "—";
  }
}

function extractOutputText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text;
  const textParts: string[] = [];
  for (const item of body?.output ?? []) {
    for (const content of item?.content ?? []) if (typeof content?.text === "string") textParts.push(content.text);
  }
  return textParts.join("\n").trim();
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function planFromModel(value: Record<string, unknown>, source: "llm"): PlanDraft {
  const operation = typeof value.operation === "string" && allowedOperations.has(value.operation as Operation) ? value.operation as Operation : "none";
  const rawArgs = value.args && typeof value.args === "object" ? value.args as Record<string, unknown> : {};
  const args = Object.fromEntries(Object.entries(rawArgs).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  const branchArg = args.name || args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) return refused("El modelo propuso un nombre de rama no válido.", source);
  if (operation === "commit" && (!args.message || args.message.length > 120)) return refused("El mensaje de commit falta o es demasiado largo.", source);
  if (value.allowed !== true || operation === "none") return refused("Solo puedo ayudarte con ramas, historial, cambios y operaciones Git.", source);
  return { ...operationDraft(operation, args), source };
}

async function llmPlan(request: string, snapshot: RepoSnapshot): Promise<PlanDraft> {
  const instructions = `Eres el planificador seguro de Branchline, una aplicación de escritorio para ramas Git.
Solo atiendes operaciones relacionadas con Git, ramas, commits, cambios, historial, remotos, conflictos y rebase. Para cualquier otra pregunta debes rechazarla.
No ejecutes nada y no inventes comandos. Responde SOLO un JSON válido con estas claves: allowed (boolean), operation (status|checkout|create_branch|delete_branch|fetch|pull|push|merge|rebase|abort_rebase|continue_rebase|commit|none), args (objeto), summary, rationale y risk (low|medium|high).
No propongas comandos de shell libres. Para nombres de rama usa args.name o args.onto; para commit usa args.message.
Estado actual: rama=${snapshot.currentBranch}, ramas=${snapshot.branches.map((branch) => branch.name).join(", ") || "ninguna"}, cambios=${snapshot.changes.length}, rebaseEnCurso=${snapshot.isRebasing}.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmState.apiKey}` },
      body: JSON.stringify({ model: llmState.model || MODEL_FALLBACK, instructions, input: request, max_output_tokens: 500, store: false }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  const text = extractOutputText(body);
  const parsed = parseJsonObject(text);
  return parsed ? planFromModel(parsed, "llm") : refused("El proveedor no devolvió un plan JSON válido.", "llm");
}

function bindPlan(snapshot: RepoSnapshot, draft: PlanDraft): ActionPlan {
  return { ...draft, id: randomUUID(), repoPath: snapshot.path, head: snapshot.head, stateId: snapshot.stateId };
}

function isGitRequest(request: string) {
  return /git|rama|branch|rebase|merge|commit|cambio|estado|historial|remoto|pull|push|fetch|checkout|conflicto|autor|staged|diff|sincron/i.test(request);
}

export async function planAction(cwd: string, request: string): Promise<ActionPlan> {
  const snapshot = await getSnapshot(cwd);
  if (!request.trim()) return bindPlan(snapshot, refused("Escribe una acción relacionada con la rama o el repositorio."));
  if (!isGitRequest(request)) return bindPlan(snapshot, refused("Solo puedo ayudarte con ramas, historial, cambios y operaciones Git."));
  if (!llmState.apiKey.trim()) return bindPlan(snapshot, localPlan(request, snapshot));
  try {
    return bindPlan(snapshot, await llmPlan(request, snapshot));
  } catch (error) {
    return bindPlan(snapshot, refused(`No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, "llm"));
  }
}

function operationDraft(operation: Operation, args: Record<string, string>): PlanDraft {
  const details: Partial<Record<Operation, [string, string, ActionPlan["risk"]]>> = {
    status: ["Actualizar la vista del repositorio", "Lee el estado actual sin modificar archivos.", "low"],
    checkout: [`Cambiar a ${args.name}`, "Cambia la rama activa conservando los cambios locales compatibles.", "medium"],
    create_branch: [`Crear y cambiar a ${args.name}`, "Crea una rama local desde HEAD.", "medium"],
    delete_branch: [`Eliminar la rama ${args.name}`, "Elimina una rama local ya integrada.", "high"],
    fetch: ["Actualizar referencias remotas", "Descarga referencias y elimina remotas obsoletas.", "low"],
    pull: ["Actualizar la rama actual", "Usa pull --ff-only para evitar merges implícitos.", "high"],
    push: ["Publicar la rama actual", "Envía los commits al upstream configurado.", "high"],
    merge: [`Fusionar ${args.name}`, "Integra la rama seleccionada en la rama actual.", "high"],
    rebase: [`Rebase sobre ${args.onto}`, "Reescribe la base de la rama actual.", "high"],
    abort_rebase: ["Abortar el rebase", "Restaura el estado anterior al rebase.", "high"],
    continue_rebase: ["Continuar el rebase", "Continúa después de resolver los conflictos.", "high"],
    commit: [`Crear commit “${args.message ?? ""}”`, "Añade todos los cambios y crea un commit.", "high"]
  };
  const detail = details[operation];
  if (!detail || operation === "none") return refused("La operación solicitada no está permitida.");
  return {
    allowed: true,
    operation,
    args,
    command: buildCommand(operation, args),
    summary: detail[0],
    rationale: detail[1],
    risk: detail[2],
    requiresConfirmation: !["status", "fetch"].includes(operation),
    source: "local-fallback"
  };
}

export async function prepareOperation(cwd: string, operation: Operation, args: Record<string, string> = {}) {
  const snapshot = await getSnapshot(cwd);
  const draft = operationDraft(operation, args);
  if (draft.allowed) validateExecution(bindPlan(snapshot, draft), snapshot);
  return bindPlan(snapshot, draft);
}

function validateExecution(plan: ActionPlan, snapshot: RepoSnapshot) {
  if (!plan.allowed || plan.operation === "none" || !allowedOperations.has(plan.operation)) throw new Error("La acción no está permitida.");
  const branchArg = plan.args.name || plan.args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) throw new Error("Nombre de rama no válido.");
  if (plan.repoPath !== snapshot.path) throw new Error("El plan pertenece a otro repositorio.");
  if (plan.head !== snapshot.head) throw new Error("El repositorio cambió desde que se preparó el plan. Prepara la acción de nuevo.");
  if (plan.stateId !== snapshot.stateId) throw new Error("Los cambios locales variaron desde que se preparó el plan. Prepara la acción de nuevo.");
  if (["checkout", "create_branch", "delete_branch", "merge"].includes(plan.operation) && !plan.args.name) throw new Error("Falta el nombre de la rama.");
  if (plan.operation === "rebase" && !plan.args.onto) throw new Error("Falta la rama base.");
  if (plan.operation === "commit" && (!plan.args.message?.trim() || plan.args.message.length > 120)) throw new Error("El mensaje de commit no es válido.");
  if (plan.operation === "checkout" && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "create_branch" && snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} ya existe.`);
  if (plan.operation === "delete_branch" && plan.args.name === snapshot.currentBranch) throw new Error("No puedes borrar la rama activa.");
  if (["delete_branch", "merge"].includes(plan.operation) && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "rebase" && !snapshot.branches.some((branch) => branch.name === plan.args.onto)) throw new Error(`La rama base ${plan.args.onto} no existe localmente.`);
  if (["abort_rebase", "continue_rebase"].includes(plan.operation) && !snapshot.isRebasing) throw new Error("No hay un rebase en curso.");
}

export async function executePlan(cwd: string, plan: ActionPlan) {
  const snapshot = await getSnapshot(cwd);
  validateExecution(plan, snapshot);
  let output = "";
  try {
    switch (plan.operation) {
      case "status": break;
      case "checkout": output = await checkedGit(cwd, ["switch", plan.args.name]); break;
      case "create_branch": output = await checkedGit(cwd, ["switch", "-c", plan.args.name]); break;
      case "delete_branch": output = await checkedGit(cwd, ["branch", "-d", "--", plan.args.name]); break;
      case "fetch": output = await checkedGit(cwd, ["fetch", "--prune"]); break;
      case "pull": output = await checkedGit(cwd, ["pull", "--ff-only"]); break;
      case "push": output = await checkedGit(cwd, ["push"]); break;
      case "merge": output = await checkedGit(cwd, ["merge", "--no-edit", "--", plan.args.name]); break;
      case "rebase": output = await checkedGit(cwd, ["rebase", plan.args.onto]); break;
      case "abort_rebase": output = await checkedGit(cwd, ["rebase", "--abort"]); break;
      case "continue_rebase": output = await checkedGit(cwd, ["rebase", "--continue"]); break;
      case "commit":
        await checkedGit(cwd, ["add", "-A"]);
        output = await checkedGit(cwd, ["commit", "-m", plan.args.message]);
        break;
    }
    return { snapshot: await getSnapshot(cwd), output };
  } catch (error) {
    return {
      snapshot: await getSnapshot(cwd),
      output,
      error: error instanceof Error ? error.message : "Git no pudo completar la acción."
    };
  }
}

function settingsPath() { return join(app.getPath("userData"), "branchline-settings.json"); }

export function loadLlmConfig() {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), "utf8")) as { model?: string; encryptedApiKey?: string };
    llmState.model = saved.model || MODEL_FALLBACK;
    if (saved.encryptedApiKey && safeStorage.isEncryptionAvailable()) llmState.apiKey = safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, "base64"));
  } catch { /* first launch */ }
}

export function getLlmConfig(): LlmConfig {
  return { provider: "openai", model: llmState.model || MODEL_FALLBACK, configured: Boolean(llmState.apiKey) };
}

export function saveLlmConfig(input: LlmConfigInput): LlmConfig {
  if (!input || typeof input.apiKey !== "string" || typeof input.model !== "string") throw new Error("La configuración no es válida.");
  const nextApiKey = input.clearApiKey ? "" : input.apiKey.trim() || llmState.apiKey;
  if (nextApiKey && !safeStorage.isEncryptionAvailable()) throw new Error("El almacenamiento seguro no está disponible; la API key no se guardó.");
  llmState = { apiKey: nextApiKey, model: input.model.trim() || MODEL_FALLBACK };
  mkdirSync(app.getPath("userData"), { recursive: true });
  const payload: { model: string; encryptedApiKey?: string } = { model: llmState.model };
  if (llmState.apiKey && safeStorage.isEncryptionAvailable()) payload.encryptedApiKey = safeStorage.encryptString(llmState.apiKey).toString("base64");
  writeFileSync(settingsPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  return getLlmConfig();
}
