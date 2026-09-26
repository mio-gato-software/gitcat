import type { ActionPlan, Locale, PlanStep, RepoSnapshot, StepOutcome } from "./types.js";
import { workOverview, type NextActionId } from "./work-overview.js";

/**
 * A plan and its result told in terms of what the person wanted: which project, which branches, which
 * files, what changes on this computer and what changes on a remote, and where things stand at the end.
 * Every fact is read from the plan's validated steps and from repository snapshots, never from command
 * text, so the commands themselves can stay in a technical section nobody has to read to decide.
 */

export type PlanSummary = {
  project: string;
  /** Where the work comes from and where it ends up, when the plan moves work between places. */
  from?: string;
  to?: string;
  /** The branch Git is on when the plan is done. */
  endsOn?: string;
  /** The files a save records: the ticked ones, or every uncommitted file. */
  files?: { paths: string[]; selected: boolean; left: number };
  local: string[];
  remote: { name?: string; effects: string[] };
  finalState: string[];
  /** What cannot simply be taken back once it has run. */
  irreversible: string[];
  /** What a stop halfway would leave behind. */
  partial: string[];
  /** The project moved after the plan was prepared; execution checks again and refuses if it no longer fits. */
  stale: boolean;
  /** Nothing in files, commits or branches changes. */
  noop: boolean;
};

export type CompletionStatus = "completed" | "no_change" | "partial" | "failed" | "not_run";

export type CompletionSummary = {
  status: CompletionStatus;
  headline: string;
  /** Each step with what actually happened to it. */
  steps: { summary: string; status: StepOutcome["status"] }[];
  /** What the snapshots show changed. */
  changed: string[];
  /** What is still only on this computer, or not saved at all. */
  remaining: string[];
  /** The next step that applies, only when the plan finished. A stop is handled by recovery. */
  next?: { action: NextActionId; label: string };
};

type Say = (en: string, es: string) => string;
const speaker = (locale: Locale | undefined): Say => (en, es) => locale === "en" ? en : es;

const files = (say: Say, count: number) => count === 1 ? say("1 file", "1 archivo") : say(`${count} files`, `${count} archivos`);
const commits = (say: Say, count: number) => count === 1 ? say("1 commit", "1 commit") : say(`${count} commits`, `${count} commits`);

function remoteOf(upstream: string | undefined, remotes: string[]) {
  if (!upstream) return undefined;
  return [...remotes].sort((a, b) => b.length - a.length).find((remote) => upstream.startsWith(`${remote}/`));
}

/** Steps that only read. A plan made only of these leaves files, commits and branches as they are. */
function readsOnly(step: PlanStep) {
  return step.operation === "status" || step.operation === "fetch" || (step.operation === "git_command" && step.risk === "low");
}

/** Steps that make commits on the branch they run on, which then are not on any remote until published. */
const writesHistory = new Set(["commit", "merge", "rebase", "continue_operation", "skip_operation"]);

const pendingNames = (say: Say): Record<string, string> => ({
  merge: say("merge", "fusión"), rebase: say("rebase", "rebase"), cherry_pick: say("cherry-pick", "cherry-pick"),
  revert: say("revert", "revert"), "cherry-pick": say("cherry-pick", "cherry-pick")
});

/** Walks the steps with the branch each one runs on, which the previous steps decide. */
function walk(steps: PlanStep[], start: string) {
  let branch = start;
  return steps.map((step) => {
    const on = branch;
    if (step.operation === "checkout" || step.operation === "create_branch") branch = step.args.name;
    if (step.operation === "rename_branch" && step.args.name === branch) branch = step.args.to;
    return { step, on, after: branch };
  });
}

export function planSummary(plan: ActionPlan, snapshot?: RepoSnapshot, locale?: Locale): PlanSummary {
  const say = speaker(locale);
  const start = snapshot?.currentBranch ?? "";
  const branchNamed = (name: string) => snapshot?.branches.find((item) => item.name === name && item.presence !== "remote");
  const remotes = snapshot?.remotes ?? [];
  const project = snapshot?.name ?? plan.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? plan.repoPath;
  const summary: PlanSummary = { project, local: [], remote: { effects: [] }, finalState: [], irreversible: [], partial: [], stale: false, noop: false };
  if (plan.kind !== "plan" || !plan.allowed || !plan.steps.length) return summary;

  summary.stale = Boolean(snapshot && snapshot.path === plan.repoPath && (snapshot.head !== plan.head || (!plan.selection && snapshot.stateId !== plan.stateId)));
  summary.noop = plan.steps.every(readsOnly);
  const walked = walk(plan.steps, start);
  let edited = snapshot?.changes.length ?? 0;
  let saved = false;
  /** Branches with new commits on this computer, and the branches the plan publishes afterwards. */
  const unpublished = new Set<string>();
  const published = new Map<string, string>();
  const conflictProne: string[] = [];

  for (const { step, on } of walked) {
    const { args } = step;
    const here = on && on !== "HEAD" ? on : say("this branch", "esta rama");
    const upstreamRemote = remoteOf(branchNamed(on)?.upstream, remotes);
    switch (step.operation) {
      case "status": summary.local.push(say("Reads the project's current state. Nothing changes.", "Lee el estado actual del proyecto. No cambia nada.")); break;
      case "fetch": {
        const remote = upstreamRemote ?? (remotes.length === 1 ? remotes[0] : undefined);
        summary.remote.name ??= remote;
        summary.remote.effects.push(remote
          ? say(`Reads what is new on ${remote}. Nothing is sent, and your branches and files stay as they are.`, `Lee lo nuevo en ${remote}. No se envía nada, y tus ramas y archivos se quedan como están.`)
          : say("Reads what is new on the remotes. Nothing is sent, and your branches and files stay as they are.", "Lee lo nuevo en los remotos. No se envía nada, y tus ramas y archivos se quedan como están."));
        break;
      }
      case "pull": {
        const upstream = branchNamed(on)?.upstream;
        summary.remote.name ??= upstreamRemote;
        summary.local.push(upstream
          ? say(`Brings the new commits of ${upstream} into ${here}, only if that needs no merge.`, `Trae los commits nuevos de ${upstream} a ${here}, solo si no hace falta una fusión.`)
          : say(`Brings the remote's new commits into ${here}, only if that needs no merge.`, `Trae los commits nuevos del remoto a ${here}, solo si no hace falta una fusión.`));
        summary.from ??= upstream; summary.to ??= on || undefined;
        break;
      }
      case "checkout":
        summary.local.push(say(`Switches to ${args.name}: the files on disk change to match it. Uncommitted changes come along when they do not clash.`, `Cambia a ${args.name}: los archivos del disco pasan a ser los de esa rama. Los cambios sin guardar te acompañan si no chocan.`));
        break;
      case "create_branch":
        summary.local.push(args.from
          ? say(`Creates branch ${args.name} starting at commit ${args.from.slice(0, 7)} and switches to it.`, `Crea la rama ${args.name} desde el commit ${args.from.slice(0, 7)} y cambia a ella.`)
          : say(`Creates branch ${args.name} from ${here} and switches to it. Nothing else changes.`, `Crea la rama ${args.name} desde ${here} y cambia a ella. Nada más cambia.`));
        summary.from ??= args.from ? args.from.slice(0, 7) : on || undefined; summary.to ??= args.name;
        break;
      case "delete_branch": {
        const into = branchNamed(args.name)?.mergedInto ?? [];
        summary.local.push(say(`Deletes branch ${args.name} on this computer.`, `Elimina la rama ${args.name} en este equipo.`));
        summary.irreversible.push(into.length
          ? say(`The name ${args.name} goes away. Its commits stay in ${into.join(", ")}, and any copy on a remote is left alone.`, `El nombre ${args.name} desaparece. Sus commits siguen en ${into.join(", ")}, y cualquier copia en un remoto no se toca.`)
          : say(`The name ${args.name} goes away. Git only deletes it if its commits are already in another branch; any copy on a remote is left alone.`, `El nombre ${args.name} desaparece. Git solo la borra si sus commits ya están en otra rama; cualquier copia en un remoto no se toca.`));
        break;
      }
      case "rename_branch":
        summary.local.push(say(`Renames ${args.name} to ${args.to} on this computer. Its commits and any remote copy stay as they are.`, `Renombra ${args.name} a ${args.to} en este equipo. Sus commits y cualquier copia remota se quedan como están.`));
        break;
      case "merge":
        summary.local.push(say(`Brings the commits of ${args.name} into ${here} on this computer.`, `Trae los commits de ${args.name} a ${here} en este equipo.`));
        summary.from ??= args.name; summary.to ??= on || undefined;
        conflictProne.push(say("merge", "fusión"));
        break;
      case "rebase": {
        const upstream = branchNamed(on)?.upstream;
        summary.local.push(say(`Replays the commits of ${here} on top of ${args.onto}.`, `Reaplica los commits de ${here} encima de ${args.onto}.`));
        summary.irreversible.push(upstream
          ? say(`The commits of ${here} are rewritten with new identities. ${here} is already published as ${upstream}, so publishing it again would have to replace that copy.`, `Los commits de ${here} se reescriben con identidades nuevas. ${here} ya está publicada como ${upstream}, así que publicarla de nuevo tendría que reemplazar esa copia.`)
          : say(`The commits of ${here} are rewritten with new identities.`, `Los commits de ${here} se reescriben con identidades nuevas.`));
        summary.from ??= on || undefined; summary.to ??= args.onto;
        conflictProne.push("rebase");
        break;
      }
      case "abort_operation": {
        const job = pendingNames(say)[args.pending ?? ""] ?? args.pendingLabel ?? say("operation", "operación");
        summary.local.push(say(`Cancels the unfinished ${job} and returns the project to how it was before it started.`, `Cancela la operación a medias (${job}) y devuelve el proyecto a como estaba antes de empezar.`));
        summary.irreversible.push(say(`Any conflict you already resolved inside this ${job} is discarded.`, `Cualquier conflicto que ya resolviste dentro de esta operación (${job}) se descarta.`));
        break;
      }
      case "continue_operation":
        summary.local.push(say("Continues the unfinished operation from where it stopped.", "Continúa la operación a medias desde donde se detuvo."));
        conflictProne.push(pendingNames(say)[args.pending ?? ""] ?? say("operation", "operación"));
        break;
      case "skip_operation":
        summary.local.push(say("Skips the commit that got stuck and continues with the rest.", "Salta el commit atascado y sigue con el resto."));
        summary.irreversible.push(say("The changes of the skipped commit are left out of the result.", "Los cambios del commit saltado quedan fuera del resultado."));
        break;
      case "resolve_conflict":
        summary.local.push(say(`Marks ${args.path} as resolved.`, `Marca ${args.path} como resuelto.`));
        break;
      case "commit": {
        const all = snapshot?.changes.map((change) => change.path) ?? [];
        const paths = step.paths ? all.filter((path) => step.paths!.includes(path)) : all;
        const count = step.paths ? paths.length || step.paths.length : all.length;
        summary.files = { paths: step.paths ? (paths.length ? paths : step.paths) : all, selected: Boolean(step.paths), left: Math.max(0, edited - count) };
        summary.local.push(say(`Saves ${files(say, count)} as a commit on ${here}: “${args.message ?? ""}”.`, `Guarda ${files(say, count)} como un commit en ${here}: «${args.message ?? ""}».`));
        edited = Math.max(0, edited - count);
        saved = true;
        break;
      }
      case "ignore_path":
        summary.local.push(say(`Adds ${args.path} to .gitignore. The file stays on your disk.`, `Añade ${args.path} a .gitignore. El archivo se queda en tu disco.`));
        break;
      case "set_identity":
        summary.local.push(args.scope === "global"
          ? say(`Signs future commits in every repository on this Mac as ${args.user} <${args.email}>.`, `Firma los próximos commits de todos los repositorios de este Mac como ${args.user} <${args.email}>.`)
          : say(`Signs future commits in this project as ${args.user} <${args.email}>.`, `Firma los próximos commits de este proyecto como ${args.user} <${args.email}>.`));
        break;
      case "add_remote":
        summary.local.push(say(`Connects this project to ${args.url} as ${args.name}. Nothing is sent yet.`, `Conecta este proyecto con ${args.url} como ${args.name}. Todavía no se envía nada.`));
        break;
      case "push": {
        const branch = args.branch ?? on;
        const remote = args.setUpstream ?? upstreamRemote;
        const ahead = !walked.some((item) => item.step !== step && writesHistory.has(item.step.operation) && item.on === branch) ? branchNamed(branch)?.ahead : undefined;
        if (!remote) {
          // Nowhere to send it: saying the branch would match a remote would promise something Git cannot do.
          summary.remote.effects.push(remotes.length
            ? say(`${branch} has no destination on a remote yet, so Git has nowhere to send it.`, `${branch} todavía no tiene destino en un remoto, así que Git no tiene adónde enviarla.`)
            : say(`This project is not connected to a remote yet, so there is nowhere to send ${branch}.`, `Este proyecto todavía no está conectado a un remoto, así que no hay adónde enviar ${branch}.`));
          break;
        }
        summary.remote.name ??= remote;
        summary.remote.effects.push(args.setUpstream
          ? say(`Publishes ${branch} to ${remote} for the first time and remembers it as its destination.`, `Publica ${branch} en ${remote} por primera vez y la recuerda como su destino.`)
          : ahead
            ? say(`Sends ${commits(say, ahead)} of ${branch} to ${remote}.`, `Envía ${commits(say, ahead)} de ${branch} a ${remote}.`)
            : say(`Sends the saved commits of ${branch} to ${remote}.`, `Envía los commits guardados de ${branch} a ${remote}.`));
        summary.irreversible.push(say(`Once on ${remote}, anyone with access can fetch these commits; taking them back means rewriting the remote.`, `Una vez en ${remote}, cualquiera con acceso puede descargar estos commits; retirarlos obliga a reescribir el remoto.`));
        if (args.noVerify === "true") summary.irreversible.push(say("The checks this project runs before publishing (pre-push hooks) are skipped.", "Se saltan las comprobaciones que este proyecto ejecuta antes de publicar (hooks pre-push)."));
        published.set(branch, remote);
        unpublished.delete(branch);
        break;
      }
      case "github_create_repo": {
        const where = `${args.owner}/${args.name}`;
        summary.remote.name ??= args.remote;
        summary.remote.effects.push(say(`Creates the private repository ${where} on ${args.host}.`, `Crea el repositorio privado ${where} en ${args.host}.`));
        summary.local.push(say(`Connects this project to it as ${args.remote}.`, `Conecta este proyecto con él como ${args.remote}.`));
        if (args.push === "true") {
          summary.remote.effects.push(say(`Publishes ${here} there.`, `Publica ${here} allí.`));
          published.set(on, args.remote);
        }
        summary.irreversible.push(say(`The repository ${where} stays on ${args.host} until someone deletes it there.`, `El repositorio ${where} se queda en ${args.host} hasta que alguien lo borre allí.`));
        break;
      }
      case "git_command":
        summary.local.push(step.risk === "low"
          ? say("Runs a Git command that only reads.", "Ejecuta un comando Git que solo lee.")
          : say("Runs a Git command the assistant proposed as is; the exact command is in the technical details.", "Ejecuta tal cual un comando Git que propuso el asistente; el comando exacto está en los detalles técnicos."));
        break;
      default: break;
    }
    if (writesHistory.has(step.operation) && on) unpublished.add(on);
  }

  const endsOn = walked.at(-1)?.after;
  summary.endsOn = endsOn && endsOn !== "HEAD" ? endsOn : undefined;
  if (summary.noop) summary.finalState.push(say("Your files, commits and branches stay exactly as they are.", "Tus archivos, commits y ramas se quedan exactamente como están."));
  else if (summary.endsOn && (summary.endsOn !== start || walked.some(({ step }) => writesHistory.has(step.operation)))) summary.finalState.push(say(`You end up on ${summary.endsOn}.`, `Terminas en ${summary.endsOn}.`));
  if (saved) summary.finalState.push(edited
    ? say(`${files(say, edited)} stay uncommitted, exactly as they are.`, `${files(say, edited)} siguen sin guardar, tal como están.`)
    : say("No uncommitted changes are left.", "No quedan cambios sin guardar."));
  else if (!summary.noop && edited && walked.some(({ step }) => step.operation === "checkout" || step.operation === "create_branch")) {
    summary.finalState.push(say(`Your ${files(say, edited)} with uncommitted changes come along, still uncommitted.`, `Tus ${files(say, edited)} con cambios sin guardar te acompañan, todavía sin guardar.`));
  }
  for (const [branch, remote] of published) summary.finalState.push(say(`${branch} matches ${remote}.`, `${branch} queda igual que en ${remote}.`));
  for (const branch of unpublished) summary.finalState.push(remotes.length
    ? say(`The new commits on ${branch} stay on this computer until you publish them.`, `Los commits nuevos de ${branch} se quedan en este equipo hasta que los publiques.`)
    : say(`${branch} stays on this computer: this project is not connected to a remote.`, `${branch} se queda en este equipo: este proyecto no está conectado a un remoto.`));

  if (plan.steps.length > 1) summary.partial.push(say(
    `The ${plan.steps.length} steps run in order. If one fails, the ones before it stay done, the rest do not run, and GitCat shows exactly where it stopped.`,
    `Los ${plan.steps.length} pasos se ejecutan en orden. Si uno falla, los anteriores quedan hechos, los siguientes no se ejecutan y GitCat muestra exactamente dónde se detuvo.`));
  for (const job of new Set(conflictProne)) summary.partial.push(say(
    `If both sides changed the same lines, the ${job} stops halfway and the project holds it unfinished until you finish or cancel it.`,
    `Si ambos lados cambiaron las mismas líneas, la operación (${job}) se detiene a medias y el proyecto la mantiene sin terminar hasta que la completes o la canceles.`));
  return summary;
}

/** The parts of a snapshot a person would notice changing. */
function fingerprint(snapshot: RepoSnapshot) {
  return JSON.stringify([
    snapshot.head, snapshot.currentBranch, snapshot.stateId, snapshot.remotes, snapshot.pending?.kind, snapshot.conflicts.length,
    snapshot.branches.map((branch) => [branch.name, branch.presence, branch.lastCommit?.hash, branch.upstream, branch.ahead, branch.behind])
  ]);
}

/** Operations whose every effect shows in a snapshot, so an unchanged snapshot proves nothing changed. */
const observable = new Set(["status", "fetch", "pull", "push", "merge", "rebase", "checkout", "commit", "git_command"]);

export type CompletionInput = {
  plan: ActionPlan;
  outcomes?: StepOutcome[];
  before?: RepoSnapshot;
  after?: RepoSnapshot;
  /** The plan stopped: a failed step, or a refusal before the first one. */
  error?: string;
  fetchedAt?: string;
};

export function completionSummary(input: CompletionInput, locale?: Locale): CompletionSummary {
  const say = speaker(locale);
  const { plan, before, after } = input;
  const outcomes = input.outcomes?.length ? input.outcomes
    : plan.steps.map((step) => ({ command: step.command, summary: step.summary, status: input.error ? "skipped" as const : "completed" as const, output: "" }));
  const steps = outcomes.map(({ summary, status }) => ({ summary, status }));
  const failed = outcomes.find((outcome) => outcome.status === "failed");
  const done = outcomes.filter((outcome) => outcome.status === "completed").length;
  const moved = before && after ? fingerprint(before) !== fingerprint(after) : true;
  const status: CompletionStatus = failed ? (done ? "partial" : "failed")
    : input.error || !done ? "not_run"
    : !moved && plan.steps.every((step) => observable.has(step.operation)) ? "no_change"
    : "completed";

  const headline = status === "completed" ? (outcomes.length === 1 ? say(`Done: ${outcomes[0].summary}.`, `Hecho: ${outcomes[0].summary}.`) : say(`All ${outcomes.length} steps completed.`, `Se completaron los ${outcomes.length} pasos.`))
    : status === "no_change" ? say("Git ran and nothing needed to change.", "Git se ejecutó y no hacía falta cambiar nada.")
    : status === "partial" ? say(`Stopped partway: ${done} of ${outcomes.length} steps completed. “${failed!.summary}” failed.`, `Se detuvo a medias: se completaron ${done} de ${outcomes.length} pasos. Falló «${failed!.summary}».`)
    : status === "failed" ? (outcomes.length > 1
      ? say(`“${failed!.summary}” did not complete, so the other steps did not run.`, `«${failed!.summary}» no se completó, así que los demás pasos no se ejecutaron.`)
      : say(`“${failed!.summary}” did not complete.`, `«${failed!.summary}» no se completó.`))
    : say("Nothing ran: GitCat stopped before the first step, so the project is as it was.", "No se ejecutó nada: GitCat se detuvo antes del primer paso, así que el proyecto sigue como estaba.");

  const changed = before && after && status !== "not_run" ? changes(plan, outcomes, before, after, say) : [];
  if (status === "completed" && !changed.length) changed.push(...outcomes.map((outcome) => outcome.summary));
  const summary: CompletionSummary = { status, headline, steps, changed, remaining: after ? remaining(after, input.fetchedAt, say) : [] };
  if (after && (status === "completed" || status === "no_change")) {
    const next = workOverview(after, { fetchedAt: input.fetchedAt }).next;
    summary.next = { action: next.action, label: nextLabel(next, after, say) };
  }
  return summary;
}

function changes(plan: ActionPlan, outcomes: StepOutcome[], before: RepoSnapshot, after: RepoSnapshot, say: Say) {
  const lines: string[] = [];
  const local = (snapshot: RepoSnapshot) => new Map(snapshot.branches.filter((branch) => branch.presence !== "remote").map((branch) => [branch.name, branch]));
  const was = local(before), now = local(after);
  const ran = walk(plan.steps, before.currentBranch).filter((_, index) => outcomes[index]?.status === "completed");
  const ranOn = (operation: string, branch: string) => ran.find(({ step, on }) => step.operation === operation && on === branch);
  const created = [...now.keys()].filter((name) => !was.has(name));
  const removed = [...was.keys()].filter((name) => !now.has(name));
  for (const name of created) {
    const renamed = ran.find(({ step }) => step.operation === "rename_branch" && step.args.to === name);
    lines.push(renamed ? say(`${renamed.step.args.name} is now called ${name}.`, `${renamed.step.args.name} ahora se llama ${name}.`) : say(`Created branch ${name}.`, `Se creó la rama ${name}.`));
  }
  for (const name of removed) {
    if (!ran.some(({ step }) => step.operation === "rename_branch" && step.args.name === name)) lines.push(say(`Deleted branch ${name} on this computer.`, `Se eliminó la rama ${name} en este equipo.`));
  }
  if (before.currentBranch !== after.currentBranch && after.currentBranch !== "HEAD") lines.push(say(`You are now on ${after.currentBranch}.`, `Ahora estás en ${after.currentBranch}.`));
  for (const [name, branch] of now) {
    const previous = was.get(name);
    if (!previous || previous.lastCommit?.hash === branch.lastCommit?.hash) continue;
    const subject = branch.lastCommit?.subject ?? "";
    const merge = ranOn("merge", name), commit = ranOn("commit", name), pull = ranOn("pull", name), rebase = ranOn("rebase", name);
    lines.push(merge ? say(`${merge.step.args.name} was brought into ${name} on this computer.`, `${merge.step.args.name} se integró en ${name} en este equipo.`)
      : commit ? say(`Saved a commit on ${name}: “${subject}”.`, `Se guardó un commit en ${name}: «${subject}».`)
      : pull ? say(`${name} now has the latest from ${previous.upstream ?? "the remote"}.`, `${name} ya tiene lo último de ${previous.upstream ?? "el remoto"}.`)
      : rebase ? say(`${name} was replayed on top of ${rebase.step.args.onto}.`, `${name} se reaplicó encima de ${rebase.step.args.onto}.`)
      : say(`${name} now ends at “${subject}”.`, `${name} ahora termina en «${subject}».`));
  }
  for (const [name, branch] of now) {
    const previous = was.get(name);
    if (!branch.upstream || branch.ahead) continue;
    const pushed = ran.some(({ step, on }) => (step.operation === "push" && (step.args.branch ?? on) === name) || (step.operation === "github_create_repo" && on === name));
    if (pushed && (!previous?.upstream || previous.ahead || previous.lastCommit?.hash !== branch.lastCommit?.hash)) {
      lines.push(say(`${name} is now published on ${remoteOf(branch.upstream, after.remotes) ?? branch.upstream}.`, `${name} ya está publicada en ${remoteOf(branch.upstream, after.remotes) ?? branch.upstream}.`));
    }
  }
  for (const remote of after.remotes.filter((name) => !before.remotes.includes(name))) lines.push(say(`Connected to ${remote}.`, `Se conectó con ${remote}.`));
  const current = now.get(after.currentBranch), previous = was.get(after.currentBranch);
  if (current && previous && current.behind > previous.behind) lines.push(say(`${remoteOf(current.upstream, after.remotes) ?? "The remote"} has ${commits(say, current.behind - previous.behind)} for ${after.currentBranch} you do not have yet.`, `${remoteOf(current.upstream, after.remotes) ?? "El remoto"} tiene ${commits(say, current.behind - previous.behind)} para ${after.currentBranch} que aún no tienes.`));
  if (before.changes.length !== after.changes.length) lines.push(say(`Uncommitted files: ${before.changes.length} before, ${after.changes.length} now.`, `Archivos sin guardar: ${before.changes.length} antes, ${after.changes.length} ahora.`));
  if (after.pending && !before.pending) lines.push(say(`Git stopped halfway: the ${pendingNames(say)[after.pending.kind] ?? after.pending.kind} is unfinished${after.conflicts.length ? ` with ${files(say, after.conflicts.length)} in conflict` : ""}.`, `Git se detuvo a medias: la operación (${pendingNames(say)[after.pending.kind] ?? after.pending.kind}) está sin terminar${after.conflicts.length ? ` con ${files(say, after.conflicts.length)} en conflicto` : ""}.`));
  return lines;
}

function remaining(after: RepoSnapshot, fetchedAt: string | undefined, say: Say) {
  const overview = workOverview(after, { fetchedAt });
  const lines: string[] = [];
  const branch = overview.branch ?? say("this branch", "esta rama");
  const remote = overview.published.remote ?? say("the remote", "el remoto");
  if (overview.pending || overview.conflicts) lines.push(say("An unfinished operation is waiting to be finished or cancelled.", "Hay una operación a medias esperando a que la termines o la canceles."));
  if (overview.edited.count) lines.push(say(`${files(say, overview.edited.count)} still uncommitted on this computer.`, `${files(say, overview.edited.count)} siguen sin guardar en este equipo.`));
  const { state, ahead, behind } = overview.published;
  if (state === "no_upstream" && overview.saved.hasCommits) lines.push(say(`${branch} is only on this computer; it is not published yet.`, `${branch} solo está en este equipo; aún no está publicada.`));
  if (state === "ahead" || state === "diverged") lines.push(say(`${commits(say, ahead)} on ${branch} not on ${remote} yet.`, `${commits(say, ahead)} de ${branch} aún no están en ${remote}.`));
  if (state === "behind" || state === "diverged") lines.push(say(`${remote} has ${commits(say, behind)} ${branch} does not have yet.`, `${remote} tiene ${commits(say, behind)} que ${branch} aún no tiene.`));
  if (state === "no_remote") lines.push(say("This project is not connected to a remote, so everything stays on this computer.", "Este proyecto no está conectado a un remoto, así que todo se queda en este equipo."));
  const { integration } = overview;
  if (integration.state === "integrated" && integration.targetUnpublished) lines.push(say(`${integration.target} has ${commits(say, integration.targetUnpublished)} not published yet.`, `${integration.target} tiene ${commits(say, integration.targetUnpublished)} sin publicar.`));
  return lines;
}

function nextLabel(next: ReturnType<typeof workOverview>["next"], after: RepoSnapshot, say: Say) {
  const branch = after.currentBranch;
  const remote = next.remote ?? say("the remote", "el remoto");
  switch (next.action) {
    case "finish_pending": return say("Finish or cancel the operation in progress.", "Termina o cancela la operación en curso.");
    case "return_to_branch": return say("Return to a branch.", "Vuelve a una rama.");
    case "save_changes": return say("Review and save your remaining changes.", "Revisa y guarda los cambios que quedan.");
    case "first_save": return say("Make your first save.", "Haz tu primer guardado.");
    case "add_first_files": return say("Add your first files.", "Añade tus primeros archivos.");
    case "combine_diverged": return say(`Choose how to combine ${branch} with ${next.upstream ?? remote}.`, `Elige cómo combinar ${branch} con ${next.upstream ?? remote}.`);
    case "get_latest": return say(`Get the latest from ${next.upstream ?? remote}.`, `Trae lo último de ${next.upstream ?? remote}.`);
    case "connect_remote": return say("Connect a remote when you want to publish.", "Conecta un remoto cuando quieras publicar.");
    case "publish_branch": return say(`Publish ${branch} to ${remote}.`, `Publica ${branch} en ${remote}.`);
    case "publish_saved": return say(`Publish your saved commits to ${remote}.`, `Publica tus commits guardados en ${remote}.`);
    case "integrate": return say(`Integrate ${branch} into ${next.target}.`, `Integra ${branch} en ${next.target}.`);
    case "publish_target": return say(`Publish ${next.target}.`, `Publica ${next.target}.`);
    case "check_remote": return say("Check the remote for new work.", "Revisa el remoto por si hay trabajo nuevo.");
    default: return say("Nothing else is needed right now.", "Ahora mismo no hace falta nada más.");
  }
}
