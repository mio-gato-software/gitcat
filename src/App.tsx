import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bot, Check, ChevronDown, CircleDot,
  Clock3, Cloud, Eye, FileDiff, FolderOpen, GitBranch, GitCommitHorizontal, GitFork,
  GitMerge, Info, Laptop, LoaderCircle, MessageCircle, Plus, RefreshCcw, Search, Send,
  Settings2, ShieldCheck, Sparkles, TerminalSquare, Trash2, UserRound, X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ActionPlan, Branch, Commit, ConversationMessage, LlmConfig, Operation, RepoSnapshot } from "../shared/types";

type ProjectTab = { id: string; snapshot: RepoSnapshot; loadedAt: string };
type ActivityItem = { id: number; label: string; detail: string; tone: "success" | "neutral" | "warning" };
type Toast = { message: string; tone: "success" | "error" };
type InputDialog = { operation: "create_branch" | "merge"; title: string; label: string; value: string };
type Suggestion = { key: string; icon: LucideIcon; label: string } & ({ question: string } | { dialog: InputDialog });
type ConversationTurn = {
  id: number;
  question: string;
  status: "loading" | "ready" | "executing" | "completed" | "cancelled" | "error";
  answer?: string;
  plan?: ActionPlan;
  outcome?: string;
  error?: string;
};

const palette = ["#62d6c8", "#c59bff", "#f0b26e", "#7da7ff", "#ef7c95"];

function formatDate(date: string) {
  if (!date) return "—";
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);
}

function shortPath(path: string) {
  const pieces = path.split(/[\\/]/);
  return pieces.length > 3 ? `…/${pieces.slice(-2).join("/")}` : path;
}

function branchColor(index: number) { return palette[index % palette.length]; }

type PaneWidths = { sidebar: number; inspector: number };

const paneStorageKey = "branchline-pane-widths";
const defaultPanes: PaneWidths = { sidebar: 235, inspector: 330 };
/** The middle column holds the graph, so it keeps a floor no drag can take away. */
const paneRange = { sidebar: [180, 460], inspector: [255, 620], centre: 340 } as const;

function readPaneWidths(): PaneWidths | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(paneStorageKey) ?? "null");
    if (typeof stored?.sidebar === "number" && typeof stored?.inspector === "number" &&
        Number.isFinite(stored.sidebar) && Number.isFinite(stored.inspector)) {
      return { sidebar: stored.sidebar, inspector: stored.inspector };
    }
  } catch { /* a corrupt entry just means the defaults */ }
  return undefined;
}

function clamp(value: number, min: number, max: number) { return Math.min(Math.max(value, min), max); }

/** Keeps both side panes inside their own range and never lets them squeeze the graph below its floor. */
function clampPanes({ sidebar, inspector }: PaneWidths, total: number): PaneWidths {
  const room = total > 0 ? total - paneRange.centre : Number.POSITIVE_INFINITY;
  const nextSidebar = clamp(sidebar, paneRange.sidebar[0], Math.min(paneRange.sidebar[1], room - paneRange.inspector[0]));
  const nextInspector = clamp(inspector, paneRange.inspector[0], Math.min(paneRange.inspector[1], room - nextSidebar));
  return { sidebar: Math.round(nextSidebar), inspector: Math.round(nextInspector) };
}

function plural(count: number, singular: string, many: string) { return `${count} ${count === 1 ? singular : many}`; }

const baseBranchNames = ["main", "master", "develop", "trunk"];

/**
 * The panel offers what this repository needs right now, so the shortcuts never repeat what the
 * history and changes views already show. They are still ordinary requests: the model decides what
 * each one means and answers or plans accordingly.
 */
function suggestionsFor(snapshot: RepoSnapshot): Suggestion[] {
  const current = snapshot.branches.find((branch) => branch.isCurrent);
  const branch = current?.name ?? snapshot.currentBranch;
  // A branch that only exists on a remote cannot be merged into anything yet, so it is no base.
  const base = baseBranchNames
    .map((name) => snapshot.branches.find((item) => item.name === name))
    .find((item) => item && !item.isCurrent && item.presence !== "remote");
  const options: Suggestion[] = [];

  if (snapshot.isRebasing) options.push({
    key: "rebase",
    icon: AlertTriangle,
    label: "Terminar el rebase en curso",
    question: `El rebase de ${branch} está a medias. Dime en qué punto quedó, qué falta por resolver y cómo lo termino sin perder trabajo.`
  });
  if (snapshot.isDirty) options.push({
    key: "changes",
    icon: FileDiff,
    label: snapshot.changes.length === 1 ? "Revisar mi cambio sin confirmar" : `Revisar mis ${plural(snapshot.changes.length, "cambio", "cambios")} sin confirmar`,
    question: "Explícame qué hacen mis cambios sin confirmar, agrúpalos por intención y propón un mensaje de commit."
  });
  if (current?.behind) options.push({
    key: "behind",
    icon: ArrowDownToLine,
    label: `Traer ${plural(current.behind, "commit nuevo", "commits nuevos")} del remoto`,
    question: current.behind === 1
      ? `Integra en ${branch} el commit que ya está en ${current.upstream ?? "el remoto"}.`
      : `Integra en ${branch} los ${current.behind} commits que ya están en ${current.upstream ?? "el remoto"}.`
  });
  if (current?.ahead) options.push({
    key: "ahead",
    icon: ArrowUpFromLine,
    label: `Revisar ${plural(current.ahead, "commit", "commits")} sin publicar`,
    question: current.ahead === 1
      ? `Resume el commit de ${branch} que todavía no está publicado y avísame si hay algo riesgoso antes de subirlo.`
      : `Resume los ${current.ahead} commits de ${branch} que todavía no están publicados y avísame si hay algo riesgoso antes de subirlos.`
  });
  if (!snapshot.remotes.length) options.push({
    key: "publish",
    icon: Cloud,
    label: "Publicar este repositorio",
    question: "Este repositorio no tiene remoto configurado. Ayúdame a publicarlo en GitHub como repositorio privado."
  });
  if (base) options.push({
    key: "merge",
    icon: GitMerge,
    label: `Fusionar ${base.name} en ${branch}`,
    dialog: { operation: "merge", title: "Fusionar rama", label: "Rama que quieres fusionar", value: base.name }
  });
  if (base) options.push({
    key: "compare",
    icon: GitBranch,
    label: `Comparar ${branch} con ${base.name}`,
    question: `¿En qué se diferencia ${branch} de ${base.name}? Dime qué commits y archivos tiene de más o de menos.`
  });
  options.push({
    key: "cleanup",
    icon: Trash2,
    label: "Buscar ramas que ya puedo borrar",
    question: "¿Qué ramas locales ya están integradas y puedo borrar sin perder trabajo?"
  });
  options.push({
    key: "authors",
    icon: UserRound,
    label: "Ver quién tocó esto último",
    question: "¿Quién hizo los cambios más recientes en este repositorio y sobre qué archivos trabajó cada persona?"
  });
  options.push({
    key: "review",
    icon: Sparkles,
    label: "Revisar el estado del repositorio",
    question: `Revisa el estado de ${branch}: dime si hay algo que deba atender antes de seguir trabajando.`
  });

  return options.slice(0, 3);
}

export default function App() {
  const [projects, setProjects] = useState<ProjectTab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [branchFilter, setBranchFilter] = useState("");
  const [commitFilter, setCommitFilter] = useState("");
  const [request, setRequest] = useState("");
  const [conversations, setConversations] = useState<Record<string, ConversationTurn[]>>({});
  const [refreshingPath, setRefreshingPath] = useState<string>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({ provider: "openai", model: "luna", configured: false });
  const [toast, setToast] = useState<Toast>();
  const [view, setView] = useState<"history" | "changes">("history");
  const [selectedCommit, setSelectedCommit] = useState<Commit>();
  const [inputDialog, setInputDialog] = useState<InputDialog>();
  const [commitFormOpen, setCommitFormOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [panes, setPanes] = useState<PaneWidths | undefined>(readPaneWidths);
  const requestSequence = useRef(0);
  const activitySequence = useRef(0);
  const conversationSequence = useRef(0);
  const activityTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const workspaceRestored = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLElement>(null);

  const active = projects.find((project) => project.id === activeId);
  const snapshot = active?.snapshot;
  const conversation = snapshot ? conversations[snapshot.path] ?? [] : [];
  const planning = conversation.some((turn) => turn.status === "loading" || turn.status === "executing");
  const paneStyle = panes
    ? { "--sidebar-w": `${panes.sidebar}px`, "--inspector-w": `${panes.inspector}px` } as CSSProperties
    : undefined;

  // Adopt whatever widths the stylesheet chose for this window, so the handles start on the real borders.
  useLayoutEffect(() => {
    if (panes || !layoutRef.current) return;
    const columns = getComputedStyle(layoutRef.current).gridTemplateColumns.split(" ").map(Number.parseFloat);
    if (columns.length === 3 && columns.every(Number.isFinite)) setPanes({ sidebar: columns[0], inspector: columns[2] });
  }, [panes, snapshot, workspaceReady, exploring, config.configured]);

  useEffect(() => {
    if (panes) try { localStorage.setItem(paneStorageKey, JSON.stringify(panes)); } catch { /* a full quota must not break resizing */ }
  }, [panes]);

  /**
   * Widths saved on a wide screen may not fit a narrower window, so they are pulled back inside the
   * available room on mount and whenever the window changes size. Unchanged widths keep the same
   * object, so a resize that needs no correction costs no render.
   */
  useEffect(() => {
    const reclamp = () => {
      const total = availableWidth();
      if (!total) return;
      setPanes((current) => {
        if (!current) return current;
        const next = clampPanes(current, total);
        return next.sidebar === current.sidebar && next.inspector === current.inspector ? current : next;
      });
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [snapshot, panes]);

  /**
   * The room the three columns have to share. Measured on the container, never on the grid itself:
   * a grid whose columns already overflow reports its own stretched width and would confirm any size.
   */
  const availableWidth = () => layoutRef.current?.parentElement?.clientWidth ?? 0;

  const resizePane = (edge: keyof PaneWidths, width: number) => {
    const total = availableWidth();
    setPanes((current) => current && clampPanes({ ...current, [edge]: width }, total));
  };

  const startResize = (edge: keyof PaneWidths) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panes || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panes[edge];
    handle.setPointerCapture(event.pointerId);
    // The sidebar grows to the right, the inspector to the left, so their deltas have opposite signs.
    const move = (moveEvent: PointerEvent) => resizePane(edge, startWidth + (edge === "sidebar" ? moveEvent.clientX - startX : startX - moveEvent.clientX));
    const stop = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const nudgePane = (edge: keyof PaneWidths, delta: number) => { if (panes) resizePane(edge, panes[edge] + delta); };
  const resetPane = (edge: keyof PaneWidths) => resizePane(edge, defaultPanes[edge]);

  useEffect(() => {
    window.branchline.getLlmConfig().then(setConfig).catch((error) => {
      setToast({ message: error instanceof Error ? error.message : "No se pudo leer la configuración.", tone: "error" });
    });
    window.branchline.restoreWorkspace().then((workspace) => {
      const loadedAt = new Date().toISOString();
      const restored = workspace.projects.map((project) => ({ id: project.path, snapshot: project, loadedAt }));
      setProjects(restored);
      setActiveId(restored.find((project) => project.snapshot.path === workspace.activePath)?.id ?? restored[0]?.id);
    }).catch((error) => {
      setToast({ message: error instanceof Error ? error.message : "No se pudieron restaurar los proyectos.", tone: "error" });
    }).finally(() => {
      workspaceRestored.current = true;
      setWorkspaceReady(true);
    });
  }, []);

  useEffect(() => {
    if (!workspaceRestored.current || !workspaceReady) return;
    const paths = projects.map((project) => project.snapshot.path);
    const activePath = projects.find((project) => project.id === activeId)?.snapshot.path;
    window.branchline.saveWorkspace(paths, activePath).catch((error) => {
      setToast({ message: error instanceof Error ? error.message : "No se pudo guardar el workspace.", tone: "error" });
    });
  }, [projects, activeId, workspaceReady]);

  useEffect(() => () => {
    for (const timer of activityTimers.current.values()) clearTimeout(timer);
    activityTimers.current.clear();
  }, []);

  useEffect(() => {
    requestSequence.current += 1;
    setRequest("");
    setBranchFilter("");
    setCommitFilter("");
    setView("history");
    setCommitFormOpen(false);
    setCommitMessage("");
    setGeneratingDescription(false);
  }, [activeId]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conversation]);

  const dismissActivity = (id: number) => {
    const timer = activityTimers.current.get(id);
    if (timer) clearTimeout(timer);
    activityTimers.current.delete(id);
    setActivity((items) => items.filter((item) => item.id !== id));
  };

  const addActivity = (item: Omit<ActivityItem, "id">) => {
    const id = ++activitySequence.current;
    setActivity((items) => [{ ...item, id }, ...items].slice(0, 4));
    const timer = setTimeout(() => {
      activityTimers.current.delete(id);
      setActivity((items) => items.filter((activityItem) => activityItem.id !== id));
    }, item.tone === "warning" ? 10_000 : 6_000);
    activityTimers.current.set(id, timer);
  };

  const updateSnapshot = (path: string, next: RepoSnapshot) => {
    setProjects((items) => items.map((project) => project.snapshot.path === path
      ? { ...project, snapshot: next, loadedAt: new Date().toISOString() }
      : project));
  };

  const openProject = async () => {
    try {
      const next = await window.branchline.selectProject();
      if (!next) return;
      const existing = projects.find((project) => project.snapshot.path === next.path);
      if (existing) { updateSnapshot(next.path, next); setActiveId(existing.id); return; }
      const id = `${next.path}-${Date.now()}`;
      setProjects((items) => [...items, { id, snapshot: next, loadedAt: new Date().toISOString() }]);
      setActiveId(id);
      addActivity({ label: "Proyecto abierto", detail: next.name, tone: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "No se pudo abrir el proyecto.", tone: "error" });
    }
  };

  const closeProject = (id: string) => {
    setProjects((items) => {
      const index = items.findIndex((project) => project.id === id);
      const remaining = items.filter((project) => project.id !== id);
      if (activeId === id) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id);
      return remaining;
    });
  };

  const refreshProject = async (path = snapshot?.path, announce = true) => {
    if (!path || refreshingPath) return;
    setRefreshingPath(path);
    try {
      const next = await window.branchline.getSnapshot(path);
      updateSnapshot(path, next);
      if (announce) addActivity({ label: "Estado actualizado", detail: next.currentBranch, tone: "neutral" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "No se pudo actualizar el estado.", tone: "error" });
    } finally { setRefreshingPath(undefined); }
  };

  const updateTurn = (path: string, id: number, update: (turn: ConversationTurn) => ConversationTurn) => {
    setConversations((items) => ({
      ...items,
      [path]: (items[path] ?? []).map((turn) => turn.id === id ? update(turn) : turn)
    }));
  };

  const addTurn = (path: string, question: string) => {
    const turn: ConversationTurn = { id: ++conversationSequence.current, question, status: "loading" };
    setConversations((items) => ({ ...items, [path]: [...(items[path] ?? []), turn] }));
    return turn.id;
  };

  const conversationContext = (turns: ConversationTurn[]): ConversationMessage[] => turns.flatMap((turn) => {
    const response = turn.answer ?? turn.error ?? turn.outcome ?? (turn.plan
      ? `${turn.plan.allowed ? "Plan" : "Rechazo"}: ${turn.plan.summary}. ${turn.plan.rationale}`
      : undefined);
    return response ? [{ role: "user" as const, content: turn.question }, { role: "assistant" as const, content: response }] : [];
  });

  const showPlan = async (question: string, loader: () => Promise<ActionPlan>, path = snapshot?.path) => {
    if (!path || planning) return;
    const turnId = addTurn(path, question);
    try {
      const plan = await loader();
      if (plan.repoPath !== path) throw new Error("El plan pertenece a otro repositorio.");
      if (plan.answer) {
        updateTurn(path, turnId, (turn) => ({ ...turn, answer: plan.answer, status: "completed" }));
        addActivity({ label: "Respuesta preparada", detail: plan.summary, tone: "neutral" });
        return;
      }
      updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: plan.allowed ? "ready" : "completed" }));
      addActivity({
        label: plan.allowed ? "Plan preparado" : plan.kind === "question" ? "El asistente pregunta" : "Solicitud rechazada",
        detail: plan.summary,
        tone: plan.kind === "refusal" ? "warning" : "neutral"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo preparar la acción.";
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
    }
  };

  const propose = async (text: string) => {
    if (!snapshot || !text.trim()) return;
    const question = text.trim();
    const path = snapshot.path;
    const context = conversationContext(conversations[path] ?? []);
    setRequest("");
    await showPlan(question, () => window.branchline.planAction(path, question, context), path);
  };

  const prepare = async (operation: Operation, args: Record<string, string> = {}, question?: string) => {
    if (!snapshot) return;
    const labels: Partial<Record<Operation, string>> = {
      checkout: `Cambiar a la rama ${args.name}`,
      create_branch: `Crear la rama ${args.name}`,
      delete_branch: `Eliminar la rama ${args.name}`,
      fetch: "Actualizar las referencias remotas",
      push: "Publicar la rama actual",
      merge: `Fusionar la rama ${args.name}`,
      rebase: `Rebasear sobre ${args.onto}`,
      abort_rebase: "Abortar el rebase en curso",
      continue_rebase: "Continuar el rebase",
      commit: `Crear un commit: ${args.message}`,
      github_create_repo: `Crear el repositorio privado ${args.owner}/${args.name} en ${args.host}`
    };
    const path = snapshot.path;
    await showPlan(question ?? labels[operation] ?? "Preparar una operación Git", () => window.branchline.prepareOperation(path, operation, args), path);
  };

  const applyPlan = async (turnId: number, plan: ActionPlan) => {
    if (!plan.allowed || planning) return;
    await runPlan(turnId, plan);
  };

  const runPlan = async (turnId: number, plan: ActionPlan) => {
    updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, status: "executing" }));
    try {
      const result = await window.branchline.executePlan(plan.repoPath, plan.id);
      updateSnapshot(plan.repoPath, result.snapshot);
      if (result.error) {
        // A sequence that stopped halfway did change the repository: show what ran, not only the failure.
        const progress = plan.steps.length > 1 ? result.output : undefined;
        updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, outcome: progress, error: result.error, status: "error" }));
        addActivity({ label: "Git requiere atención", detail: result.error, tone: "warning" });
        setToast({ message: result.error, tone: "error" });
      } else {
        const outcome = result.output || `${plan.summary} completado.`;
        updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, outcome, status: "completed" }));
        addActivity({ label: "Acción ejecutada", detail: plan.command, tone: "success" });
        setToast({ message: outcome, tone: "success" });
        if (plan.steps.some((step) => step.operation === "commit")) {
          setCommitMessage("");
          setCommitFormOpen(false);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git no pudo completar la acción.";
      updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      setToast({ message, tone: "error" });
      await refreshProject(plan.repoPath, false);
    }
  };

  /**
   * A double click on a branch is the whole intent, so it prepares the switch and runs it. Anything
   * that gets in the way — a dirty tree, a branch that vanished — is reported in the assistant column
   * instead of being swallowed.
   */
  const switchBranch = async (name: string) => {
    if (!snapshot || planning) return;
    const path = snapshot.path;
    const turnId = addTurn(path, `Cambiar a la rama ${name}`);
    try {
      const plan = await window.branchline.prepareOperation(path, "checkout", { name });
      if (plan.repoPath !== path) throw new Error("El plan pertenece a otro repositorio.");
      if (!plan.allowed) {
        updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: "completed" }));
        addActivity({ label: "No se pudo cambiar de rama", detail: plan.summary, tone: "warning" });
        return;
      }
      updateTurn(path, turnId, (turn) => ({ ...turn, plan }));
      await runPlan(turnId, plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo cambiar de rama.";
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      addActivity({ label: "No se pudo cambiar de rama", detail: message, tone: "warning" });
    }
  };

  const submitInputDialog = () => {
    if (!inputDialog?.value.trim()) return;
    const args: Record<string, string> = { name: inputDialog.value.trim() };
    const operation = inputDialog.operation;
    setInputDialog(undefined);
    void prepare(operation, args);
  };

  const openCommitForm = () => {
    if (!snapshot?.changes.length) return;
    setView("changes");
    setCommitFormOpen(true);
  };

  const generateDescription = async () => {
    if (!snapshot?.changes.length || generatingDescription) return;
    const repoPath = snapshot.path;
    const stateId = snapshot.stateId;
    const sequence = requestSequence.current;
    setGeneratingDescription(true);
    try {
      const result = await window.branchline.generateCommitDescription(repoPath);
      if (requestSequence.current === sequence && result.stateId === stateId) {
        setCommitMessage(result.description);
        setCommitFormOpen(true);
      }
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "No se pudo generar la descripción.", tone: "error" });
      await refreshProject(repoPath, false);
    } finally { setGeneratingDescription(false); }
  };

  const prepareCommit = () => {
    const message = commitMessage.trim();
    if (!snapshot?.changes.length || !message || message.length > 120) return;
    void prepare("commit", { message });
  };

  /** Suggestions are ordinary questions: the model answers them, in whatever language they arrive. */
  const askSuggestion = (question: string) => { void propose(question); };

  // The list now includes branches that only exist on a remote, so the count has to tell them apart.
  const branchCount = useMemo(() => ({
    local: snapshot?.branches.filter((branch) => branch.presence !== "remote").length ?? 0,
    remoteOnly: snapshot?.branches.filter((branch) => branch.presence === "remote").length ?? 0
  }), [snapshot]);
  const filteredBranches = useMemo(() => snapshot?.branches.filter((branch) => branch.name.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase())) ?? [], [snapshot, branchFilter]);
  const filteredCommits = useMemo(() => snapshot?.commits.filter((commit) => {
    const query = commitFilter.toLocaleLowerCase();
    return !query || commit.subject.toLocaleLowerCase().includes(query) || commit.author.toLocaleLowerCase().includes(query) || commit.shortHash.toLocaleLowerCase().includes(query);
  }) ?? [], [snapshot, commitFilter]);

  return (
    <div className={`app-shell platform-${window.branchline.platform}`}>
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><GitFork size={18} strokeWidth={2.4} /></div><span>branchline</span><span className="brand-beta">BETA</span></div>
        <div className="window-tabs" role="tablist" aria-label="Proyectos abiertos">
          {projects.map((project) => <div key={project.id} className={`window-tab ${project.id === activeId ? "active" : ""}`}>
            <button role="tab" aria-selected={project.id === activeId} onClick={() => setActiveId(project.id)}><GitBranch size={14} /><span>{project.snapshot.name}</span></button>
            <button className="tab-close" onClick={() => closeProject(project.id)} aria-label={`Cerrar ${project.snapshot.name}`}><X size={13} /></button>
          </div>)}
          <button className="icon-button tab-add" onClick={() => void openProject()} aria-label="Abrir proyecto"><Plus size={16} /></button>
        </div>
        <div className="top-actions"><div className="sync-pill"><span className="pulse-dot" /> Local</div><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Configuración"><Settings2 size={17} /></button></div>
      </header>

      {!workspaceReady ? <div className="workspace-loading"><LoaderCircle className="spin" size={24} /><span>Restaurando proyectos…</span></div> : !config.configured && !exploring ? <ProviderRequired onConfigure={() => setSettingsOpen(true)} onExplore={() => setExploring(true)} /> : !snapshot ? <Welcome openProject={openProject} /> : <>
        {!config.configured && <div className="provider-banner" role="status"><Eye size={14} /><span><strong>Estás viendo la interfaz sin proveedor.</strong> Git funciona, pero el asistente no puede interpretar nada ni planificar acciones.</span><button className="outline-button small" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /> Configurar</button></div>}
        <div className="workspace-header">
          <div className="project-title"><div className="folder-icon"><FolderOpen size={17} /></div><div><div className="eyebrow">PROYECTO ACTIVO</div><div className="project-name">{snapshot.name}<span className="project-path" title={snapshot.path}>{shortPath(snapshot.path)}</span></div></div></div>
          <div className="workspace-actions"><button className="ghost-button" onClick={() => void refreshProject()} disabled={Boolean(refreshingPath)}>{refreshingPath === snapshot.path ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />} Actualizar</button><button className="outline-button" onClick={() => void prepare("fetch")} disabled={planning}><ArrowDownToLine size={15} /> Fetch</button><button className="primary-button" onClick={() => void prepare("push")} disabled={planning}><ArrowUpFromLine size={15} /> Push</button></div>
        </div>

        <main className="main-layout" ref={layoutRef} style={paneStyle}>
          {panes && <PaneDivider edge="sidebar" width={panes.sidebar} onPointerDown={startResize("sidebar")} onNudge={(delta) => nudgePane("sidebar", delta)} onReset={() => resetPane("sidebar")} />}
          {panes && <PaneDivider edge="inspector" width={panes.inspector} onPointerDown={startResize("inspector")} onNudge={(delta) => nudgePane("inspector", delta)} onReset={() => resetPane("inspector")} />}
          <aside className="sidebar">
            <div className="sidebar-section branch-section"><div className="section-heading"><span>RAMAS</span><button className="mini-icon" onClick={() => setInputDialog({ operation: "create_branch", title: "Nueva rama", label: "Nombre de la rama", value: "" })} aria-label="Crear rama"><Plus size={14} /></button></div><div className="search-field"><Search size={14} /><input aria-label="Filtrar ramas" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} placeholder="Filtrar ramas" /></div><div className="branch-list">
              {filteredBranches.map((branch, index) => <BranchRow branch={branch} index={index} key={branch.name} busy={planning} onSwitch={() => void prepare("checkout", { name: branch.name })} onSwitchNow={() => void switchBranch(branch.name)} onDelete={() => void prepare("delete_branch", { name: branch.name })} />)}
              {!filteredBranches.length && <div className="empty-small">No hay ramas que coincidan.</div>}
            </div></div>
            <div className="sidebar-section"><div className="section-heading"><span>REMOTOS</span><button className="mini-icon" onClick={() => void prepare("fetch")} aria-label="Actualizar remotos" disabled={planning}><RefreshCcw size={13} /></button></div>{snapshot.remotes.length ? snapshot.remotes.map((remote) => <div className="remote-row" key={remote}><Cloud size={14} /><span>{remote}</span><span className="remote-count">configurado</span></div>) : <div className="empty-small">Sin remotos configurados.</div>}</div>
            <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={15} /><span>Acciones protegidas<br /><small>Git se ejecuta con una lista segura.</small></span></div><button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> Configuración LLM <ChevronDown size={13} /></button></div>
          </aside>

          <section className="graph-area">
            <div className="graph-toolbar"><div className="view-tabs"><button className={`view-tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>Historial</button><button className={`view-tab ${view === "changes" ? "active" : ""}`} onClick={() => setView("changes")}>Cambios <span className="count-badge">{snapshot.changes.length}</span></button></div>{view === "history" && <div className="graph-tools"><div className="search-field commit-search"><Search size={14} /><input aria-label="Buscar commits" value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} placeholder="Buscar commits" /></div></div>}</div>
            {snapshot.isRebasing && <div className="rebase-banner"><AlertTriangle size={16} /><div><strong>Rebase en curso</strong><span>Resuelve los conflictos y elige cómo continuar.</span></div><button className="outline-button small" onClick={() => void prepare("continue_rebase")}>Continuar</button><button className="danger-link" onClick={() => void prepare("abort_rebase")}>Abortar</button></div>}
            <div className="current-branch-card"><div className="branch-dot" style={{ background: branchColor(0) }} /><div><span className="eyebrow">RAMA ACTUAL</span><div className="current-branch-name">{snapshot.currentBranch}<span className="branch-status">{snapshot.isDirty ? "Cambios locales" : "Limpia"}</span></div></div><div className="branch-stats"><span><ArrowDownToLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.behind ?? 0} detrás</span><span><ArrowUpFromLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.ahead ?? 0} adelante</span></div><button className="outline-button small" onClick={openCommitForm} disabled={!snapshot.isDirty || planning}><GitCommitHorizontal size={14} /> Commit</button></div>
            {view === "history" ? <div className="graph-scroll"><div className="graph-header"><span>HISTORIAL DE COMMITS</span><span>{filteredCommits.length} commits visibles</span></div>{filteredCommits.length ? filteredCommits.map((commit, index) => <CommitRow commit={commit} index={index} key={commit.hash} onSelect={() => setSelectedCommit(commit)} />) : <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>No hay commits que mostrar</strong><span>El repositorio todavía no tiene historial o el filtro no coincide.</span></div>}</div>
              : <ChangesView snapshot={snapshot} formOpen={commitFormOpen} message={commitMessage} generating={generatingDescription} busy={planning} onOpenForm={() => setCommitFormOpen(true)} onMessageChange={setCommitMessage} onGenerate={() => void generateDescription()} onPrepare={prepareCommit} />}
          </section>

          <aside className="inspector"><div className="inspector-header"><div><div className="eyebrow">ASISTENTE DE RAMAS</div><h2>¿Qué quieres saber o hacer?</h2></div><div className="assistant-icon"><Bot size={18} /></div></div><p className="assistant-copy">{config.configured ? "Pregunta sobre el repositorio o describe una acción de Git. Las acciones se muestran como un plan verificable antes de ejecutarse." : "Sin proveedor LLM el asistente no puede interpretar nada. Configúralo para preguntar o describir acciones; el resto de la interfaz funciona igual."}</p>{conversation.length === 0 && config.configured && <div className="suggestion-list">{suggestionsFor(snapshot).map((suggestion) => <button key={suggestion.key} onClick={() => "question" in suggestion ? askSuggestion(suggestion.question) : setInputDialog(suggestion.dialog)} disabled={planning} title={"question" in suggestion ? suggestion.question : suggestion.label}><suggestion.icon size={15} /><span>{suggestion.label}</span></button>)}</div>}<div className="conversation-toolbar"><span>{conversation.length ? `${conversation.length} mensaje${conversation.length === 1 ? "" : "s"}` : "Nueva conversación"}</span><button onClick={() => setConversations((items) => ({ ...items, [snapshot.path]: [] }))} disabled={!conversation.length || planning}><Trash2 size={12} /> Limpiar conversación</button></div><div className="conversation" aria-live="polite">{conversation.map((turn) => <ConversationEntry key={turn.id} turn={turn} busy={planning} onApply={(plan) => void applyPlan(turn.id, plan)} onDismiss={() => updateTurn(snapshot.path, turn.id, (item) => ({ ...item, status: "cancelled", outcome: "Plan descartado sin modificar el repositorio." }))} />)}<div ref={conversationEnd} /></div><div className="chat-compose"><textarea aria-label="Solicitud para el asistente" disabled={!config.configured} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder={config.configured ? "Ej. ¿quién trabajó en esta rama la última vez?" : "Configura un proveedor LLM para escribirle al asistente"} rows={3} /><button className="send-button" aria-label="Preparar solicitud" onClick={() => void propose(request)} disabled={planning || !request.trim() || !config.configured}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div></aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className="status-good"><CircleDot size={12} /> {snapshot.isDirty ? `${snapshot.changes.length} cambio${snapshot.changes.length === 1 ? "" : "s"}` : "Sin cambios locales"}</span><span className="status-separator" /><span>{branchCount.local === 1 ? "1 rama local" : `${branchCount.local} ramas locales`}{branchCount.remoteOnly ? `, ${branchCount.remoteOnly} solo en el remoto` : ""}</span></div><div className="status-right"><span><Clock3 size={12} /> Última lectura {formatDate(active.loadedAt)}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : "LLM no configurado"}</span></div></footer>
      </>}
      {activity.length > 0 && <div className="activity-dock" aria-live="polite">{activity.slice(0, 3).map((item) => <div className={`activity-item ${item.tone}`} role={item.tone === "warning" ? "alert" : "status"} key={item.id}><span className="activity-symbol">{item.tone === "success" ? <Check size={13} /> : item.tone === "warning" ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={13} />}</span><div className="activity-copy"><strong>{item.label}</strong><span title={item.detail}>{item.detail}</span></div><button className="activity-close" onClick={() => dismissActivity(item.id)} aria-label={`Cerrar notificación: ${item.label}`}><X size={14} /></button></div>)}</div>}
      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{toast.message}</span><button onClick={() => setToast(undefined)} aria-label="Cerrar notificación"><X size={14} /></button></div>}
      {settingsOpen && <SettingsModal config={config} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); setToast({ message: "Configuración guardada.", tone: "success" }); }} />}
      {inputDialog && <InputModal dialog={inputDialog} branches={snapshot?.branches ?? []} onChange={(value) => setInputDialog({ ...inputDialog, value })} onClose={() => setInputDialog(undefined)} onSubmit={submitInputDialog} />}
      {selectedCommit && <CommitModal commit={selectedCommit} onClose={() => setSelectedCommit(undefined)} />}
    </div>
  );
}

function Welcome({ openProject }: { openProject: () => Promise<void> }) {
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><GitFork size={30} /></div><div className="eyebrow">WORKSPACE DE RAMAS</div><h1>Tu Git, más claro.</h1><p>Abre un proyecto para explorar ramas, entender quién cambió qué y preparar operaciones Git con ayuda de tu proveedor LLM.</p><button className="primary-button welcome-button" onClick={() => void openProject()}><FolderOpen size={16} /> Abrir proyecto</button><div className="welcome-features"><span><GitMerge size={14} /> Rebase seguro</span><span><MessageCircle size={14} /> Lenguaje natural</span><span><ShieldCheck size={14} /> Comandos protegidos</span></div><div className="welcome-footnote">Proveedor LLM configurado</div></div></div>;
}

/**
 * Branchline interprets every request with the configured model — there is no keyword fallback — so
 * the provider is a hard requirement rather than an optional extra.
 */
function ProviderRequired({ onConfigure, onExplore }: { onConfigure: () => void; onExplore: () => void }) {
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><Sparkles size={30} /></div><div className="eyebrow">PROVEEDOR LLM REQUERIDO</div><h1>Conecta tu modelo.</h1><p>Branchline entiende lo que escribes con el modelo que configures, en cualquier idioma. Sin proveedor no hay interpretación: no existe un modo de reglas locales.</p><button className="primary-button welcome-button" onClick={onConfigure}><Settings2 size={16} /> Configurar proveedor</button><button className="ghost-button welcome-button" onClick={onExplore}><Eye size={15} /> Ver la interfaz sin configurar</button><div className="welcome-features"><span><MessageCircle size={14} /> Cualquier idioma</span><span><ShieldCheck size={14} /> Planes verificados</span><span><Bot size={14} /> Sin palabras clave</span></div><div className="welcome-footnote">La API key se cifra con el almacenamiento seguro del sistema.</div></div></div>;
}

/**
 * The draggable border between two panes. It sits on top of the grid line instead of inside the grid,
 * so the three columns stay a plain template. Arrow keys move it too, and a double click resets it.
 */
function PaneDivider({ edge, width, onPointerDown, onNudge, onReset }: {
  edge: keyof PaneWidths; width: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void; onReset: () => void;
}) {
  const label = edge === "sidebar" ? "Ancho de la columna de ramas" : "Ancho de la columna del asistente";
  const keys: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16 };
  return <div
    className={`pane-divider ${edge}`}
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    aria-valuenow={Math.round(width)}
    aria-valuemin={paneRange[edge][0]}
    aria-valuemax={paneRange[edge][1]}
    tabIndex={0}
    title={`${label} · arrastra, usa las flechas o haz doble clic para restaurarla`}
    onPointerDown={onPointerDown}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      const step = keys[event.key];
      if (step === undefined) return;
      event.preventDefault();
      onNudge(edge === "sidebar" ? step : -step);
    }}
  ><span /></div>;
}

const presenceLabel: Record<Branch["presence"], string> = {
  local: "Solo en local",
  remote: "Solo en el remoto",
  both: "En local y en el remoto"
};

/** Where the branch lives, at a glance: the machine, the cloud, or both. */
function PresenceBadge({ branch }: { branch: Branch }) {
  const detail = branch.remoteRef ? `${presenceLabel[branch.presence]} (${branch.remoteRef})` : presenceLabel[branch.presence];
  return <span className={`branch-presence ${branch.presence}`} title={detail} aria-label={detail} role="img">
    {branch.presence !== "remote" && <Laptop size={12} />}
    {branch.presence !== "local" && <Cloud size={12} />}
  </span>;
}

/**
 * One click prepares the switch as a plan; a double click just does it. The single-click action waits
 * out the double-click window so the same gesture never produces both.
 */
function branchTooltip(branch: Branch) {
  const parts = [branch.name, presenceLabel[branch.presence]];
  // Integration is what tells you whether deleting the branch would lose anything.
  if (branch.mergedInto.length) parts.push(`ya integrada en ${branch.mergedInto.join(" y ")}`);
  else if (!branch.isCurrent) parts.push("sin integrar en la rama por defecto ni en la actual");
  return parts.join(" · ");
}

function BranchRow({ branch, index, busy, onSwitch, onSwitchNow, onDelete }: { branch: Branch; index: number; busy: boolean; onSwitch: () => void; onSwitchNow: () => void; onDelete: () => void }) {
  const pendingClick = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pendingClick.current), []);
  const click = () => {
    window.clearTimeout(pendingClick.current);
    pendingClick.current = window.setTimeout(onSwitch, 230);
  };
  const doubleClick = () => {
    window.clearTimeout(pendingClick.current);
    onSwitchNow();
  };
  return <div className={`branch-row ${branch.isCurrent ? "current" : ""} ${branch.presence}`}><button className="branch-main" onClick={click} onDoubleClick={doubleClick} disabled={branch.isCurrent || busy} aria-current={branch.isCurrent} title={branch.isCurrent ? branchTooltip(branch) : `Doble clic para cambiar a ${branchTooltip(branch)}`}><span className="branch-color" style={{ background: branchColor(index) }} /><GitBranch size={14} /><span className="branch-label">{branch.name}</span><PresenceBadge branch={branch} />{branch.isCurrent && <span className="current-pill">actual</span>}{(branch.ahead > 0 || branch.behind > 0) && <span className="ahead-behind">{branch.ahead > 0 ? `↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}</button>{!branch.isCurrent && branch.presence !== "remote" && <button className="branch-delete" onClick={onDelete} disabled={busy} aria-label={`Eliminar rama ${branch.name}`} title={branch.mergedInto.length ? `Eliminar ${branch.name}: ya integrada en ${branch.mergedInto.join(" y ")}, no se pierde trabajo` : `Eliminar ${branch.name}: sin integrar, Git rechazará el borrado si se perdería trabajo`}><Trash2 size={12} /></button>}</div>;
}

function CommitRow({ commit, index, onSelect }: { commit: Commit; index: number; onSelect: () => void }) {
  return <div className="commit-row"><div className="graph-track"><span className="track-line" /><span className="commit-node" style={{ borderColor: branchColor(index), boxShadow: `0 0 0 4px ${branchColor(index)}18` }} /></div><div className="commit-content"><div className="commit-main"><div className="commit-subject">{commit.subject || "Commit sin mensaje"}</div><div className="commit-meta"><span className="hash-chip">{commit.shortHash}</span><span>{commit.author}</span><span className="meta-divider">·</span><span>{formatDate(commit.date)}</span></div></div><div className="commit-refs">{commit.refs.slice(0, 3).map((ref) => <span className="ref-tag" key={ref}><GitBranch size={11} />{ref.replace("HEAD -> ", "")}</span>)}</div><button className="commit-more" onClick={onSelect} aria-label={`Ver detalles del commit ${commit.shortHash}`}><Info size={15} /></button></div></div>;
}

function changeStatus(code: string) {
  if (code.includes("?")) return "Sin seguimiento";
  if (code.includes("R")) return "Renombrado";
  if (code.includes("C")) return "Copiado";
  if (code.includes("A")) return "Añadido";
  if (code.includes("D")) return "Eliminado";
  if (code.includes("U")) return "Conflicto";
  return "Modificado";
}

function ChangesView({ snapshot, formOpen, message, generating, busy, onOpenForm, onMessageChange, onGenerate, onPrepare }: { snapshot: RepoSnapshot; formOpen: boolean; message: string; generating: boolean; busy: boolean; onOpenForm: () => void; onMessageChange: (message: string) => void; onGenerate: () => void; onPrepare: () => void }) {
  const hasChanges = snapshot.changes.length > 0;
  return <div className="changes-view"><div className="changes-heading"><div><span className="eyebrow">ÁRBOL DE TRABAJO · {snapshot.currentBranch}</span><h3>{hasChanges ? `${snapshot.changes.length} cambios locales` : "Todo está limpio"}</h3></div><div className="changes-heading-actions"><button className="outline-button small" onClick={onOpenForm} disabled={!hasChanges || busy}><GitCommitHorizontal size={14} /> Commit</button><FileDiff size={19} /></div></div>{hasChanges ? <><div className="change-list">{snapshot.changes.map((change, index) => <div className="change-row" key={`${change.path}-${index}`}><span className={`change-code code-${change.code[0]?.toLowerCase()}`}>{change.code}</span><span className="change-status">{changeStatus(change.code)}</span><span className="change-path" title={change.path}>{change.path}</span></div>)}</div>{formOpen && <div className="commit-form"><div className="commit-form-heading"><div><span className="eyebrow">NUEVO COMMIT</span><h3>Describe estos cambios</h3></div><button className="outline-button" onClick={onGenerate} disabled={generating || busy}>{generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} Generar descripción</button></div><label htmlFor="commit-description">Mensaje del commit</label><textarea id="commit-description" value={message} onChange={(event) => onMessageChange(event.target.value)} maxLength={120} rows={3} placeholder="Escribe una descripción concisa de los cambios…" /><div className="commit-form-meta"><span>La generación analiza el diff local y sigue el idioma del historial de commits.</span><span>{message.length}/120</span></div><div className="commit-form-actions"><button className="primary-button" onClick={onPrepare} disabled={!message.trim() || busy}><ShieldCheck size={14} /> Preparar commit</button></div></div>}</> : <div className="graph-empty"><Check size={26} /><strong>No hay cambios sin confirmar</strong><span>El árbol de trabajo coincide con el último commit.</span></div>}</div>;
}

function ConversationEntry({ turn, busy, onApply, onDismiss }: { turn: ConversationTurn; busy: boolean; onApply: (plan: ActionPlan) => void; onDismiss: () => void }) {
  // A sequence reports itself step by step, marks included, so it needs no outer verdict icon or colour.
  const sequence = (turn.plan?.steps.length ?? 0) > 1;
  return <article className="conversation-turn"><div className="conversation-question"><span>Tú</span><p>{turn.question}</p></div><div className={`conversation-response ${turn.status === "error" ? "error" : ""}`}><span className="conversation-avatar"><Bot size={13} /></span><div>{turn.status === "loading" && <div className="conversation-loading"><LoaderCircle className="spin" size={14} /> Preparando respuesta…</div>}{turn.answer && <p>{turn.answer}</p>}{turn.plan && (turn.status === "ready" || turn.status === "executing") && <PlanCard plan={turn.plan} onApply={async () => onApply(turn.plan!)} onDismiss={onDismiss} busy={busy || turn.status === "executing"} />}{turn.plan && !turn.plan.allowed && turn.status === "completed" && <PlanCard plan={turn.plan} onApply={async () => undefined} onDismiss={onDismiss} busy={false} />}{turn.outcome && (sequence ? <div className="conversation-report"><span>{turn.outcome}</span></div> : <div className="conversation-outcome"><Check size={13} /><span>{turn.outcome}</span></div>)}{turn.error && <div className="conversation-error"><AlertTriangle size={13} /><span>{turn.error}</span></div>}</div></div></article>;
}

function PlanCard({ plan, onApply, onDismiss, busy }: { plan: ActionPlan; onApply: () => Promise<void>; onDismiss: () => void; busy: boolean }) {
  const asking = plan.kind === "question";
  return <div className={`plan-card ${plan.allowed ? "allowed" : asking ? "asking" : "rejected"}`}><div className="plan-header"><div className="plan-icon">{plan.allowed ? <Sparkles size={15} /> : asking ? <MessageCircle size={15} /> : <AlertTriangle size={15} />}</div><div><strong>{plan.summary}</strong><span>{plan.source === "llm" ? "Interpretado por el proveedor LLM" : "Acción directa validada"}</span></div><button className="mini-icon" onClick={onDismiss} aria-label={asking ? "Descartar pregunta" : "Descartar plan"}><X size={14} /></button></div><p>{plan.rationale}</p>{plan.effects && <ul className="plan-effects">{plan.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}{plan.repositoryPlan && <pre className="repository-plan-json">{JSON.stringify(plan.repositoryPlan, null, 2)}</pre>}{plan.allowed && (plan.steps.length > 1
      ? <ol className="plan-steps">{plan.steps.map((step, index) => <li key={`${step.command}-${index}`}><span className="step-summary">{step.summary}</span><code><TerminalSquare size={11} />{step.command}</code></li>)}</ol>
      : <div className="command-preview"><TerminalSquare size={14} /><code>{plan.command}</code></div>)}
    {plan.allowed && plan.steps.length > 1 && <p className="plan-hint">Al confirmar se ejecutan los {plan.steps.length} pasos en orden. Si alguno falla, el plan se detiene ahí y te digo qué quedó sin hacer.</p>}{plan.allowed ? <div className="plan-actions"><button className="ghost-button" onClick={onDismiss}>Cancelar</button><button className="primary-button" onClick={() => void onApply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {plan.requiresConfirmation ? "Confirmar acción" : "Aplicar"}</button></div> : asking ? <p className="plan-hint">Responde en el cuadro de abajo para continuar.</p> : <button className="ghost-button plan-close" onClick={onDismiss}>Entendido</button>}</div>;
}

function SettingsModal({ config, onClose, onSaved }: { config: LlmConfig; onClose: () => void; onSaved: (config: LlmConfig) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config.model || "luna");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEscape(onClose);
  const save = async () => {
    if (!model.trim()) { setError("Indica un modelo."); return; }
    setSaving(true); setError(undefined);
    try { onSaved(await window.branchline.saveLlmConfig({ apiKey, model, clearApiKey })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo guardar la configuración."); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><div className="eyebrow">PROVEEDOR LLM</div><h2 id="settings-title">Configuración</h2></div><button className="icon-button soft" onClick={onClose} aria-label="Cerrar configuración"><X size={17} /></button></div><div className="provider-card"><div className="provider-logo">AI</div><div><strong>OpenAI</strong><span>Responses API · API key local</span></div><span className={`connected-dot ${config.configured ? "on" : ""}`} /></div><label>API key<input autoFocus type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={config.configured ? "Guardada de forma segura · escribe para reemplazar" : "sk-…"} autoComplete="off" /></label>{config.configured && <label className="checkbox-label"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /> Eliminar la API key guardada</label>}<label>Modelo<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Identificador del modelo" /><small>Usa el identificador de un modelo habilitado en tu proyecto de OpenAI.</small></label><div className="modal-note"><ShieldCheck size={15} /><span>Al guardar se comprueba la key y el modelo contra el proveedor; solo se guardan si responden. La key se cifra con el almacenamiento seguro del sistema y nunca vuelve a la interfaz.</span></div>{error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Guardar</button></div></div></div>;
}

function InputModal({ dialog, branches, onChange, onClose, onSubmit }: { dialog: InputDialog; branches: Branch[]; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  useEscape(onClose);
  const listId = dialog.operation === "merge" ? "branch-options" : undefined;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="input-modal" role="dialog" aria-modal="true" aria-labelledby="input-modal-title" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><div className="modal-heading"><div><div className="eyebrow">OPERACIÓN GIT</div><h2 id="input-modal-title">{dialog.title}</h2></div><button type="button" className="icon-button soft" onClick={onClose} aria-label="Cerrar"><X size={17} /></button></div><label>{dialog.label}<input autoFocus value={dialog.value} onChange={(event) => onChange(event.target.value)} list={listId} maxLength={200} /></label>{listId && <datalist id={listId}>{branches.filter((branch) => !branch.isCurrent).map((branch) => <option value={branch.name} key={branch.name} />)}</datalist>}<div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={!dialog.value.trim()}><GitBranch size={14} /> Preparar</button></div></form></div>;
}

function CommitModal({ commit, onClose }: { commit: Commit; onClose: () => void }) {
  useEscape(onClose);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="commit-modal" role="dialog" aria-modal="true" aria-labelledby="commit-modal-title"><div className="modal-heading"><div><div className="eyebrow">DETALLES DEL COMMIT</div><h2 id="commit-modal-title">{commit.subject || "Commit sin mensaje"}</h2></div><button className="icon-button soft" onClick={onClose} aria-label="Cerrar detalles"><X size={17} /></button></div><dl><div><dt>Hash</dt><dd><code>{commit.hash}</code></dd></div><div><dt>Autor</dt><dd>{commit.author}<span>{commit.email}</span></dd></div><div><dt>Fecha</dt><dd>{formatDate(commit.date)}</dd></div>{commit.refs.length > 0 && <div><dt>Referencias</dt><dd>{commit.refs.join(", ")}</dd></div>}</dl><div className="modal-actions"><button className="primary-button" onClick={onClose}>OK</button></div></div></div>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
}
