import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { safeStorage, app } from "electron";
import type { ActionPlan, Branch, Commit, ConversationMessage, LlmConfig, LlmConfigInput, Operation, RepoSnapshot } from "../shared/types.js";

type CommandResult = { stdout: string; stderr: string; code: number };
type PlanDraft = Omit<ActionPlan, "id" | "repoPath" | "head" | "stateId">;

const MODEL_FALLBACK = "luna";
const branchNamePattern = /^[A-Za-z0-9._/@-]+$/;
const allowedOperations = new Set<Operation>([
  "status", "checkout", "create_branch", "delete_branch", "fetch", "pull", "push",
  "merge", "rebase", "abort_rebase", "continue_rebase", "commit", "github_create_repo", "branch_last_author", "none"
]);
const githubNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubHostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let llmState: LlmConfigInput = { apiKey: "", model: MODEL_FALLBACK };

function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return runCommand("git", args, cwd, timeoutMs);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 60_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true", ...extraEnv },
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
        reject(new Error(`${command} ${args[0] ?? ""} excedió el tiempo máximo de espera.`));
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

function formatAnswerDate(date: string) {
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function localPlan(request: string, snapshot: RepoSnapshot): PlanDraft {
  const text = request.trim();
  const lower = text.toLocaleLowerCase("es");

  if (/(?:crear|crea|nuevo).*(?:repositorio|repo).*(?:github|privad)|(?:repositorio|repo).*(?:privad).*(?:crear|crea)/i.test(lower)) {
    const source = text.match(/(?:en|desde|source)\s+[`"“']?([^`"”'\s]+)[`"”']?/i)?.[1] ?? snapshot.path;
    const owner = text.match(/(?:propietario|owner|organizaci[oó]n|usuario)\s+[`"“']?([A-Za-z0-9-]+)[`"”']?/i)?.[1] ?? "";
    const host = text.match(/(?:host)\s+[`"“']?([A-Za-z0-9.-]+)[`"”']?/i)?.[1] ?? "";
    const remote = text.match(/(?:remoto|remote)\s+[`"“']?([A-Za-z0-9._-]+)[`"”']?/i)?.[1] ?? "origin";
    const push = /(?:sin\s+push|no\s+(?:publicar|subir))/i.test(lower) ? "false" : /(?:con\s+push|publicar|subir)/i.test(lower) ? "true" : "";
    return {
      allowed: true,
      operation: "github_create_repo",
      args: {
        source,
        name: basename(source),
        owner,
        host,
        visibility: "private",
        remote,
        push,
        replaceRemote: /(?:reemplazar|sobrescribir).*(?:remoto|remote)/i.test(lower) ? "true" : "false"
      },
      command: "—",
      summary: "Validar creación de repositorio GitHub privado",
      rationale: "Se comprobarán el origen local, gh, la autenticación, los permisos, el destino y los remotos antes de preparar un comando.",
      risk: "high",
      requiresConfirmation: true,
      source: "local-fallback"
    };
  }

  const make = (operation: Operation, args: Record<string, string>, summary: string, rationale: string, risk: ActionPlan["risk"] = "low"): PlanDraft => ({
    allowed: true, operation, args, command: buildCommand(operation, args), summary, rationale, risk,
    requiresConfirmation: ["rebase", "merge", "delete_branch", "push", "pull", "commit", "create_branch"].includes(operation),
    source: "local-fallback"
  });
  const makeInfo = (operation: Operation) => ({ ...operationDraft(operation, {}, snapshot), source: "local-fallback" as const });

  if (/(?:qui[eé]n|persona|autor).*(?:[uú]ltim|reciente|vez|trabaj)|(?:[uú]ltim|reciente).*(?:trabaj|commit|cambio|autor)/i.test(lower)) {
    return makeInfo("branch_last_author");
  }

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
    case "github_create_repo": {
      const flags = [`--${args.visibility}`, `--source ${JSON.stringify(args.source)}`, `--remote ${args.remote}`];
      if (args.push === "true") flags.push("--push");
      return `GH_HOST=${args.host} gh repo create ${args.owner}/${args.name} ${flags.join(" ")}`;
    }
    case "status": return "git status";
    default: return "—";
  }
}

function githubRefused(reason: string, source: ActionPlan["source"] = "guardrail"): PlanDraft {
  return {
    allowed: false,
    operation: "github_create_repo",
    args: {},
    command: "—",
    summary: "No se puede crear el repositorio privado",
    rationale: reason,
    risk: "high",
    requiresConfirmation: false,
    source
  };
}

function parseBoolean(value: string | undefined) { return value === "true"; }

async function checkedGh(args: string[], cwd: string, host?: string) {
  const result = await runCommand("gh", args, cwd, 60_000, {
    GH_PROMPT_DISABLED: "1",
    ...(host ? { GH_HOST: host } : {})
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `gh ${args[0] ?? ""} falló.`);
  return result.stdout.trim();
}

async function prepareGithubRepository(snapshot: RepoSnapshot, rawArgs: Record<string, string>, source: ActionPlan["source"]): Promise<PlanDraft> {
  let sourcePath: string;
  try {
    if (!rawArgs.source?.trim()) return githubRefused("Indica la ruta del repositorio Git local que quieres publicar.", source);
    sourcePath = realpathSync(resolve(rawArgs.source));
    if (!statSync(sourcePath).isDirectory()) return githubRefused("La ruta indicada no es un directorio.", source);
    accessSync(sourcePath, constants.R_OK | constants.W_OK);
  } catch {
    return githubRefused("La ruta no existe o no es accesible. Verifica la ruta y sus permisos.", source);
  }

  let sourceSnapshot: RepoSnapshot;
  try {
    sourceSnapshot = await getSnapshot(sourcePath);
  } catch {
    return githubRefused("La ruta no corresponde a un repositorio Git local. Abre o inicializa el repositorio primero; Branchline no lo inicializará sin una decisión explícita.", source);
  }
  if (sourceSnapshot.path !== sourcePath) return githubRefused(`La ruta pertenece al repositorio ${sourceSnapshot.path}. Usa la raíz exacta del repositorio como origen.`, source);
  if (sourceSnapshot.path !== snapshot.path) return githubRefused("Por seguridad, abre ese repositorio como proyecto activo en Branchline antes de publicarlo.", source);

  const name = rawArgs.name?.trim();
  const owner = rawArgs.owner?.trim();
  const host = rawArgs.host?.trim().toLocaleLowerCase();
  const visibility = rawArgs.visibility?.trim();
  const remote = rawArgs.remote?.trim() || "origin";
  const push = parseBoolean(rawArgs.push);
  const replaceRemote = parseBoolean(rawArgs.replaceRemote);
  if (!name || !githubNamePattern.test(name) || name === "." || name === ".." || name.endsWith(".git")) return githubRefused("El nombre del repositorio no es válido. Usa de 1 a 100 letras, números, puntos, guiones o guiones bajos, sin el sufijo .git.", source);
  if (!owner) return githubRefused("Indica explícitamente el propietario de GitHub (usuario u organización); no se asumirá uno.", source);
  if (!githubOwnerPattern.test(owner)) return githubRefused("El propietario de GitHub no es válido.", source);
  if (!host) return githubRefused("Indica explícitamente el host de GitHub, por ejemplo github.com.", source);
  if (!githubHostPattern.test(host)) return githubRefused("El host de GitHub no es válido.", source);
  if (visibility !== "private") return githubRefused("Esta acción solo crea repositorios privados. Confirma explícitamente visibility=private.", source);
  if (!remoteNamePattern.test(remote)) return githubRefused("El nombre del remoto no es válido.", source);
  if (!["true", "false"].includes(rawArgs.push)) return githubRefused(`Indica explícitamente si quieres publicar los commits locales (${sourceSnapshot.head ? "push=true o push=false" : "push=false; todavía no hay commits"}).`, source);
  if (push && !sourceSnapshot.head) return githubRefused("No hay commits locales que publicar. Crea un commit inicial o solicita la creación sin push.", source);

  const ghVersion = await runCommand("gh", ["--version"], sourcePath, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) return githubRefused("GitHub CLI (gh) no está instalado o no está disponible en PATH. Instálalo y vuelve a intentarlo.", source);
  const auth = await runCommand("gh", ["auth", "status", "--active", "--hostname", host], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1" });
  if (auth.code !== 0) return githubRefused(`No hay una sesión activa válida para ${host}. Ejecuta “gh auth login --hostname ${host}” y vuelve a intentarlo.`, source);

  const viewer = await runCommand("gh", ["api", "user", "--jq", ".login"], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: host });
  if (viewer.code !== 0 || !viewer.stdout.trim()) return githubRefused("No se pudo identificar la cuenta autenticada sin exponer credenciales. Revisa la sesión de gh.", source);
  if (viewer.stdout.trim().toLocaleLowerCase() !== owner.toLocaleLowerCase()) {
    const permission = await runCommand("gh", [
      "api", "graphql",
      "-f", "query=query($login:String!){organization(login:$login){viewerCanCreateRepositories}}",
      "-F", `login=${owner}`,
      "--jq", ".data.organization.viewerCanCreateRepositories"
    ], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: host });
    if (permission.code !== 0 || permission.stdout.trim() !== "true") {
      return githubRefused("La cuenta autenticada no tiene permisos suficientes para crear un repositorio privado para ese propietario u organización.", source);
    }
  }

  const existing = await runCommand("gh", ["api", `repos/${owner}/${name}`, "--silent"], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: host });
  if (existing.code === 0) return githubRefused(`El repositorio ${host}/${owner}/${name} ya existe. Elige otro nombre.`, source);
  const existingError = `${existing.stderr}\n${existing.stdout}`;
  if (!/HTTP 404|not found/i.test(existingError)) return githubRefused(`No se pudo comprobar si el repositorio remoto existe: ${existing.stderr.trim() || existing.stdout.trim() || "error de red o API"}. No se intentó crear nada.`, source);

  const remoteResult = await runGit(sourcePath, ["remote", "get-url", remote]);
  const remoteExists = remoteResult.code === 0;
  if (remoteExists && !replaceRemote) return githubRefused(`Ya existe el remoto “${remote}” (${remoteResult.stdout.trim()}). Para reemplazarlo debes solicitarlo y confirmarlo explícitamente.`, source);

  const args = {
    name, owner, host, visibility, source: sourcePath, remote,
    push: String(push), replaceRemote: String(replaceRemote && remoteExists),
    existingRemoteHash: remoteExists ? createHash("sha256").update(remoteResult.stdout.trim()).digest("hex") : ""
  };
  const effects = [
    `Crear ${host}/${owner}/${name} con visibilidad privada.`,
    `Usar ${sourcePath} como repositorio Git local, sin inicializarlo ni crear commits.`,
    `${remoteExists ? `Reemplazar el remoto local “${remote}” (${remoteResult.stdout.trim()})` : `Crear el remoto local “${remote}”`}.`,
    push ? "Publicar los commits y referencias locales disponibles." : "No publicar commits locales."
  ];
  return {
    allowed: true,
    operation: "github_create_repo",
    args,
    command: buildCommand("github_create_repo", args),
    summary: `Crear repositorio privado ${owner}/${name}`,
    rationale: "gh está instalado, la sesión está autenticada, el origen local es válido y el repositorio remoto no existe.",
    effects,
    targetPath: sourceSnapshot.path,
    targetHead: sourceSnapshot.head,
    targetStateId: sourceSnapshot.stateId,
    risk: "high",
    requiresConfirmation: true,
    source
  };
}

function extractOutputText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text;
  const textParts: string[] = [];
  for (const item of body?.output ?? []) {
    for (const content of item?.content ?? []) if (typeof content?.text === "string") textParts.push(content.text);
  }
  return textParts.join("\n").trim();
}

function cleanCommitDescription(text: string) {
  const normalized = text.trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim() ?? "";
  if (!firstParagraph) throw new Error("El proveedor no devolvió una descripción de commit.");
  return firstParagraph.slice(0, 120).trim();
}

async function getWorkingTreeDiff(snapshot: RepoSnapshot) {
  const trackedDiff = snapshot.head
    ? await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"])
    : [
        await checkedGit(snapshot.path, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--"]),
        await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "--"])
      ].filter(Boolean).join("\n");
  const untrackedRaw = await checkedGit(snapshot.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const sections = [trackedDiff];
  let remaining = 60_000 - trackedDiff.length;

  for (const relativePath of untrackedRaw.split("\0").filter(Boolean)) {
    if (remaining <= 0) break;
    const absolutePath = resolve(snapshot.path, relativePath);
    if (!absolutePath.startsWith(`${snapshot.path}${sep}`)) continue;
    try {
      if (lstatSync(absolutePath).isSymbolicLink()) {
        sections.push(`\n+++ b/${relativePath}\n[enlace simbólico omitido]`);
        continue;
      }
      const content = readFileSync(absolutePath);
      const header = `\n--- /dev/null\n+++ b/${relativePath}\n@@ archivo nuevo @@\n`;
      const body = content.includes(0)
        ? "[archivo binario omitido]"
        : content.toString("utf8", 0, Math.min(content.length, 16_000));
      const suffix = content.length > 16_000 ? "\n[contenido truncado]" : "";
      const section = `${header}${body}${suffix}`.slice(0, remaining);
      sections.push(section);
      remaining -= section.length;
    } catch {
      sections.push(`\n+++ b/${relativePath}\n[contenido no legible]`);
    }
  }
  const diff = sections.filter(Boolean).join("\n").slice(0, 60_000);
  if (!diff.trim()) throw new Error("No hay un diff de texto disponible para describir.");
  return diff;
}

export async function generateCommitDescription(cwd: string) {
  if (!llmState.apiKey.trim()) throw new Error("Configura un proveedor LLM para generar la descripción. También puedes escribirla manualmente.");
  const snapshot = await getSnapshot(cwd);
  if (!snapshot.changes.length) throw new Error("No hay cambios locales que describir.");
  const diff = await getWorkingTreeDiff(snapshot);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmState.apiKey}` },
      body: JSON.stringify({
        model: llmState.model || MODEL_FALLBACK,
        instructions: "Genera un único mensaje de commit conciso en español, máximo 120 caracteres. Describe la intención del cambio usando el diff real. Devuelve solo el mensaje, sin comillas, markdown, prefijos ni explicación.",
        input: `Rama actual: ${snapshot.currentBranch}\n\nDiff del árbol de trabajo:\n${diff}`,
        max_output_tokens: 80,
        store: false
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const description = cleanCommitDescription(extractOutputText(await response.json()));
  const current = await getSnapshot(snapshot.path);
  if (current.stateId !== snapshot.stateId) throw new Error("Los cambios variaron durante la generación. Inténtalo de nuevo.");
  return { description, stateId: snapshot.stateId };
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

function planFromModel(value: Record<string, unknown>, source: "llm", snapshot: RepoSnapshot): PlanDraft {
  const operation = typeof value.operation === "string" && allowedOperations.has(value.operation as Operation) ? value.operation as Operation : "none";
  const rawArgs = value.args && typeof value.args === "object" ? value.args as Record<string, unknown> : {};
  const args = Object.fromEntries(Object.entries(rawArgs).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  if (operation === "github_create_repo") return {
    allowed: true,
    operation,
    args,
    command: "—",
    summary: "Validar creación de repositorio GitHub",
    rationale: "La solicitud se validará con Git, GitHub CLI y la API antes de presentar un plan.",
    risk: "high",
    requiresConfirmation: true,
    source
  };
  const branchArg = args.name || args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) return refused("El modelo propuso un nombre de rama no válido.", source);
  if (operation === "commit" && (!args.message || args.message.length > 120)) return refused("El mensaje de commit falta o es demasiado largo.", source);
  if (value.allowed !== true || operation === "none") return refused("Solo puedo ayudarte con ramas, historial, cambios y operaciones Git.", source);
  return { ...operationDraft(operation, args, snapshot), source };
}

async function llmPlan(request: string, snapshot: RepoSnapshot, context: ConversationMessage[]): Promise<PlanDraft> {
  const instructions = `Eres el planificador seguro de Branchline, una aplicación de escritorio para ramas Git.
Decide por significado, no por palabras clave, si la solicitud trata sobre Git, ramas, commits, cambios, historial, autoría, remotos, conflictos o rebase. Acepta preguntas naturales indirectas sobre esos temas y rechaza únicamente solicitudes claramente ajenas.
No ejecutes nada y no inventes comandos. Responde SOLO un JSON válido con estas claves: allowed (boolean), operation (status|checkout|create_branch|delete_branch|fetch|pull|push|merge|rebase|abort_rebase|continue_rebase|commit|github_create_repo|branch_last_author|none), args (objeto), summary, rationale y risk (low|medium|high).
Usa branch_last_author para preguntas sobre quién trabajó, modificó o hizo el commit más reciente de la rama actual. Es una consulta informativa, no una operación modificadora.
Para crear un repositorio GitHub usa github_create_repo y estos args string: source (ruta absoluta), name, owner, host, visibility (private), remote, push (true|false), replaceRemote (true|false). No asumas owner, host, inicialización ni commit inicial; si faltan, usa allowed=false y explica qué decisión falta.
No propongas comandos de shell libres. Para nombres de rama usa args.name o args.onto; para commit usa args.message.
Estado actual: ruta=${snapshot.path}, rama=${snapshot.currentBranch}, ramas=${snapshot.branches.map((branch) => branch.name).join(", ") || "ninguna"}, cambios=${snapshot.changes.length}, rebaseEnCurso=${snapshot.isRebasing}.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmState.apiKey}` },
      body: JSON.stringify({
        model: llmState.model || MODEL_FALLBACK,
        instructions,
        input: [...context.slice(-20), { role: "user", content: request }],
        max_output_tokens: 500,
        store: false
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  const text = extractOutputText(body);
  const parsed = parseJsonObject(text);
  return parsed ? planFromModel(parsed, "llm", snapshot) : refused("El proveedor no devolvió un plan JSON válido.", "llm");
}

function bindPlan(snapshot: RepoSnapshot, draft: PlanDraft): ActionPlan {
  return { ...draft, id: randomUUID(), repoPath: snapshot.path, head: snapshot.head, stateId: snapshot.stateId };
}

export async function planAction(cwd: string, request: string, context: ConversationMessage[] = []): Promise<ActionPlan> {
  const snapshot = await getSnapshot(cwd);
  if (!request.trim()) return bindPlan(snapshot, refused("Escribe una acción relacionada con la rama o el repositorio."));
  if (!llmState.apiKey.trim()) {
    const draft = localPlan(request, snapshot);
    if (draft.operation === "github_create_repo") return bindPlan(snapshot, await prepareGithubRepository(snapshot, draft.args, "local-fallback"));
    return bindPlan(snapshot, draft);
  }
  try {
    const draft = await llmPlan(request, snapshot, context);
    if (draft.operation === "github_create_repo") {
      const checked = await prepareGithubRepository(snapshot, draft.args, "llm");
      return bindPlan(snapshot, checked);
    }
    return bindPlan(snapshot, draft);
  } catch (error) {
    return bindPlan(snapshot, refused(`No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, "llm"));
  }
}

function operationDraft(operation: Operation, args: Record<string, string>, snapshot?: RepoSnapshot): PlanDraft {
  if (operation === "branch_last_author") {
    const commit = snapshot?.branches.find((branch) => branch.isCurrent)?.lastCommit;
    return {
      allowed: true,
      operation,
      args: {},
      command: "—",
      summary: "Última persona en trabajar en esta rama",
      rationale: "Consulta informativa basada en el commit más reciente de la rama actual.",
      answer: commit
        ? `${commit.author} fue la última persona en trabajar en ${snapshot?.currentBranch}. Su commit más reciente fue “${commit.subject || "Sin mensaje"}” el ${formatAnswerDate(commit.date)}.`
        : `La rama ${snapshot?.currentBranch ?? "actual"} todavía no tiene un commit local que permita identificar a su último autor.`,
      risk: "low",
      requiresConfirmation: false,
      source: "local-fallback"
    };
  }
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
  if (operation === "github_create_repo") return bindPlan(snapshot, await prepareGithubRepository(snapshot, args, "local-fallback"));
  const draft = operationDraft(operation, args, snapshot);
  if (draft.allowed) validateExecution(bindPlan(snapshot, draft), snapshot);
  return bindPlan(snapshot, draft);
}

function validateExecution(plan: ActionPlan, snapshot: RepoSnapshot) {
  if (!plan.allowed || plan.operation === "none" || !allowedOperations.has(plan.operation)) throw new Error("La acción no está permitida.");
  if (plan.answer || plan.operation === "branch_last_author") throw new Error("Las consultas informativas no se ejecutan como operaciones Git.");
  const branchArg = plan.args.name || plan.args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) throw new Error("Nombre de rama no válido.");
  if (plan.repoPath !== snapshot.path) throw new Error("El plan pertenece a otro repositorio.");
  if (plan.head !== snapshot.head) throw new Error("El repositorio cambió desde que se preparó el plan. Prepara la acción de nuevo.");
  if (plan.stateId !== snapshot.stateId) throw new Error("Los cambios locales variaron desde que se preparó el plan. Prepara la acción de nuevo.");
  if (["checkout", "create_branch", "delete_branch", "merge"].includes(plan.operation) && !plan.args.name) throw new Error("Falta el nombre de la rama.");
  if (plan.operation === "rebase" && !plan.args.onto) throw new Error("Falta la rama base.");
  if (plan.operation === "commit" && (!plan.args.message?.trim() || plan.args.message.length > 120)) throw new Error("El mensaje de commit no es válido.");
  if (plan.operation === "commit" && !snapshot.changes.length) throw new Error("No hay cambios locales para confirmar.");
  if (plan.operation === "checkout" && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "create_branch" && snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} ya existe.`);
  if (plan.operation === "delete_branch" && plan.args.name === snapshot.currentBranch) throw new Error("No puedes borrar la rama activa.");
  if (["delete_branch", "merge"].includes(plan.operation) && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "rebase" && !snapshot.branches.some((branch) => branch.name === plan.args.onto)) throw new Error(`La rama base ${plan.args.onto} no existe localmente.`);
  if (["abort_rebase", "continue_rebase"].includes(plan.operation) && !snapshot.isRebasing) throw new Error("No hay un rebase en curso.");
}

function validateGithubPlan(plan: ActionPlan) {
  const { name, owner, host, visibility, source, remote, push, replaceRemote } = plan.args;
  if (!githubNamePattern.test(name ?? "") || !githubOwnerPattern.test(owner ?? "") || !githubHostPattern.test(host ?? "") || visibility !== "private" ||
      !remoteNamePattern.test(remote ?? "") || !["true", "false"].includes(push) || !["true", "false"].includes(replaceRemote)) {
    throw new Error("El plan de creación de GitHub contiene argumentos no válidos.");
  }
  if (!source || resolve(source) !== plan.targetPath) throw new Error("La ruta de origen del plan no es válida.");
}

async function executeGithubRepositoryPlan(plan: ActionPlan) {
  validateGithubPlan(plan);
  const source = realpathSync(plan.args.source);
  const snapshot = await getSnapshot(source);
  if (snapshot.path !== plan.targetPath || snapshot.head !== plan.targetHead || snapshot.stateId !== plan.targetStateId) {
    throw new Error("El repositorio de origen cambió desde la validación. Prepara la acción de nuevo.");
  }
  if (plan.args.push === "true" && !snapshot.head) throw new Error("No hay commits locales que publicar.");
  const ghVersion = await runCommand("gh", ["--version"], source, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) throw new Error("GitHub CLI (gh) ya no está instalado o disponible en PATH.");
  const auth = await runCommand("gh", ["auth", "status", "--active", "--hostname", plan.args.host], source, 20_000, { GH_PROMPT_DISABLED: "1" });
  if (auth.code !== 0) throw new Error(`La sesión de gh para ${plan.args.host} ya no es válida.`);
  const existing = await runCommand("gh", ["api", `repos/${plan.args.owner}/${plan.args.name}`, "--silent"], source, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: plan.args.host });
  if (existing.code === 0) throw new Error(`El repositorio ${plan.args.owner}/${plan.args.name} ya existe.`);
  if (!/HTTP 404|not found/i.test(`${existing.stderr}\n${existing.stdout}`)) throw new Error("No se pudo confirmar que el repositorio remoto siga disponible.");

  const currentRemote = await runGit(source, ["remote", "get-url", plan.args.remote]);
  if (currentRemote.code === 0 && plan.args.replaceRemote !== "true") throw new Error(`El remoto “${plan.args.remote}” existe y no se autorizó reemplazarlo.`);
  if (currentRemote.code === 0 && createHash("sha256").update(currentRemote.stdout.trim()).digest("hex") !== plan.args.existingRemoteHash) throw new Error(`El remoto “${plan.args.remote}” cambió desde la validación.`);
  const previousRemoteUrl = currentRemote.code === 0 ? currentRemote.stdout.trim() : "";
  if (currentRemote.code === 0) await checkedGit(source, ["remote", "remove", plan.args.remote]);

  try {
    const args = ["repo", "create", `${plan.args.owner}/${plan.args.name}`, "--private", "--source", source, "--remote", plan.args.remote];
    if (plan.args.push === "true") args.push("--push");
    return await checkedGh(args, source, plan.args.host);
  } catch (error) {
    const createdRemote = await runGit(source, ["remote", "get-url", plan.args.remote]);
    if (createdRemote.code === 0) await checkedGit(source, ["remote", "remove", plan.args.remote]).catch(() => undefined);
    if (currentRemote.code === 0) await checkedGit(source, ["remote", "add", plan.args.remote, previousRemoteUrl]).catch(() => undefined);
    const message = error instanceof Error ? error.message : "gh no pudo crear el repositorio.";
    if (/forbidden|permission|not accessible|403/i.test(message)) throw new Error("No hay permisos suficientes para crear el repositorio privado solicitado.");
    throw error;
  }
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
      case "github_create_repo": output = await executeGithubRepositoryPlan(plan); break;
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
