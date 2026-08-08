import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowDownWideNarrow, ArrowUpFromLine, Bot, Check, ChevronRight, CircleDot,
  Clock3, Cloud, Eye, EyeOff, FileDiff, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, GitFork,
  ArrowLeftRight, GitMerge, Info, Laptop, Lightbulb, List, ListTree, LoaderCircle, MessageCircle, Palette, Plus, RefreshCcw,
  Search, Send, Settings2, ShieldCheck, Sparkles, Tag, TerminalSquare, Trash2, UserRound, X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { buildBranchTree, filterBranchTree, groupPathFor, prefixOf } from "../shared/branch-tree";
import type { BranchNode } from "../shared/branch-tree";
import { branchSuggestions, namingCompletions, prefixAliases, variantHint } from "../shared/branch-consistency";
import type { BranchSuggestion } from "../shared/branch-consistency";
import { isProtectedBranch, lifecycleLabels, lifecycleOf, staleDays } from "../shared/branch-lifecycle";
import { buildCommitGraph, familyColour, maxLanes } from "../shared/commit-graph";
import type { GraphRow } from "../shared/commit-graph";
import { branchOrderLabels, defaultBranchOrder, isBranchOrder, isMergedIntoDefault, sortBranches } from "../shared/branch-order";
import type { BranchOrder } from "../shared/branch-order";
import type {
  ActionPlan, Branch, Commit, CommitDetail, ConflictProposal, ConflictResolution, ConversationMessage, ExecutionFailure,
  FileChange, HistoryScope, LlmConfig, Operation, PendingOperationKind, RepoSnapshot
} from "../shared/types";

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

/**
 * A remote URL as something you can read at a glance. Both spellings Git accepts say the same thing —
 * `git@host:owner/repo.git` and `https://host/owner/repo.git` — so both collapse to `host/owner/repo`.
 * An SSH alias survives on purpose: on a machine with several accounts, the alias *is* the identity.
 */
function shortRemote(url: string) {
  return url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function remoteLabel(snapshot: RepoSnapshot) {
  const name = snapshot.remotes[0];
  if (!name) return "Sin remoto";
  const url = snapshot.remoteUrls[name];
  const extra = snapshot.remotes.length > 1 ? ` +${snapshot.remotes.length - 1}` : "";
  return `${url ? shortRemote(url) : name}${extra}`;
}

function remoteTitle(snapshot: RepoSnapshot) {
  if (!snapshot.remotes.length) return "Este repositorio no tiene remoto configurado, así que un push no tendría a dónde ir.";
  return snapshot.remotes.map((name) => `${name}: ${snapshot.remoteUrls[name] ?? "sin URL"}`).join("\n");
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

/**
 * Electron wraps anything a handler throws in "Error invoking remote method '…': Error: …", which is
 * plumbing the user never asked about. What is left is the sentence the service actually wrote.
 */
function cleanError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const stripped = message.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
  return stripped || fallback;
}

/**
 * How the branch panel is being read right now. It is a view preference, never a change to the
 * repository, so it lives in the browser storage of this machine and belongs to one repository.
 */
type BranchViewMode = "tree" | "flat";
type BranchView = { mode: BranchViewMode; expanded: string[]; order: BranchOrder; hideMerged: boolean; dismissed: string[] };

/** A stable empty list, so "nothing dismissed yet" does not invalidate a memo on every render. */
const noDismissals: string[] = [];

/**
 * How this repository's history is being read. Scoped to the selected branch by default, because a
 * list of every ref at once cannot answer the question anyone is actually asking of it.
 */
type HistoryPrefs = { scope: HistoryScope; byFamily: boolean };

const historyPrefsStorageKey = (path: string) => `branchline-history:${path}`;

function readHistoryPrefs(path: string): HistoryPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(historyPrefsStorageKey(path)) ?? "null");
    return {
      scope: ["all", "branch", "branch-only"].includes(stored?.scope) ? stored.scope : "branch",
      byFamily: stored?.byFamily !== false
    };
  } catch { /* a corrupt entry just means the defaults */ }
  return { scope: "branch", byFamily: true };
}

function writeHistoryPrefs(path: string, prefs: HistoryPrefs) {
  try { localStorage.setItem(historyPrefsStorageKey(path), JSON.stringify(prefs)); }
  catch { /* a full quota must not break the graph */ }
}

/** What gets scanned. The exact date belongs in a tooltip, and it needs its year to mean anything. */
function relativeTime(date: string) {
  const value = Date.parse(date);
  if (Number.isNaN(value)) return date || "—";
  const seconds = Math.round((Date.now() - value) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] =
    [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(-Math.round(seconds / size), unit);
  return formatter.format(-seconds, "second");
}

function formatDateFull(date: string) {
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(value);
}

const branchViewStorageKey = (path: string) => `branchline-branch-view:${path}`;

function readBranchView(path: string): BranchView | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(branchViewStorageKey(path)) ?? "null");
    if (stored?.mode !== "tree" && stored?.mode !== "flat") return undefined;
    // Preferences saved before an option existed are still valid; the missing ones take their default.
    return {
      mode: stored.mode,
      expanded: Array.isArray(stored.expanded) ? stored.expanded.filter((key: unknown): key is string => typeof key === "string") : [],
      order: isBranchOrder(stored.order) ? stored.order : defaultBranchOrder,
      hideMerged: stored.hideMerged === true,
      dismissed: Array.isArray(stored.dismissed) ? stored.dismissed.filter((id: unknown): id is string => typeof id === "string") : []
    };
  } catch { /* a corrupt entry just means the defaults */ }
  return undefined;
}

function writeBranchView(path: string, view: BranchView) {
  try { localStorage.setItem(branchViewStorageKey(path), JSON.stringify(view)); }
  catch { /* a full quota must not break the panel */ }
}

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
  const [selectedBranch, setSelectedBranch] = useState<string>();
  const [commitFilter, setCommitFilter] = useState("");
  const [request, setRequest] = useState("");
  const [conversations, setConversations] = useState<Record<string, ConversationTurn[]>>({});
  const [refreshingPath, setRefreshingPath] = useState<string>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({ provider: "openai", model: "gpt-5.6-luna", configured: false });
  const [toast, setToast] = useState<Toast>();
  const [view, setView] = useState<"history" | "changes">("history");
  const [selectedCommit, setSelectedCommit] = useState<Commit>();
  const [selectedFile, setSelectedFile] = useState<FileChange>();
  const [proposal, setProposal] = useState<ConflictProposal>();
  const [resolving, setResolving] = useState(false);
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
    setSelectedBranch(undefined);
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
      setToast({ message: cleanError(error, "No se pudo abrir el proyecto."), tone: "error" });
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
      setToast({ message: cleanError(error, "No se pudo actualizar el estado."), tone: "error" });
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
      const unattended = plan.allowed && !plan.requiresConfirmation;
      updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: plan.allowed ? "ready" : "completed" }));
      addActivity({
        label: unattended ? "Acción en curso" : plan.allowed ? "Plan preparado" : plan.kind === "question" ? "El asistente pregunta" : "Solicitud rechazada",
        detail: plan.summary,
        tone: plan.kind === "refusal" ? "warning" : "neutral"
      });
      // Nothing to weigh up: a plan that changes no work does not need a click to say so.
      if (unattended) await runPlan(turnId, plan);
    } catch (error) {
      const message = cleanError(error, "No se pudo preparar la acción.");
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      if (config.configured) await recoverFrom(path, {
        command: question,
        summary: "Preparar la acción solicitada",
        error: message,
        skipped: []
      });
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
      rename_branch: `Renombrar la rama ${args.name} a ${args.to}`,
      fetch: "Actualizar las referencias remotas",
      push: "Publicar la rama actual",
      merge: `Fusionar la rama ${args.name}`,
      rebase: `Rebasear sobre ${args.onto}`,
      abort_operation: "Abortar la operación a medias",
      continue_operation: "Continuar la operación",
      skip_operation: "Saltar el commit atascado",
      resolve_conflict: `Resolver el conflicto de ${args.path}`,
      commit: `Crear un commit: ${args.message}`,
      github_create_repo: `Crear el repositorio privado ${args.owner}/${args.name} en ${args.host}`
    };
    const path = snapshot.path;
    await showPlan(question ?? labels[operation] ?? "Preparar una operación Git", () => window.branchline.prepareOperation(path, operation, args), path);
  };

  const prepareMergeToDefault = async (name: string) => {
    if (!snapshot?.defaultBranch) return;
    const path = snapshot.path;
    const target = snapshot.defaultBranch;
    const question = `Merge ${name} to ${target}`;
    // A clean branch can use the verified direct path. Once the working tree is dirty, the model must
    // decide whether those changes belong to this branch and, if so, place a commit before the merge.
    const context = conversationContext(conversations[path] ?? []);
    await showPlan(question, snapshot.isDirty
      ? () => window.branchline.planAction(path, question, context)
      : () => window.branchline.prepareMergeToDefault(path, name), path);
  };

  const applyPlan = async (turnId: number, plan: ActionPlan) => {
    if (!plan.allowed || planning) return;
    await runPlan(turnId, plan);
  };

  /**
   * Asks the assistant how to carry on from where the repository actually is. It opens its own turn
   * so the failure and the way out read as two separate things, which is what they are.
   */
  const recoverFrom = async (path: string, failure: ExecutionFailure) => {
    const context = conversationContext(conversations[path] ?? []);
    const turnId = addTurn(path, "¿Cómo sigo desde aquí?");
    try {
      const plan = await window.branchline.planRecovery(path, failure, context);
      if (plan.repoPath !== path) throw new Error("El plan pertenece a otro repositorio.");
      if (plan.answer) {
        updateTurn(path, turnId, (turn) => ({ ...turn, answer: plan.answer, status: "completed" }));
        return;
      }
      // Never unattended: a way out of a half-finished operation is always the user's call.
      updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: plan.allowed ? "ready" : "completed" }));
    } catch (error) {
      updateTurn(path, turnId, (turn) => ({
        ...turn,
        error: cleanError(error, "No pude proponer cómo continuar."),
        status: "error"
      }));
    }
  };

  /** Asks the model to draft every conflicted file. Nothing is written until the user accepts it. */
  const resolveConflicts = async () => {
    if (!snapshot || resolving) return;
    setResolving(true);
    setProposal(undefined);
    try {
      setProposal(await window.branchline.proposeConflictResolution(snapshot.path));
    } catch (error) {
      setToast({ message: cleanError(error, "No se pudo proponer una resolución."), tone: "error" });
    } finally { setResolving(false); }
  };

  const applyResolutions = async (resolutions: ConflictResolution[]) => {
    if (!snapshot || !resolutions.length) return;
    const path = snapshot.path;
    try {
      updateSnapshot(path, await window.branchline.applyConflictResolution(path, resolutions));
      setProposal(undefined);
      addActivity({ label: "Conflictos resueltos", detail: `${plural(resolutions.length, "archivo aceptado", "archivos aceptados")}`, tone: "success" });
    } catch (error) {
      setToast({ message: cleanError(error, "No se pudo aplicar la resolución."), tone: "error" });
      await refreshProject(path, false);
    }
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
        /**
         * The repository is now holding a half-finished job the user did not ask for, and this is
         * exactly where the conversation used to end. Planning is not acting, so the assistant is
         * asked how to continue straight away; what it proposes still waits for a confirmation.
         */
        const failed = result.outcomes?.find((outcome) => outcome.status === "failed");
        // A failed push or fetch does not create a pending Git operation, but it still needs the
        // assistant's translation and next-step options. Recovery is for any failed plan, not only
        // merge/rebase states that leave metadata in .git.
        if (failed && config.configured) {
          await recoverFrom(plan.repoPath, {
            command: failed.command,
            summary: failed.summary,
            error: result.error,
            skipped: (result.outcomes ?? []).filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.summary)
          });
        }
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
      const message = cleanError(error, "Git no pudo completar la acción.");
      updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      setToast({ message, tone: "error" });
      await refreshProject(plan.repoPath, false);
      if (config.configured) await recoverFrom(plan.repoPath, {
        command: plan.command,
        summary: plan.summary,
        error: message,
        skipped: plan.steps.map((step) => step.summary)
      });
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
      const message = cleanError(error, "No se pudo cambiar de rama.");
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      addActivity({ label: "No se pudo cambiar de rama", detail: message, tone: "warning" });
      if (config.configured) await recoverFrom(path, {
        command: `git switch ${name}`,
        summary: `Cambiar a ${name}`,
        error: message,
        skipped: []
      });
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
      setToast({ message: cleanError(error, "No se pudo generar la descripción."), tone: "error" });
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
  /**
   * The branch the window is talking about. It falls back to the checked-out one, and falls back
   * again the moment the selected branch stops existing — a rename or a delete must not leave the
   * history pointing at a name Git no longer knows.
   */
  const selection = snapshot
    ? (selectedBranch && snapshot.branches.some((branch) => branch.name === selectedBranch) ? selectedBranch : snapshot.currentBranch)
    : "";


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
        <div className="top-actions"><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Configuración"><Settings2 size={17} /></button></div>
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
            <BranchPanel
              key={snapshot.path}
              snapshot={snapshot}
              busy={planning}
              selected={selection}
              onSelect={setSelectedBranch}
              onCreate={() => setInputDialog({ operation: "create_branch", title: "Nueva rama", label: "Nombre de la rama", value: "" })}
              onSwitch={(name) => void prepare("checkout", { name })}
              onSwitchNow={(name) => void switchBranch(name)}
              onDelete={(name) => void prepare("delete_branch", { name })}
              onRename={(name, to) => void prepare("rename_branch", { name, to })}
              onMergeToDefault={(name) => void prepareMergeToDefault(name)}
            />
          </aside>

          <section className="graph-area">
            <div className="graph-toolbar"><div className="view-tabs"><button className={`view-tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>Historial</button><button className={`view-tab ${view === "changes" ? "active" : ""}`} onClick={() => setView("changes")}>Cambios <span className="count-badge">{snapshot.changes.length}</span></button></div>{view === "history" && <div className="graph-tools"><div className="search-field commit-search"><Search size={14} /><input aria-label="Buscar commits" value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} placeholder="Buscar commits" /></div></div>}</div>
            {snapshot.pending && <PendingBanner
              snapshot={snapshot}
              busy={planning}
              onContinue={() => void prepare("continue_operation")}
              onSkip={() => void prepare("skip_operation")}
              onAbort={() => void prepare("abort_operation")}
              onResolve={() => void resolveConflicts()}
            />}
            <div className="current-branch-card"><div className="branch-dot" style={{ background: branchColor(0) }} /><div><span className="eyebrow">RAMA ACTUAL</span><div className="current-branch-name">{snapshot.currentBranch}<span className="branch-status">{snapshot.isDirty ? "Cambios locales" : "Limpia"}</span></div></div><div className="branch-stats"><span><ArrowDownToLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.behind ?? 0} detrás</span><span><ArrowUpFromLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.ahead ?? 0} adelante</span></div><button className="outline-button small" onClick={openCommitForm} disabled={!snapshot.isDirty || planning}><GitCommitHorizontal size={14} /> Commit</button></div>
            {view === "history" ? <HistoryView key={snapshot.path} snapshot={snapshot} selection={selection} filter={commitFilter} onSelect={setSelectedCommit} />
              : <ChangesView snapshot={snapshot} onOpenFile={setSelectedFile} formOpen={commitFormOpen} message={commitMessage} generating={generatingDescription} busy={planning} onOpenForm={() => setCommitFormOpen(true)} onMessageChange={setCommitMessage} onGenerate={() => void generateDescription()} onPrepare={prepareCommit} />}
          </section>

          <aside className="inspector"><div className="inspector-header"><div><div className="eyebrow">ASISTENTE DE RAMAS</div><h2>¿Qué quieres saber o hacer?</h2></div><div className="assistant-icon"><Bot size={18} /></div></div><p className="assistant-copy">{config.configured ? "Pregunta sobre el repositorio o describe una acción de Git. Las acciones se muestran como un plan verificable antes de ejecutarse." : "Sin proveedor LLM el asistente no puede interpretar nada. Configúralo para preguntar o describir acciones; el resto de la interfaz funciona igual."}</p>{conversation.length === 0 && config.configured && <div className="suggestion-list">{suggestionsFor(snapshot).map((suggestion) => <button key={suggestion.key} onClick={() => "question" in suggestion ? askSuggestion(suggestion.question) : setInputDialog(suggestion.dialog)} disabled={planning} title={"question" in suggestion ? suggestion.question : suggestion.label}><suggestion.icon size={15} /><span>{suggestion.label}</span></button>)}</div>}<div className="conversation-toolbar"><span>{conversation.length ? `${conversation.length} mensaje${conversation.length === 1 ? "" : "s"}` : "Nueva conversación"}</span><button onClick={() => setConversations((items) => ({ ...items, [snapshot.path]: [] }))} disabled={!conversation.length || planning}><Trash2 size={12} /> Limpiar conversación</button></div><div className="conversation" aria-live="polite">{conversation.map((turn) => <ConversationEntry key={turn.id} turn={turn} busy={planning} onApply={(plan) => void applyPlan(turn.id, plan)} onDismiss={() => updateTurn(snapshot.path, turn.id, (item) => ({ ...item, status: "cancelled", outcome: "Plan descartado sin modificar el repositorio." }))} />)}<div ref={conversationEnd} /></div><div className="chat-compose"><textarea aria-label="Solicitud para el asistente" disabled={!config.configured} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder={config.configured ? "Ej. ¿quién trabajó en esta rama la última vez?" : "Configura un proveedor LLM para escribirle al asistente"} rows={3} /><button className="send-button" aria-label="Preparar solicitud" onClick={() => void propose(request)} disabled={planning || !request.trim() || !config.configured}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div></aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className="status-good"><CircleDot size={12} /> {snapshot.isDirty ? `${snapshot.changes.length} cambio${snapshot.changes.length === 1 ? "" : "s"}` : "Sin cambios locales"}</span><span className="status-separator" /><span>{branchCount.local === 1 ? "1 rama local" : `${branchCount.local} ramas locales`}{branchCount.remoteOnly ? `, ${branchCount.remoteOnly} solo en el remoto` : ""}</span></div><div className="status-right"><span><Clock3 size={12} /> Última lectura {formatDate(active.loadedAt)}</span><span className="remote-status" title={remoteTitle(snapshot)}><Cloud size={12} /> {remoteLabel(snapshot)}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : "LLM no configurado"}</span></div></footer>
      </>}
      {activity.length > 0 && <div className="activity-dock" aria-live="polite">{activity.slice(0, 3).map((item) => <div className={`activity-item ${item.tone}`} role={item.tone === "warning" ? "alert" : "status"} key={item.id}><span className="activity-symbol">{item.tone === "success" ? <Check size={13} /> : item.tone === "warning" ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={13} />}</span><div className="activity-copy"><strong>{item.label}</strong><span title={item.detail}>{item.detail}</span></div><button className="activity-close" onClick={() => dismissActivity(item.id)} aria-label={`Cerrar notificación: ${item.label}`}><X size={14} /></button></div>)}</div>}
      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{toast.message}</span><button onClick={() => setToast(undefined)} aria-label="Cerrar notificación"><X size={14} /></button></div>}
      {settingsOpen && <SettingsModal config={config} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); setToast({ message: "Configuración guardada.", tone: "success" }); }} />}
      {inputDialog && <InputModal dialog={inputDialog} branches={snapshot?.branches ?? []} onChange={(value) => setInputDialog({ ...inputDialog, value })} onClose={() => setInputDialog(undefined)} onSubmit={submitInputDialog} />}
      {selectedCommit && snapshot && <CommitModal commit={selectedCommit} repoPath={snapshot.path} onClose={() => setSelectedCommit(undefined)} />}
      {selectedFile && snapshot && <FileDiffModal file={selectedFile} repoPath={snapshot.path} onClose={() => setSelectedFile(undefined)} />}
      {proposal && <ConflictProposalModal proposal={proposal} busy={planning} onApply={(resolutions) => void applyResolutions(resolutions)} onClose={() => setProposal(undefined)} />}
      {resolving && <div className="resolving-overlay" role="status"><LoaderCircle className="spin" size={22} /><span>Leyendo los dos lados de cada conflicto…</span></div>}
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

/**
 * The branch list, read through whatever convention the repository already follows. Grouping is a
 * view: nothing is renamed, every group opens with one click, and the flat list with its filter is
 * still one click away for whoever already knows the name they are looking for.
 */
function BranchPanel({ snapshot, busy, selected, onSelect, onCreate, onSwitch, onSwitchNow, onDelete, onRename, onMergeToDefault }: {
  snapshot: RepoSnapshot; busy: boolean; selected: string; onSelect: (name: string) => void; onCreate: () => void;
  onSwitch: (name: string) => void; onSwitchNow: (name: string) => void; onDelete: (name: string) => void;
  onRename: (from: string, to: string) => void; onMergeToDefault: (name: string) => void;
}) {
  const [saved, setSaved] = useState<BranchView | undefined>(() => readBranchView(snapshot.path));
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<{ branch: Branch; x: number; y: number }>();
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<{ scrollTop: number; focused?: string }>(undefined);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(undefined);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(undefined);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnKeyDown);
    };
  }, [contextMenu]);

  const order = saved?.order ?? defaultBranchOrder;
  const hideMerged = saved?.hideMerged ?? false;
  const merged = useMemo(
    () => snapshot.branches.filter((branch) => isMergedIntoDefault(branch, snapshot.defaultBranch)).map((branch) => branch.name),
    [snapshot.branches, snapshot.defaultBranch]
  );
  const mergedNames = useMemo(() => new Set(merged), [merged]);
  // Ordering comes before grouping, so the groups follow the most recent branch each one holds.
  const listed = useMemo(() => {
    const kept = hideMerged ? snapshot.branches.filter((branch) => !mergedNames.has(branch.name)) : snapshot.branches;
    return sortBranches(kept, order, { dirty: snapshot.isDirty });
  }, [snapshot.branches, snapshot.isDirty, order, hideMerged, mergedNames]);

  const dismissed = saved?.dismissed ?? noDismissals;
  const suggestions = useMemo(() => branchSuggestions(snapshot.branches, dismissed), [snapshot.branches, dismissed]);
  // Both spellings share a header; the rows keep the name Git actually has.
  const aliases = useMemo(() => prefixAliases(suggestions), [suggestions]);
  const variants = useMemo(
    () => new Set(suggestions.flatMap((item) => item.kind === "prefix" ? item.renames.map((rename) => rename.from) : [])),
    [suggestions]
  );
  const tree = useMemo(() => buildBranchTree(listed, { aliases }), [listed, aliases]);
  // Nothing stored yet: the branch you are standing on is the one worth having open.
  const fallbackExpanded = useMemo(() => groupPathFor(tree, snapshot.currentBranch), [tree, snapshot.currentBranch]);
  const view = saved ?? { mode: "tree" as BranchViewMode, expanded: fallbackExpanded, order, hideMerged, dismissed };
  const update = (next: Partial<BranchView>) => {
    const updated = { ...view, ...next };
    setSaved(updated);
    writeBranchView(snapshot.path, updated);
  };

  const query = filter.trim();
  const filtering = query.length > 0;
  const visible = useMemo(() => filterBranchTree(tree, query), [tree, query]);
  const matches = useMemo(
    () => listed.filter((branch) => branch.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    [listed, query]
  );
  // The colour belongs to the branch, not to the row, so it does not change with the mode or the filter.
  const colours = useMemo(() => new Map(snapshot.branches.map((branch, index) => [branch.name, branchColor(index)])), [snapshot.branches]);

  /**
   * Changing mode redraws the whole list, so where the user was is captured first and put back after:
   * the same branch keeps the focus and the list stays where it was left.
   */
  const setMode = (mode: BranchViewMode) => {
    if (mode === view.mode) return;
    const focused = [...rows.current].find(([, node]) => node === document.activeElement)?.[0];
    pending.current = { scrollTop: listRef.current?.scrollTop ?? 0, focused };
    update({ mode, expanded: mode === "tree" && focused ? [...new Set([...view.expanded, ...groupPathFor(tree, focused)])] : view.expanded });
  };

  useLayoutEffect(() => {
    const restore = pending.current;
    if (!restore) return;
    pending.current = undefined;
    if (listRef.current) listRef.current.scrollTop = restore.scrollTop;
    const node = restore.focused ? rows.current.get(restore.focused) : undefined;
    if (node) { node.focus(); node.scrollIntoView({ block: "nearest" }); }
  }, [view.mode]);

  const toggle = (key: string) => update({
    expanded: view.expanded.includes(key) ? view.expanded.filter((item) => item !== key) : [...view.expanded, key]
  });

  const register = (name: string) => (node: HTMLButtonElement | null) => {
    if (node) rows.current.set(name, node); else rows.current.delete(name);
  };

  const openContextMenu = (branch: Branch, event: ReactMouseEvent<HTMLDivElement>) => {
    if (busy || !snapshot.defaultBranch || branch.name === snapshot.defaultBranch || branch.presence === "remote") return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      branch,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 286)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 54))
    });
  };

  const branchRow = (branch: Branch, depth: number, trim: string) => <BranchRow
    key={branch.name}
    branch={branch}
    // The header already says the prefix, so the row drops it — unless the row spells it differently,
    // in which case hiding the difference would be hiding the very thing the mark is pointing at.
    label={trim && prefixOf(branch.name) === trim ? branch.name.slice(trim.length + 1) : branch.name}
    variant={variants.has(branch.name)}
    merged={mergedNames.has(branch.name)}
    selected={branch.name === selected}
    onSelect={() => onSelect(branch.name)}
    defaultBranch={snapshot.defaultBranch}
    colour={colours.get(branch.name) ?? branchColor(0)}
    depth={depth}
    busy={busy}
    register={register(branch.name)}
    onSwitch={() => onSwitch(branch.name)}
    onSwitchNow={() => onSwitchNow(branch.name)}
    onDelete={() => onDelete(branch.name)}
    onContextMenu={(event) => openContextMenu(branch, event)}
  />;

  const renderNodes = (nodes: BranchNode[], depth: number, trim: string): ReactNode[] => nodes.flatMap((node) => {
    // A branch that continues another is drawn under it: the indent is the implicit rebase order.
    if (node.kind === "branch") return [branchRow(node.branch, depth, trim), ...node.stacked.map((branch) => branchRow(branch, depth + 1, trim))];
    // A filter is a search: it opens whatever it had to look inside, without touching the stored state.
    const open = filtering || view.expanded.includes(node.group.key);
    return [
      <button
        key={`group:${node.group.key}`}
        className="branch-group"
        style={{ paddingLeft: 8 + depth * 13 }}
        aria-expanded={open}
        onClick={() => toggle(node.group.key)}
        title={`${node.group.label}/ · ${plural(node.group.count, "rama", "ramas")}`}
      ><ChevronRight className={`branch-chevron ${open ? "open" : ""}`} size={12} /><span className="branch-group-label">{node.group.label}</span><span className="branch-group-count">{node.group.count}</span></button>,
      ...(open ? renderNodes(node.group.children, depth + 1, trim || node.group.label) : [])
    ];
  });

  // A lone group, and the group of branches with no prefix at all, are headings over nothing.
  const topLevel: BranchNode[] = visible.groups.flatMap((group) =>
    visible.showHeaders && group.kind === "prefix" ? [{ kind: "group" as const, group }] : group.children);

  return <div className="sidebar-section branch-section">
    <div className="section-heading"><span>RAMAS</span><div className="branch-tools">
      <div className="mode-toggle" role="group" aria-label="Modo de la lista de ramas">
        <button className={view.mode === "tree" ? "active" : ""} aria-pressed={view.mode === "tree"} onClick={() => setMode("tree")} title="Agrupar por el prefijo del nombre"><ListTree size={13} /></button>
        <button className={view.mode === "flat" ? "active" : ""} aria-pressed={view.mode === "flat"} onClick={() => setMode("flat")} title="Lista plana"><List size={13} /></button>
      </div>
      <button className="mini-icon" onClick={onCreate} aria-label="Crear rama"><Plus size={14} /></button>
    </div></div>
    <div className="search-field"><Search size={14} /><input aria-label="Filtrar ramas" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filtrar ramas" /></div>
    <div className="branch-filters">
      <label className="order-field"><ArrowDownWideNarrow size={12} /><span className="visually-hidden">Ordenar ramas</span><select value={order} onChange={(event) => update({ order: event.target.value as BranchOrder })}>
        {(Object.keys(branchOrderLabels) as BranchOrder[]).map((value) => <option value={value} key={value}>{branchOrderLabels[value]}</option>)}
      </select></label>
      {/* A repository with nothing integrated has nothing to hide, so the control does not appear at all. */}
      {merged.length > 0 && <button
        className={`merged-toggle ${hideMerged ? "active" : ""}`}
        aria-pressed={hideMerged}
        onClick={() => update({ hideMerged: !hideMerged })}
        title={`${plural(merged.length, "rama ya integrada", "ramas ya integradas")} en ${snapshot.defaultBranch}. Ocultarlas no borra nada.`}
      >{hideMerged ? <EyeOff size={12} /> : <Eye size={12} />}<span>Mergeadas</span><span className="merged-count">{merged.length}</span></button>}
    </div>
    {/* Sugerencias, nunca acciones: cada renombrado se confirma por separado y con su comando delante. */}
    {!filtering && suggestions.map((suggestion) => <NamingSuggestion
      key={suggestion.id}
      suggestion={suggestion}
      busy={busy}
      onRename={onRename}
      onDismiss={() => update({ dismissed: [...dismissed, suggestion.id] })}
    />)}
    <div className="branch-list" ref={listRef}>
      {view.mode === "tree" ? renderNodes(topLevel, 0, "") : matches.map((branch) => branchRow(branch, 0, ""))}
      {/* La lista plana sigue siendo plana: apilar es estructura, y ahí no se dibuja ninguna. */}
      {/* Nada oculto en silencio: si lo que falta lo esconde el filtro de integradas, la fila lo dice. */}
      {!matches.length && <div className="empty-small">{!filtering && hideMerged && merged.length
        ? `Todas las demás ramas ya están integradas en ${snapshot.defaultBranch}.`
        : "No hay ramas que coincidan."}</div>}
    </div>
    {contextMenu && snapshot.defaultBranch && <div
      ref={contextMenuRef}
      className="branch-context-menu"
      role="menu"
      aria-label={`Acciones para ${contextMenu.branch.name}`}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    ><button
      role="menuitem"
      autoFocus
      disabled={busy}
      onClick={() => { const name = contextMenu.branch.name; setContextMenu(undefined); onMergeToDefault(name); }}
    ><GitMerge size={14} /><span>Merge {contextMenu.branch.name} to {snapshot.defaultBranch}</span></button></div>}
  </div>;
}

/**
 * A remark about the repository's own naming, with the rename it would take. It never renames on its
 * own: each branch is a separate plan the user confirms with the Git command in front of them, and
 * dismissing the card is remembered so the same remark is not made twice.
 */
function NamingSuggestion({ suggestion, busy, onRename, onDismiss }: {
  suggestion: BranchSuggestion; busy: boolean; onRename: (from: string, to: string) => void; onDismiss: () => void;
}) {
  const [title, detail] = suggestion.kind === "prefix"
    ? [`${suggestion.variant}/ frente a ${suggestion.canonical}/`,
       `${plural(suggestion.variantCount, "rama escribe", "ramas escriben")} ${suggestion.variant}/ y ${plural(suggestion.canonicalCount, "escribe", "escriben")} ${suggestion.canonical}/.`]
    : [`${suggestion.token}-… frente a ${suggestion.token}/…`,
       `${plural(suggestion.renames.length, "rama usa", "ramas usan")} “-” donde el resto del repositorio usa “/”.`];
  return <div className="naming-suggestion">
    <div className="naming-heading">
      <Lightbulb size={13} />
      <div><strong>{title}</strong><span>{detail}</span></div>
      <button className="mini-icon" onClick={onDismiss} aria-label={`Descartar la sugerencia ${title}`} title="Descartar: no volveré a proponerlo en este repositorio"><X size={13} /></button>
    </div>
    <ul>{suggestion.renames.map((rename) => <li key={rename.from}>
      <code title={`${rename.from} → ${rename.to}`}>{rename.from} → {rename.to}</code>
      <button className="outline-button small" disabled={busy} onClick={() => onRename(rename.from, rename.to)} title={`Prepara el plan: git branch -m ${rename.from} ${rename.to}`}>Renombrar</button>
    </li>)}</ul>
  </div>;
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
function branchTooltip(branch: Branch, defaultBranch?: string) {
  const parts = [branch.name, presenceLabel[branch.presence]];
  if (branch.name === defaultBranch) parts.push("rama principal");
  // Integration is what tells you whether deleting the branch would lose anything.
  if (branch.mergedInto.length) parts.push(`ya integrada en ${branch.mergedInto.join(" y ")}`);
  else if (!branch.isCurrent) parts.push("sin integrar en la rama por defecto ni en la actual");
  if (branch.checkedOutIn) parts.push(`en uso por el worktree ${branch.checkedOutIn}`);
  if (branch.stackedOn) parts.push(`apilada sobre ${branch.stackedOn}, que hay que rebasar antes`);
  const lifecycle = lifecycleOf(branch.name);
  if (lifecycle !== "unknown") parts.push(`rama ${lifecycleLabels[lifecycle]} por su prefijo`);
  return parts.join(" · ");
}

/**
 * A click selects, a double click switches. Selecting is not a Git operation: it only decides which
 * branch the rest of the window is talking about, which is the thing you want far more often than a
 * checkout. Changing branch stays an explicit gesture — the double click, or the button on the row.
 */
function BranchRow({ branch, label, variant, merged, selected, defaultBranch, colour, depth, busy, register, onSelect, onSwitch, onSwitchNow, onDelete, onContextMenu }: { branch: Branch; label: string; variant: boolean; merged: boolean; selected: boolean; defaultBranch?: string; colour: string; depth: number; busy: boolean; register: (node: HTMLButtonElement | null) => void; onSelect: () => void; onSwitch: () => void; onSwitchNow: () => void; onDelete: () => void; onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void }) {
  const isDefault = branch.name === defaultBranch;
  const protectedByPrefix = isProtectedBranch(branch.name);
  // Read once per render rather than per row: the panel redraws on every snapshot anyway.
  const stale = staleDays(branch, Date.now());
  return <div onContextMenu={onContextMenu} className={`branch-row ${branch.isCurrent ? "current" : ""} ${selected ? "selected" : ""} ${merged ? "merged" : ""} ${branch.stackedOn ? "stacked" : ""} ${branch.presence}`}><button ref={register} className="branch-main" style={{ paddingLeft: 8 + depth * 13 }} onClick={onSelect} onDoubleClick={onSwitchNow} aria-current={branch.isCurrent} aria-pressed={selected} title={`${branchTooltip(branch, defaultBranch)}\nClic para ver su historial · doble clic para cambiar a ella`}><span className="branch-color" style={{ background: colour }} />{branch.stackedOn ? <GitFork size={14} className="branch-stack-icon" /> : <GitBranch size={14} />}<span className="branch-label">{label}</span>{variant && <span className="branch-variant" title={`Escribe el prefijo de otra forma que el resto del repositorio. Sigue llamándose ${branch.name}.`}>variante</span>}{merged && <span className="branch-merged" role="img" aria-label={`Ya integrada en ${defaultBranch}`} title={`Ya integrada en ${defaultBranch}: borrarla no perdería trabajo`}><GitMerge size={12} /></span>}{branch.checkedOutIn && <span className="branch-worktree" role="img" aria-label={`En uso por el worktree ${branch.checkedOutIn}`} title={`En uso por el worktree ${branch.checkedOutIn}`}><FolderGit2 size={12} /></span>}{protectedByPrefix && <span className="branch-protected" role="img" aria-label="Protegida por su prefijo" title="Protegida por su prefijo: las ramas de ese tipo existen para conservarse, así que Branchline no las borra ni las propone para limpieza."><ShieldCheck size={12} /></span>}{stale > 0 && <span className="branch-stale" role="img" aria-label={`Sin actividad desde hace ${stale} días`} title={`Rama de vida corta sin actividad desde hace ${stale} días. Es una observación, no una propuesta de borrado.`}><Clock3 size={12} /></span>}<PresenceBadge branch={branch} />{branch.isCurrent && <span className="current-pill">actual</span>}{isDefault && <span className="current-pill">principal</span>}{(branch.ahead > 0 || branch.behind > 0) && <span className="ahead-behind">{branch.ahead > 0 ? `↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}</button>{!branch.isCurrent && <button className="branch-switch" onClick={onSwitch} disabled={busy} aria-label={`Cambiar a la rama ${branch.name}`} title={`Cambiar a ${branch.name}: se prepara como plan y lo confirmas`}><ArrowLeftRight size={12} /></button>}{!branch.isCurrent && !isDefault && !protectedByPrefix && branch.presence !== "remote" && <button className="branch-delete" onClick={onDelete} disabled={busy} aria-label={`Eliminar rama ${branch.name}`} title={branch.mergedInto.length ? `Eliminar ${branch.name}: ya integrada en ${branch.mergedInto.join(" y ")}, no se pierde trabajo` : `Eliminar ${branch.name}: sin integrar, Git rechazará el borrado si se perdería trabajo`}><Trash2 size={12} /></button>}</div>;
}

/**
 * The history, drawn as the graph it always was. Lanes come from Git's own topological order, and the
 * colour of a line says which family of branches it belongs to rather than which row it happens to be.
 */
/**
 * The history, scoped to the branch the window is talking about. It used to be `git log --all`, which
 * meant the list never had anything to do with any branch: selecting one changed nothing, and the
 * count implied a completeness a fixed window of 80 commits never had.
 */
function HistoryView({ snapshot, selection, filter, onSelect }: {
  snapshot: RepoSnapshot; selection: string; filter: string; onSelect: (commit: Commit) => void;
}) {
  const [prefs, setPrefs] = useState(() => readHistoryPrefs(snapshot.path));
  const [page, setPage] = useState<{ commits: Commit[]; hasMore: boolean; comparedTo?: string }>({ commits: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Every load is numbered, so a slow answer for a scope the user already left cannot overwrite the
  // one they are looking at.
  const request = useRef(0);

  const { scope, byFamily } = prefs;
  const branch = scope === "all" ? undefined : selection;

  const fetchPage = (skip: number) => {
    const id = ++request.current;
    setLoading(true);
    window.branchline.loadHistory(snapshot.path, { scope, branch, skip }).then((next) => {
      if (request.current !== id) return;
      setPage((current) => ({
        commits: skip === 0 ? next.commits : [...current.commits, ...next.commits],
        hasMore: next.hasMore,
        comparedTo: next.comparedTo
      }));
      setError(undefined);
    }).catch((reason) => {
      if (request.current !== id) return;
      setError(cleanError(reason, "No se pudo leer el historial."));
    }).finally(() => {
      if (request.current === id) setLoading(false);
    });
  };

  useEffect(() => { fetchPage(0); }, [snapshot.path, snapshot.head, snapshot.stateId, scope, branch]);

  const update = (next: Partial<HistoryPrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    writeHistoryPrefs(snapshot.path, merged);
  };

  const graph = useMemo(
    () => buildCommitGraph(page.commits, snapshot.remotes, snapshot.defaultBranch),
    [page.commits, snapshot.remotes, snapshot.defaultBranch]
  );
  const rows = useMemo(() => new Map(graph.rows.map((row) => [row.commit.hash, row])), [graph]);
  const needle = filter.trim().toLocaleLowerCase();
  const visible = useMemo(() => needle
    ? page.commits.filter((commit) => [commit.subject, commit.author, commit.hash, ...commit.refs]
        .some((field) => field.toLocaleLowerCase().includes(needle)))
    : page.commits, [page.commits, needle]);
  // A filtered list is a selection of commits, not a graph: the lanes between them no longer connect.
  const lanes = needle ? 0 : Math.min(graph.laneCount, maxLanes);
  const trackWidth = lanes ? Math.max(43, lanes * laneWidth + laneOffset + 10) : 43;

  const scopeLabels: Record<HistoryScope, string> = {
    all: "Todas las ramas",
    branch: `Rama ${selection}`,
    "branch-only": `Solo lo exclusivo de ${selection}`
  };

  return <div className="graph-scroll" style={{ "--track-w": `${trackWidth}px` } as CSSProperties}>
    <div className="graph-header">
      <div className="graph-scope">
        <label className="scope-field"><GitBranch size={12} /><span className="visually-hidden">Alcance del historial</span><select value={scope} onChange={(event) => update({ scope: event.target.value as HistoryScope })}>
          {(Object.keys(scopeLabels) as HistoryScope[]).map((value) => <option value={value} key={value}>{scopeLabels[value]}</option>)}
        </select></label>
        {scope === "branch-only" && <span className="scope-note">{page.comparedTo
          ? `frente a ${page.comparedTo}`
          : "sin rama por defecto contra la que comparar, así que se muestra la rama entera"}</span>}
      </div>
      <div className="graph-header-right">
        <button className="graph-colour-toggle" aria-pressed={byFamily} onClick={() => update({ byFamily: !byFamily })} title={byFamily
          ? "Cada familia de ramas tiene su tono, estable entre sesiones. Pulsa para volver al coloreado por posición."
          : "Coloreado por posición en la lista. Pulsa para dar un tono estable a cada familia de ramas."}><Palette size={12} /> {byFamily ? "Por familia" : "Por posición"}</button>
        <span className="graph-count">{needle
          ? `${visible.length} de ${page.commits.length} cargados`
          : `${page.commits.length} commits${page.hasMore ? " · hay más" : ""}`}</span>
      </div>
    </div>
    {needle && <div className="graph-note">El filtro busca entre los {page.commits.length} commits ya cargados, y no se dibujan carriles: entre commits sueltos no hay continuidad que enseñar.</div>}
    {error && <div className="graph-note error" role="alert">{error}</div>}
    {visible.length ? visible.map((commit, index) => <CommitRow
      key={commit.hash}
      commit={commit}
      row={rows.get(commit.hash)}
      lanes={lanes}
      trackWidth={trackWidth}
      remotes={snapshot.remotes}
      colour={byFamily ? familyColour(rows.get(commit.hash)?.family ?? "") : branchColor(index)}
      byFamily={byFamily}
      onSelect={() => onSelect(commit)}
    />) : !loading && <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>No hay commits que mostrar</strong><span>{needle ? "El filtro no coincide con nada de lo cargado." : scope === "branch-only" ? `${selection} no tiene nada que ${page.comparedTo ?? "la rama por defecto"} no tenga ya.` : "Esta rama todavía no tiene historial."}</span></div>}
    {loading && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> Leyendo el historial…</div>}
    {!loading && page.hasMore && !needle && <button className="load-more" onClick={() => fetchPage(page.commits.length)}>Cargar más commits</button>}
  </div>;
}

const laneWidth = 14;
const laneOffset = 12;
const laneX = (lane: number) => lane * laneWidth + laneOffset;

/**
 * One row of the graph. The lines are an SVG stretched to whatever height the row ends up with, and
 * the node stays a DOM element so that stretching never turns the circle into an ellipse. Both are
 * anchored to the same midpoint, so the joint always lands on the node whatever the row measures.
 */
function GraphLanes({ row, lanes, colour, byFamily }: { row: GraphRow; lanes: number; colour: string; byFamily: boolean }) {
  const width = lanes * laneWidth + laneOffset;
  const visible = (lane: number) => lane < lanes;
  const tone = (family: string) => byFamily ? familyColour(family) : "#294153";
  return <svg className="graph-lanes" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">
    {row.through.filter((line) => visible(line.lane)).map((line) =>
      <line key={`t${line.lane}`} x1={laneX(line.lane)} y1={0} x2={laneX(line.lane)} y2={100} stroke={tone(line.family)} />)}
    {row.incoming.filter(visible).map((lane) => lane === row.lane
      ? <line key={`i${lane}`} x1={laneX(lane)} y1={0} x2={laneX(lane)} y2={50} stroke={colour} />
      : <path key={`i${lane}`} d={`M ${laneX(lane)} 0 L ${laneX(lane)} 20 Q ${laneX(lane)} 50 ${laneX(row.lane)} 50`} fill="none" stroke={colour} />)}
    {row.outgoing.filter(visible).map((lane) => lane === row.lane
      ? <line key={`o${lane}`} x1={laneX(lane)} y1={50} x2={laneX(lane)} y2={100} stroke={colour} />
      : <path key={`o${lane}`} d={`M ${laneX(row.lane)} 50 Q ${laneX(lane)} 50 ${laneX(lane)} 80 L ${laneX(lane)} 100`} fill="none" stroke={colour} />)}
  </svg>;
}

type RefChip = { label: string; kind: "head" | "local" | "remote" | "tag" };

/**
 * The refs worth showing, once each. `feature/x` and `origin/feature/x` are one branch that happens to
 * exist in two places, so drawing both spent the whole width saying the same name twice and truncated
 * it in the process. A remote-only ref keeps its own mark, because that one you do not have here.
 *
 * "origin/HEAD" is a symbolic pointer rather than a branch anyone can visit, and the "HEAD -> "
 * decoration is a statement about the checkout, not part of any name.
 */
function refChips(refs: string[], remotes: string[]): RefChip[] {
  const order: string[] = [];
  const found = new Map<string, { head: boolean; local: boolean; remote: boolean; tag: boolean }>();
  const note = (label: string, key: "head" | "local" | "remote" | "tag") => {
    if (!found.has(label)) { found.set(label, { head: false, local: false, remote: false, tag: false }); order.push(label); }
    found.get(label)![key] = true;
  };
  for (const raw of refs) {
    const head = /^HEAD ->/.test(raw);
    const name = raw.replace(/^HEAD ->\s*/, "").trim();
    if (!name || name === "HEAD") continue;
    if (name.startsWith("tag:")) { note(name.slice(4).trim(), "tag"); continue; }
    if (remotes.some((remote) => name === `${remote}/HEAD`)) continue;
    const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`));
    const label = remote ? name.slice(remote.length + 1) : name;
    note(label, remote ? "remote" : "local");
    if (head) note(label, "head");
  }
  return order.map((label) => {
    const flags = found.get(label)!;
    return {
      label,
      kind: flags.tag ? "tag" : flags.head ? "head" : flags.local ? "local" : "remote"
    };
  });
}

function CommitRow({ commit, row, lanes, trackWidth, remotes, colour, byFamily, onSelect }: { commit: Commit; row?: GraphRow; lanes: number; trackWidth: number; remotes: string[]; colour: string; byFamily: boolean; onSelect: () => void }) {
  const lane = row && lanes ? Math.min(row.lane, lanes - 1) : 0;
  const chips = refChips(commit.refs, remotes);
  const shown = chips.slice(0, 2);
  const rest = chips.slice(2);
  return <div className="commit-row"><div className="graph-track" style={{ width: trackWidth }}>
    {row && lanes > 0 ? <GraphLanes row={row} lanes={lanes} colour={colour} byFamily={byFamily} /> : <span className="track-line" />}
    <span className="commit-node" style={{ left: laneX(lane) - 5.5, borderColor: colour, boxShadow: `0 0 0 4px ${colour}18` }} />
  </div><button className="commit-content" onClick={onSelect} aria-label={`Ver qué cambió el commit ${commit.shortHash}: ${commit.subject}`}>
    <div className="commit-main">
      <div className="commit-subject">{commit.subject || "Commit sin mensaje"}</div>
      <div className="commit-meta">
        <span className="hash-chip">{commit.shortHash}</span>
        <span className="commit-author">{commit.author}</span>
        <span className="meta-divider">·</span>
        {/* Relative is what gets scanned; the exact date, with its year, is one hover away. */}
        <span title={formatDateFull(commit.date)}>{relativeTime(commit.date)}</span>
      </div>
    </div>
    <div className="commit-refs">
      {shown.map((chip) => <span className={`ref-tag ${chip.kind}`} key={chip.label} title={chip.kind === "remote" ? `${chip.label} · solo en el remoto` : chip.label}>
        {chip.kind === "tag" ? <Tag size={11} /> : chip.kind === "remote" ? <Cloud size={11} /> : <GitBranch size={11} />}{chip.label}
      </span>)}
      {rest.length > 0 && <span className="ref-tag more" title={rest.map((chip) => chip.label).join("\n")}>+{rest.length}</span>}
    </div>
    <Info size={15} className="commit-more" />
  </button></div>;
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

function ChangesView({ snapshot, formOpen, message, generating, busy, onOpenForm, onOpenFile, onMessageChange, onGenerate, onPrepare }: { snapshot: RepoSnapshot; formOpen: boolean; message: string; generating: boolean; busy: boolean; onOpenForm: () => void; onOpenFile: (file: FileChange) => void; onMessageChange: (message: string) => void; onGenerate: () => void; onPrepare: () => void }) {
  const hasChanges = snapshot.changes.length > 0;
  return <div className="changes-view"><div className="changes-heading"><div><span className="eyebrow">ÁRBOL DE TRABAJO · {snapshot.currentBranch}</span><h3>{hasChanges ? `${snapshot.changes.length} cambios locales` : "Todo está limpio"}</h3></div><div className="changes-heading-actions"><button className="outline-button small" onClick={onOpenForm} disabled={!hasChanges || busy}><GitCommitHorizontal size={14} /> Commit</button><FileDiff size={19} /></div></div>{hasChanges ? <><div className="change-list">{snapshot.changes.map((change, index) => <button className="change-row" key={`${change.path}-${index}`} onClick={() => onOpenFile(change)} title={`Ver qué cambió en ${change.path}`}><span className={`change-code code-${change.code[0]?.toLowerCase()}`}>{change.code}</span><span className="change-status">{changeStatus(change.code)}</span><span className="change-path" title={change.path}>{change.path}</span><Info size={13} className="change-more" /></button>)}</div>{formOpen && <div className="commit-form"><div className="commit-form-heading"><div><span className="eyebrow">NUEVO COMMIT</span><h3>Describe estos cambios</h3></div><button className="outline-button" onClick={onGenerate} disabled={generating || busy}>{generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} Generar descripción</button></div><label htmlFor="commit-description">Mensaje del commit</label><textarea id="commit-description" value={message} onChange={(event) => onMessageChange(event.target.value)} maxLength={120} rows={3} placeholder="Escribe una descripción concisa de los cambios…" /><div className="commit-form-meta"><span>La generación analiza el diff local y sigue el idioma del historial de commits.</span><span>{message.length}/120</span></div><div className="commit-form-actions"><button className="primary-button" onClick={onPrepare} disabled={!message.trim() || busy}><ShieldCheck size={14} /> Preparar commit</button></div></div>}</> : <div className="graph-empty"><Check size={26} /><strong>No hay cambios sin confirmar</strong><span>El árbol de trabajo coincide con el último commit.</span></div>}</div>;
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
    {plan.allowed && plan.requiresConfirmation && plan.steps.length > 1 && <p className="plan-hint">Al confirmar se ejecutan los {plan.steps.length} pasos en orden. Si alguno falla, el plan se detiene ahí y te digo qué quedó sin hacer.</p>}
    {/* A plan with nothing to confirm is already running, so it offers no button that could decide otherwise. */}
    {plan.allowed && !plan.requiresConfirmation
      ? <p className="plan-running"><LoaderCircle className="spin" size={12} /> Sin nada que confirmar: se ejecuta sola.</p>
      : plan.allowed ? <div className="plan-actions"><button className="ghost-button" onClick={onDismiss}>Cancelar</button><button className="primary-button" onClick={() => void onApply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Confirmar acción</button></div>
      : asking ? <p className="plan-hint">Responde en el cuadro de abajo para continuar.</p>
      : <button className="ghost-button plan-close" onClick={onDismiss}>Entendido</button>}</div>;
}

function SettingsModal({ config, onClose, onSaved }: { config: LlmConfig; onClose: () => void; onSaved: (config: LlmConfig) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config.model || "gpt-5.6-luna");
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

/**
 * Naming a branch, with what the repository already writes offered as completions. When the name
 * starts with a prefix this repo spells differently, it says so and stops there: creation is never
 * blocked, because the convention is the user's to set, not the app's to enforce.
 */
function InputModal({ dialog, branches, onChange, onClose, onSubmit }: { dialog: InputDialog; branches: Branch[]; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  useEscape(onClose);
  const creating = dialog.operation === "create_branch";
  const options = useMemo(
    () => creating ? namingCompletions(branches) : branches.filter((branch) => !branch.isCurrent).map((branch) => branch.name),
    [creating, branches]
  );
  const hint = useMemo(() => creating ? variantHint(dialog.value, branches) : undefined, [creating, dialog.value, branches]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="input-modal" role="dialog" aria-modal="true" aria-labelledby="input-modal-title" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><div className="modal-heading"><div><div className="eyebrow">OPERACIÓN GIT</div><h2 id="input-modal-title">{dialog.title}</h2></div><button type="button" className="icon-button soft" onClick={onClose} aria-label="Cerrar"><X size={17} /></button></div><label>{dialog.label}<input autoFocus value={dialog.value} onChange={(event) => onChange(event.target.value)} list={options.length ? "branch-options" : undefined} maxLength={200} /></label>{options.length > 0 && <datalist id="branch-options">{options.map((option) => <option value={option} key={option} />)}</datalist>}{hint && <p className="naming-hint" role="status"><Lightbulb size={12} /><span>Este repositorio usa <code>{hint.canonical}/</code> ({plural(hint.count, "rama", "ramas")}). ¿Querías <button type="button" onClick={() => onChange(`${hint.canonical}/${dialog.value.trim().slice(hint.typed.length + 1)}`)}><code>{hint.canonical}/…</code></button>?</span></p>}<div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={!dialog.value.trim()}><GitBranch size={14} /> Preparar</button></div></form></div>;
}

const pendingLabels: Record<PendingOperationKind, string> = {
  rebase: "Rebase en curso",
  merge: "Fusión en curso",
  cherry_pick: "Cherry-pick en curso",
  revert: "Revert en curso"
};

/**
 * The repository is holding a half-finished job. This says which one, how far it got and what is in
 * the way, because "a rebase is happening" is not enough to decide anything — and every way out is
 * spelled out in terms of what it costs, since aborting and skipping both throw work away.
 */
function PendingBanner({ snapshot, busy, onContinue, onSkip, onAbort, onResolve }: {
  snapshot: RepoSnapshot; busy: boolean;
  onContinue: () => void; onSkip: () => void; onAbort: () => void; onResolve: () => void;
}) {
  const pending = snapshot.pending!;
  const progress = pending.step && pending.total ? ` · commit ${pending.step} de ${pending.total}` : "";
  const target = pending.branch && pending.onto ? ` · ${pending.branch} sobre ${pending.onto}` : pending.onto ? ` · ${pending.onto}` : "";
  const blocked = snapshot.conflicts.length;
  return <div className="rebase-banner">
    <AlertTriangle size={16} />
    <div>
      <strong>{pendingLabels[pending.kind]}{progress}</strong>
      <span>{blocked
        ? `${plural(blocked, "archivo en conflicto", "archivos en conflicto")}${target}. Nada continúa hasta resolverlos.`
        : `Sin conflictos abiertos${target}. Puedes continuar.`}</span>
    </div>
    {blocked > 0 && <button className="outline-button small" onClick={onResolve} disabled={busy} title="El asistente lee los dos lados y propone el archivo resuelto. No escribe nada hasta que lo aceptes."><Sparkles size={13} /> Proponer resolución</button>}
    <button className="outline-button small" onClick={onContinue} disabled={busy || blocked > 0} title={blocked ? "Quedan conflictos por resolver" : "Sigue desde donde se detuvo"}>Continuar</button>
    {canSkipPending(pending.kind) && <button className="danger-link" onClick={onSkip} disabled={busy} title="Descarta el commit en el que se atascó y sigue con el resto">Saltar commit</button>}
    <button className="danger-link" onClick={onAbort} disabled={busy} title="Deshace el trabajo a medias y deja el repositorio como estaba antes de empezar">Abortar</button>
  </div>;
}

function canSkipPending(kind: PendingOperationKind) { return kind === "rebase" || kind === "cherry_pick"; }

/**
 * The proposal, file by file, as a diff against what is on disk right now. This is the review the
 * whole feature rests on: accepting is a deliberate act per file, and the model's own doubt is shown
 * rather than buried, because a confident-looking wrong merge is the failure mode that matters.
 */
function ConflictProposalModal({ proposal, busy, onApply, onClose }: {
  proposal: ConflictProposal; busy: boolean; onApply: (resolutions: ConflictResolution[]) => void; onClose: () => void;
}) {
  const [accepted, setAccepted] = useState<string[]>(() => proposal.resolutions.filter((item) => item.confidence === "high").map((item) => item.path));
  useEscape(onClose);
  const toggle = (path: string) => setAccepted((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const chosen = proposal.resolutions.filter((resolution) => accepted.includes(resolution.path));

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="proposal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">RESOLUCIÓN PROPUESTA POR EL ASISTENTE</div><h2 id="proposal-title">Revisa antes de aceptar</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label="Descartar la propuesta"><X size={17} /></button>
      </div>
      <div className="modal-note"><ShieldCheck size={15} /><span>Nada se ha escrito todavía. Lo que aceptes se guarda en el archivo y se marca como resuelto; lo que no, se queda en conflicto tal como está.</span></div>
      {proposal.resolutions.map((resolution) => <div className={`resolution ${accepted.includes(resolution.path) ? "accepted" : ""}`} key={resolution.path}>
        <label className="resolution-heading">
          <input type="checkbox" checked={accepted.includes(resolution.path)} onChange={() => toggle(resolution.path)} />
          <div>
            <strong>{resolution.path}</strong>
            <span>{resolution.rationale}</span>
          </div>
          {resolution.confidence === "low" && <span className="resolution-doubt" title="El propio modelo avisa de que aquí tuvo que elegir. Míralo con calma.">Revisar con atención</span>}
        </label>
        <DiffView diff={lineDiff(proposal.current[resolution.path] ?? "", resolution.content)} truncated={false} />
      </div>)}
      {proposal.skipped.length > 0 && <div className="resolution-skipped">
        <span className="eyebrow">SIN RESOLVER</span>
        {proposal.skipped.map((entry) => <div key={entry.path}><strong>{entry.path}</strong><span>{entry.reason}</span></div>)}
      </div>}
      <div className="modal-actions">
        <button className="ghost-button" onClick={onClose}>Descartar todo</button>
        <button className="primary-button" onClick={() => onApply(chosen)} disabled={busy || !chosen.length}>
          <Check size={14} /> Aceptar {plural(chosen.length, "archivo", "archivos")}
        </button>
      </div>
    </div>
  </div>;
}

/**
 * A plain line-by-line difference, enough to see what the proposal changes. It is not Myers: for a
 * conflicted file against its resolution, showing the conflict block going and what replaced it is
 * what the reviewer needs, and a smarter algorithm would not tell them anything more.
 */
function lineDiff(before: string, after: string) {
  const from = before.split("\n");
  const to = after.split("\n");
  const shared = new Set(to);
  const kept = new Set(from);
  const lines: string[] = [`--- en conflicto`, `+++ propuesto`];
  let index = 0;
  for (const line of from) {
    if (shared.has(line)) {
      while (index < to.length && !kept.has(to[index])) lines.push(`+${to[index++]}`);
      if (index < to.length && to[index] === line) index += 1;
      lines.push(` ${line}`);
    } else lines.push(`-${line}`);
  }
  while (index < to.length) lines.push(`+${to[index++]}`);
  return lines.join("\n");
}

/** A unified diff, coloured by what each line does. No parsing beyond the first character. */
function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  if (!diff.trim()) return <div className="diff-empty">Este cambio no tiene diff de texto: puede ser un archivo binario, un permiso o un renombrado sin más.</div>;
  return <div className="diff-view"><pre>{lines.map((line, index) => {
    const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
      ? "meta"
      : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
    return <span className={`diff-line ${kind}`} key={index}>{line || " "}</span>;
  })}</pre>{truncated && <div className="diff-note">El diff se cortó porque era enorme. Lo que falta está en el repositorio, no aquí.</div>}</div>;
}

/**
 * What a commit actually changed. Until now this dialog listed a hash, an author and a date — every
 * fact about the commit except the only one anyone opens it for.
 */
function CommitModal({ commit, repoPath, onClose }: { commit: Commit; repoPath: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  useEscape(onClose);
  useEffect(() => {
    let live = true;
    window.branchline.getCommitDetail(repoPath, commit.hash)
      .then((next) => { if (live) setDetail(next); })
      .catch((reason) => { if (live) setError(cleanError(reason, "No se pudo leer el commit.")); });
    return () => { live = false; };
  }, [repoPath, commit.hash]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="commit-modal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">COMMIT {commit.shortHash}</div><h2 id="commit-modal-title">{commit.subject || "Commit sin mensaje"}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label="Cerrar detalles"><X size={17} /></button>
      </div>
      <dl>
        <div><dt>Autor</dt><dd>{commit.author}<span>{commit.email}</span></dd></div>
        <div><dt>Fecha</dt><dd>{formatDateFull(commit.date)}<span>{relativeTime(commit.date)}</span></dd></div>
        <div><dt>Hash</dt><dd><code>{commit.hash}</code></dd></div>
        {commit.parents.length > 1 && <div><dt>Merge</dt><dd>Diferencias frente al primer padre <code>{commit.parents[0].slice(0, 7)}</code>, que es lo que este merge trajo.</dd></div>}
      </dl>
      {error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      {!detail && !error && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> Leyendo el cambio…</div>}
      {detail && <>
        <div className="detail-files"><span className="eyebrow">{plural(detail.files.length, "ARCHIVO", "ARCHIVOS")}</span>
          {detail.files.map((file) => <div className="change-row" key={file.path}>
            <span className={`change-code code-${file.code[0]?.toLowerCase()}`}>{file.code}</span>
            <span className="change-status">{changeStatus(file.code)}</span>
            <span className="change-path" title={file.path}>{file.path}</span>
          </div>)}
        </div>
        <DiffView diff={detail.diff} truncated={detail.truncated} />
      </>}
    </div>
  </div>;
}

/** The same reading for a file that has not been committed yet. */
function FileDiffModal({ file, repoPath, onClose }: { file: FileChange; repoPath: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  useEscape(onClose);
  useEffect(() => {
    let live = true;
    window.branchline.getWorkingFileDiff(repoPath, file.path)
      .then((next) => { if (live) setDetail(next); })
      .catch((reason) => { if (live) setError(cleanError(reason, "No se pudo leer el archivo.")); });
    return () => { live = false; };
  }, [repoPath, file.path]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="file-modal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">CAMBIO SIN CONFIRMAR · {changeStatus(file.code)}</div><h2 id="file-modal-title">{file.path}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label="Cerrar diferencias"><X size={17} /></button>
      </div>
      {error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      {!detail && !error && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> Leyendo el archivo…</div>}
      {detail && <DiffView diff={detail.diff} truncated={detail.truncated} />}
    </div>
  </div>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
}
