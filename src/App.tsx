import { CatMark, SleepingCat } from "./CatMark";
import { NotificationCenter } from "./NotificationCenter";
import { addNotification, type Notification } from "../shared/notifications";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { isProtectedBranch, lifecycleOf, staleDays } from "../shared/branch-lifecycle";
import { buildCommitGraph, familyColour, maxLanes } from "../shared/commit-graph";
import { activityBaseline, changedBranches, parseActivityBaseline, pullRequestReference } from "../shared/repository-activity";
import type { GraphRow } from "../shared/commit-graph";
import { branchOrderLabels, defaultBranchOrder, isBranchOrder, isMergedIntoDefault, sortBranches } from "../shared/branch-order";
import type { BranchOrder } from "../shared/branch-order";
import type {
  ActionPlan, Branch, Commit, CommitDetail, ConflictProposal, ConflictResolution, ConversationMessage, ExecutionFailure,
  FileChange, HistoryScope, LlmConfig, Locale, Operation, PendingOperationKind, RepoSnapshot
} from "../shared/types";
import { localeTag, readLocale, translate, writeLocale, type MessageKey, type Translate } from "./i18n";

type ProjectTab = { id: string; snapshot: RepoSnapshot; loadedAt: string };
type ActivityItem = Notification;

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

type I18nContextValue = { locale: Locale; t: Translate; setLocale: (locale: Locale) => void };
const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("I18n context is missing");
  return value;
}

const palette = ["#ec806e", "#bda1e8", "#91c99b", "#86b4dc", "#e4be81"];

function formatDate(date: string, locale: Locale) {
  if (!date) return "—";
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat(localeTag(locale), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);
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

function remoteLabel(snapshot: RepoSnapshot, t: Translate) {
  const name = snapshot.remotes[0];
  if (!name) return t("noRemote");
  const url = snapshot.remoteUrls[name];
  const extra = snapshot.remotes.length > 1 ? ` +${snapshot.remotes.length - 1}` : "";
  return `${url ? shortRemote(url) : name}${extra}`;
}

function remoteTitle(snapshot: RepoSnapshot, t: Translate) {
  if (!snapshot.remotes.length) return t("noRemoteTitle");
  return snapshot.remotes.map((name) => `${name}: ${snapshot.remoteUrls[name] ?? t("noRemoteUrl")}`).join("\n");
}

function shortPath(path: string) {
  const pieces = path.split(/[\\/]/);
  return pieces.length > 3 ? `…/${pieces.slice(-2).join("/")}` : path;
}

function branchColor(index: number) { return palette[index % palette.length]; }

type PaneWidths = { sidebar: number; inspector: number };

const paneStorageKey = "gitcat-pane-widths";
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
function counted(t: Translate, count: number, singular: MessageKey, many: MessageKey) {
  return t("count", { count, word: t(count === 1 ? singular : many) });
}

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

const historyPrefsStorageKey = (path: string) => `gitcat-history:${path}`;

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
function relativeTime(date: string, locale: Locale) {
  const value = Date.parse(date);
  if (Number.isNaN(value)) return date || "—";
  const seconds = Math.round((Date.now() - value) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] =
    [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(-Math.round(seconds / size), unit);
  return formatter.format(-seconds, "second");
}

function formatDateFull(date: string, locale: Locale) {
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "full", timeStyle: "short" }).format(value);
}

const branchViewStorageKey = (path: string) => `gitcat-branch-view:${path}`;

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
function suggestionsFor(snapshot: RepoSnapshot, t: Translate): Suggestion[] {
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
    label: t("pendingRebase"),
    question: t("rebaseSuggestion", { branch })
  });
  if (snapshot.isDirty) options.push({
    key: "changes",
    icon: FileDiff,
    label: t("reviewUncommitted", { changes: counted(t, snapshot.changes.length, "change", "changes") }),
    question: t("reviewUncommittedQuestion")
  });
  if (current?.behind) options.push({
    key: "behind",
    icon: ArrowDownToLine,
    label: t("bringFromRemote", { commits: counted(t, current.behind, "newCommitWord", "newCommits") }),
    question: current.behind === 1
      ? t("integrateOneRemoteCommit", { branch, upstream: current.upstream ?? t("remote") })
      : t("integrateRemoteCommits", { branch, count: current.behind, upstream: current.upstream ?? t("remote") })
  });
  if (current?.ahead) options.push({
    key: "ahead",
    icon: ArrowUpFromLine,
    label: t("reviewUnpublished", { commits: counted(t, current.ahead, "commit", "commits") }),
    question: current.ahead === 1
      ? t("reviewOneUnpublishedQuestion", { branch })
      : t("reviewUnpublishedQuestion", { count: current.ahead, branch })
  });
  if (!snapshot.remotes.length) options.push({
    key: "publish",
    icon: Cloud,
    label: t("publishRepository"),
    question: t("publishRepositoryQuestion")
  });
  if (base) options.push({
    key: "merge",
    icon: GitMerge,
    label: t("mergeBranchTo", { name: base.name, target: branch }),
    dialog: { operation: "merge", title: t("mergeBranch"), label: t("branchToMerge"), value: base.name }
  });
  if (base) options.push({
    key: "compare",
    icon: GitBranch,
    label: t("compareBranches", { branch, base: base.name }),
    question: t("compareBranchesQuestion", { branch, base: base.name })
  });
  options.push({
    key: "cleanup",
    icon: Trash2,
    label: t("findDeletableBranches"),
    question: t("findDeletableBranchesQuestion")
  });
  options.push({
    key: "authors",
    icon: UserRound,
    label: t("recentAuthors"),
    question: t("recentAuthorsQuestion")
  });
  options.push({
    key: "review",
    icon: Sparkles,
    label: t("reviewRepository"),
    question: t("reviewRepositoryQuestion", { branch })
  });

  return options.slice(0, 3);
}

export default function App() {
  const [locale, setLocaleState] = useState<Locale>(readLocale);
  const t = useMemo(() => translate(locale), [locale]);
  const setLocale = (next: Locale) => { setLocaleState(next); writeLocale(next); };
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
  const [view, setView] = useState<"overview" | "history" | "changes">("overview");
  const [selectedCommit, setSelectedCommit] = useState<Commit>();
  const [selectedFile, setSelectedFile] = useState<FileChange>();
  const [proposal, setProposal] = useState<ConflictProposal>();
  const [resolving, setResolving] = useState(false);
  const [inputDialog, setInputDialog] = useState<InputDialog>();
  const [commitFormOpen, setCommitFormOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [deliveryMerge, setDeliveryMerge] = useState(false);
  const [deliveryStateId, setDeliveryStateId] = useState<string>();
  const [deliveryReview, setDeliveryReview] = useState<{ turnId: number; plan: ActionPlan }>();
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [panes, setPanes] = useState<PaneWidths | undefined>(readPaneWidths);
  const requestSequence = useRef(0);
  const activitySequence = useRef(0);
  const conversationSequence = useRef(0);
  const workspaceRestored = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLElement>(null);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const active = projects.find((project) => project.id === activeId);
  const snapshot = active?.snapshot;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
    window.gitcat.getLlmConfig().then(setConfig).catch((error) => {
      notify({ message: error instanceof Error ? error.message : t("fallbackReadConfig"), tone: "error" });
    });
    window.gitcat.restoreWorkspace().then((workspace) => {
      const loadedAt = new Date().toISOString();
      const restored = workspace.projects.map((project) => ({ id: project.path, snapshot: project, loadedAt }));
      setProjects(restored);
      setActiveId(restored.find((project) => project.snapshot.path === workspace.activePath)?.id ?? restored[0]?.id);
    }).catch((error) => {
      notify({ message: error instanceof Error ? error.message : t("fallbackRestoreProjects"), tone: "error" });
    }).finally(() => {
      workspaceRestored.current = true;
      setWorkspaceReady(true);
    });
  }, []);

  useEffect(() => {
    if (!workspaceRestored.current || !workspaceReady) return;
    const paths = projects.map((project) => project.snapshot.path);
    const activePath = projects.find((project) => project.id === activeId)?.snapshot.path;
    window.gitcat.saveWorkspace(paths, activePath).catch((error) => {
      notify({ message: error instanceof Error ? error.message : t("fallbackSaveWorkspace"), tone: "error" });
    });
  }, [projects, activeId, workspaceReady, t]);


  useEffect(() => {
    requestSequence.current += 1;
    setRequest("");
    setSelectedBranch(undefined);
    setCommitFilter("");
    setView("overview");
    setCommitFormOpen(false);
    setCommitMessage("");
    setDeliveryReview(undefined);
    setDeliveryStateId(undefined);
    setDeliveryMerge(false);
    setGeneratingDescription(false);
  }, [activeId]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conversation]);

  const dismissActivity = (id: number) => {
    setActivity((items) => items.filter((item) => item.id !== id));
  };

  const addActivity = (item: Omit<ActivityItem, "id">) => {
    const id = ++activitySequence.current;
    setActivity((items) => addNotification(items, { ...item, id }));
  };

  const notify = ({ message, tone }: { message: string; tone: "success" | "error" }) => {
    addActivity({ label: t(tone === "error" ? "gitNeedsAttention" : "notificationDone"), detail: message, tone: tone === "error" ? "warning" : "success" });
  };

  const dismissAllActivity = () => {
    setActivity([]);
  };

  const updateSnapshot = (path: string, next: RepoSnapshot) => {
    setProjects((items) => items.map((project) => project.snapshot.path === path
      ? { ...project, snapshot: next, loadedAt: new Date().toISOString() }
      : project));
  };

  const openProject = async () => {
    try {
      const next = await window.gitcat.selectProject();
      if (!next) return;
      const existing = projects.find((project) => project.snapshot.path === next.path);
      if (existing) { updateSnapshot(next.path, next); setActiveId(existing.id); return; }
      const id = `${next.path}-${Date.now()}`;
      setProjects((items) => [...items, { id, snapshot: next, loadedAt: new Date().toISOString() }]);
      setActiveId(id);
      addActivity({ label: t("projectOpen"), detail: next.name, tone: "success" });
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackOpenProject")), tone: "error" });
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
      const next = await window.gitcat.getSnapshot(path);
      updateSnapshot(path, next);
      if (announce) addActivity({ label: t("stateUpdated"), detail: next.currentBranch, tone: "neutral" });
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackRefresh")), tone: "error" });
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
      ? `${turn.plan.allowed ? t("planWord") : t("refusalWord")}: ${turn.plan.summary}. ${turn.plan.rationale}`
      : undefined);
    return response ? [{ role: "user" as const, content: turn.question }, { role: "assistant" as const, content: response }] : [];
  });

  const showPlan = async (question: string, loader: () => Promise<ActionPlan>, path = snapshot?.path, review = false) => {
    if (!path || planning) return;
    const turnId = addTurn(path, question);
    try {
      const plan = await loader();
      if (plan.repoPath !== path) throw new Error(t("planOtherRepository"));
      if (plan.answer) {
        updateTurn(path, turnId, (turn) => ({ ...turn, answer: plan.answer, status: "completed" }));
        addActivity({ label: t("responsePrepared"), detail: plan.summary, tone: "neutral" });
        return;
      }
      if (review && plan.allowed && plan.requiresConfirmation && snapshotRef.current?.path === path) setDeliveryReview({ turnId, plan });
      const unattended = plan.allowed && !plan.requiresConfirmation;
      updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: plan.allowed ? "ready" : "completed" }));
      addActivity({
        label: unattended ? t("actionInProgress") : plan.allowed ? t("planPrepared") : plan.kind === "question" ? t("assistantQuestion") : t("requestRejected"),
        detail: plan.summary,
        tone: plan.kind === "refusal" ? "warning" : "neutral"
      });
      // Nothing to weigh up: a plan that changes no work does not need a click to say so.
      if (unattended) await runPlan(turnId, plan);
    } catch (error) {
      const message = cleanError(error, t("fallbackPrepareAction"));
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      if (config.configured) await recoverFrom(path, {
        command: question,
        summary: t("prepareRequestedAction"),
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
    await showPlan(question, () => window.gitcat.planAction(path, question, context, locale), path);
  };

  const prepare = async (operation: Operation, args: Record<string, string> = {}, question?: string) => {
    if (!snapshot) return;
    const labels: Partial<Record<Operation, string>> = {
      checkout: t("switchBranch", { name: args.name }),
      create_branch: t("createNamedBranch", { name: args.name }),
      delete_branch: t("deleteNamedBranch", { name: args.name }),
      rename_branch: t("renameNamedBranch", { name: args.name, to: args.to }),
      fetch: t("updateRemoteRefs"),
      push: t("publishCurrentBranch"),
      merge: t("mergeNamedBranch", { name: args.name }),
      rebase: t("rebaseOnto", { name: args.onto }),
      abort_operation: t("abortHalfFinished"),
      continue_operation: t("continueOperation"),
      skip_operation: t("skipStuckCommit"),
      resolve_conflict: t("resolveConflictNamed", { path: args.path }),
      commit: t("createCommitNamed", { message: args.message ?? "" }),
      github_create_repo: t("createPrivateRepo", { owner: args.owner, name: args.name, host: args.host })
    };
    const path = snapshot.path;
    await showPlan(question ?? labels[operation] ?? t("prepareGitOperation"), () => window.gitcat.prepareOperation(path, operation, args, locale), path);
  };

  const prepareMergeToDefault = async (name: string) => {
    if (!snapshot?.defaultBranch) return;
    const path = snapshot.path;
    const target = snapshot.defaultBranch;
    const question = t("mergeQuestion", { name, target });
    // A clean branch can use the verified direct path. Once the working tree is dirty, the model must
    // decide whether those changes belong to this branch and, if so, place a commit before the merge.
    const context = conversationContext(conversations[path] ?? []);
    await showPlan(question, snapshot.isDirty
      ? () => window.gitcat.planAction(path, question, context, locale)
      : () => window.gitcat.prepareMergeToDefault(path, name, locale), path);
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
    const turnId = addTurn(path, t("actionQuestion"));
    try {
      const plan = await window.gitcat.planRecovery(path, failure, context, locale);
      if (plan.repoPath !== path) throw new Error(t("planOtherRepository"));
      if (plan.answer) {
        updateTurn(path, turnId, (turn) => ({ ...turn, answer: plan.answer, status: "completed" }));
        return;
      }
      // Never unattended: a way out of a half-finished operation is always the user's call.
      updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: plan.allowed ? "ready" : "completed" }));
    } catch (error) {
      updateTurn(path, turnId, (turn) => ({
        ...turn,
        error: cleanError(error, t("fallbackRecovery")),
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
      setProposal(await window.gitcat.proposeConflictResolution(snapshot.path, locale));
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackProposeResolution")), tone: "error" });
    } finally { setResolving(false); }
  };

  const applyResolutions = async (resolutions: ConflictResolution[]) => {
    if (!snapshot || !resolutions.length) return;
    const path = snapshot.path;
    try {
      updateSnapshot(path, await window.gitcat.applyConflictResolution(path, resolutions, locale));
      setProposal(undefined);
      addActivity({ label: t("conflictsResolved"), detail: counted(t, resolutions.length, "acceptedFile", "acceptedFiles"), tone: "success" });
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackApplyResolution")), tone: "error" });
      await refreshProject(path, false);
    }
  };

  const runPlan = async (turnId: number, plan: ActionPlan) => {
    updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, status: "executing" }));
    try {
      const result = await window.gitcat.executePlan(plan.repoPath, plan.id, locale);
      updateSnapshot(plan.repoPath, result.snapshot);
      if (result.error) {
        // A sequence that stopped halfway did change the repository: show what ran, not only the failure.
        const progress = plan.steps.length > 1 ? result.output : undefined;
        updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, outcome: progress, error: result.error, status: "error" }));
        addActivity({ label: t("gitNeedsAttention"), detail: result.error, tone: "warning" });
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
        const outcome = result.output || t("completed", { summary: plan.summary });
        updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, outcome, status: "completed" }));
        addActivity({ label: t("actionExecuted"), detail: outcome, tone: "success" });
        if (plan.steps.some((step) => step.operation === "commit")) {
          setCommitMessage("");
          setCommitFormOpen(false);
        }
      }
    } catch (error) {
      const message = cleanError(error, t("fallbackGitAction"));
      updateTurn(plan.repoPath, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      notify({ message, tone: "error" });
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
    const turnId = addTurn(path, t("branchSwitchQuestion", { name }));
    try {
      const plan = await window.gitcat.prepareOperation(path, "checkout", { name }, locale);
      if (plan.repoPath !== path) throw new Error(t("planOtherRepository"));
      if (!plan.allowed) {
        updateTurn(path, turnId, (turn) => ({ ...turn, plan, status: "completed" }));
        addActivity({ label: t("branchSwitchFailed"), detail: plan.summary, tone: "warning" });
        return;
      }
      updateTurn(path, turnId, (turn) => ({ ...turn, plan }));
      await runPlan(turnId, plan);
    } catch (error) {
      const message = cleanError(error, t("branchSwitchFailed"));
      updateTurn(path, turnId, (turn) => ({ ...turn, error: message, status: "error" }));
      addActivity({ label: t("branchSwitchFailed"), detail: message, tone: "warning" });
      if (config.configured) await recoverFrom(path, {
        command: `git switch ${name}`,
        summary: t("switchBranch", { name }),
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
      const result = await window.gitcat.generateCommitDescription(repoPath, locale);
      if (requestSequence.current === sequence && result.stateId === stateId && snapshotRef.current?.stateId === result.stateId && snapshotRef.current?.path === repoPath) {
        setCommitMessage(result.description);
        setCommitFormOpen(true);
      }
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackGenerateDescription")), tone: "error" });
      await refreshProject(repoPath, false);
    } finally { setGeneratingDescription(false); }
  };

  const beginDelivery = (merge: boolean) => {
    if (!snapshot || planning || generatingDescription) return;
    setDeliveryMerge(merge);
    setDeliveryStateId(snapshot.stateId);
    if (snapshot.isDirty) {
      openCommitForm();
      if (config.configured && !commitMessage.trim()) void generateDescription();
    } else if (merge) {
      void showPlan(t("integrateInto", { target: snapshot.defaultBranch ?? "" }),
        () => window.gitcat.prepareBranchDelivery(snapshot.path, { stateId: snapshot.stateId, mergeToDefault: true }, locale), snapshot.path, true);
    }
  };

  const prepareCommit = () => {
    const message = commitMessage.trim();
    if (!snapshot?.changes.length || !message || message.length > 120) return;
    const path = snapshot.path;
    void showPlan(t(deliveryMerge ? "saveAndIntegrate" : "saveChanges", { target: snapshot.defaultBranch ?? "" }),
      () => window.gitcat.prepareBranchDelivery(path, { stateId: deliveryStateId ?? snapshot.stateId, message, mergeToDefault: deliveryMerge }, locale), path, true);
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
    <I18nContext.Provider value={{ locale, t, setLocale }}>
    <div className={`app-shell platform-${window.gitcat.platform}`}>
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><CatMark size={28} /></div><span>GitCat</span></div>
        <div className="window-tabs" role="tablist" aria-label={t("openProjects")}>
          {projects.map((project) => <div key={project.id} className={`window-tab ${project.id === activeId ? "active" : ""}`}>
            <button role="tab" aria-selected={project.id === activeId} onClick={() => setActiveId(project.id)}><GitBranch size={14} /><span>{project.snapshot.name}</span></button>
            <button className="tab-close" onClick={() => closeProject(project.id)} aria-label={t("closeProject", { name: project.snapshot.name })}><X size={13} /></button>
          </div>)}
          <button className="icon-button tab-add" onClick={() => void openProject()} aria-label={t("openProject")}><Plus size={16} /></button>
        </div>
        <div className="top-actions"><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={t("settings")}><Settings2 size={17} /></button></div>
      </header>
      <NotificationCenter items={activity} onDismiss={dismissActivity} onClear={dismissAllActivity} t={t} />

      {!workspaceReady ? <div className="workspace-loading"><LoaderCircle className="spin" size={24} /><span>{t("restoringProjects")}</span></div> : !config.configured && !exploring ? <ProviderRequired onConfigure={() => setSettingsOpen(true)} onExplore={() => setExploring(true)} /> : !snapshot ? <Welcome openProject={openProject} /> : <>
        {!config.configured && <div className="provider-banner" role="status"><Eye size={14} /><span><strong>{t("noProviderBanner")}</strong> {t("noProviderBannerDetail")}</span><button className="outline-button small" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /> {t("configure")}</button></div>}


        <main className="main-layout" ref={layoutRef} style={paneStyle}>
          {panes && <PaneDivider edge="sidebar" width={panes.sidebar} onPointerDown={startResize("sidebar")} onNudge={(delta) => nudgePane("sidebar", delta)} onReset={() => resetPane("sidebar")} />}
          {panes && <PaneDivider edge="inspector" width={panes.inspector} onPointerDown={startResize("inspector")} onNudge={(delta) => nudgePane("inspector", delta)} onReset={() => resetPane("inspector")} />}
          <aside className="sidebar">
            <div className="sidebar-project"><div className="folder-icon"><FolderGit2 size={23} /></div><div><strong>{snapshot.name}</strong><span title={snapshot.path}>{shortPath(snapshot.path)}</span></div></div>
            <BranchPanel
              key={snapshot.path}
              snapshot={snapshot}
              busy={planning}
              selected={selection}
              onSelect={setSelectedBranch}
              onCreate={() => setInputDialog({ operation: "create_branch", title: t("newBranch"), label: t("branchName"), value: "" })}
              onSwitch={(name) => void prepare("checkout", { name })}
              onSwitchNow={(name) => void switchBranch(name)}
              onDelete={(name) => void prepare("delete_branch", { name })}
              onRename={(name, to) => void prepare("rename_branch", { name, to })}
              onMergeToDefault={(name) => void prepareMergeToDefault(name)}
            />
            <div className="sidebar-mascot"><SleepingCat /><span>{t("oneStepAtATime")}</span></div>
          </aside>

          <section className="graph-area">
            <div className="workspace-header"><div className="workspace-intro"><h1>{t("workInContext")}</h1><div className="project-breadcrumb"><span>{snapshot.name}</span><span aria-hidden="true">/</span><strong title={snapshot.currentBranch}>{snapshot.currentBranch}</strong></div></div><div className="workspace-actions"><button className="ghost-button" onClick={() => void refreshProject()} disabled={Boolean(refreshingPath)}>{refreshingPath === snapshot.path ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />} {t("refresh")}</button><button className="ghost-button" onClick={() => void prepare("fetch")} disabled={planning}><ArrowDownToLine size={15} /> {t("fetch")}</button><button className="ghost-button" onClick={() => void prepare("push")} disabled={planning}><ArrowUpFromLine size={15} /> {t("push")}</button></div></div>
            <div className="graph-toolbar"><div className="view-tabs"><button className={`view-tab ${view === "overview" ? "active" : ""}`} onClick={() => setView("overview")}>{t("overview")}</button><button className={`view-tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>{t("history")}</button><button className={`view-tab ${view === "changes" ? "active" : ""}`} onClick={() => setView("changes")}>{t("changesTab")} <span className="count-badge">{snapshot.changes.length}</span></button></div>{view !== "changes" && <div className="graph-tools"><div className="search-field commit-search"><Search size={14} /><input aria-label={t("searchCommits")} value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} placeholder={t("searchCommits")} /></div></div>}</div>
            {snapshot.pending && <PendingBanner
              snapshot={snapshot}
              busy={planning}
              onContinue={() => void prepare("continue_operation")}
              onSkip={() => void prepare("skip_operation")}
              onAbort={() => void prepare("abort_operation")}
              onResolve={() => void resolveConflicts()}
            />}
            <BranchWorkCard snapshot={snapshot} busy={planning || generatingDescription} onSave={() => beginDelivery(false)} onIntegrate={() => beginDelivery(true)} />
            {view === "overview" ? <RepositoryOverview key={snapshot.path} snapshot={snapshot} filter={commitFilter} onSelect={setSelectedCommit} onChanges={() => setView("changes")} /> : view === "history" ? <HistoryView key={snapshot.path} snapshot={snapshot} selection={selection} filter={commitFilter} onSelect={setSelectedCommit} />
              : <ChangesView snapshot={snapshot} merge={deliveryMerge} configured={config.configured} stale={Boolean(deliveryStateId && deliveryStateId !== snapshot.stateId)} onReviewAgain={() => beginDelivery(deliveryMerge)} onMergeChange={setDeliveryMerge} onOpenFile={setSelectedFile} formOpen={commitFormOpen} message={commitMessage} generating={generatingDescription} busy={planning} onOpenForm={() => beginDelivery(false)} onMessageChange={setCommitMessage} onGenerate={() => void generateDescription()} onPrepare={prepareCommit} />}
          </section>

          <aside className="inspector"><div className="inspector-header"><div><div className="eyebrow">{t("assistant")}</div><h2>{t("assistantHeading")}</h2></div><div className="assistant-icon"><CatMark size={29} outline /></div></div><div className="assistant-body"><p className="assistant-copy">{config.configured ? t("assistantConfiguredCopy") : t("assistantUnconfiguredCopy")}</p>{conversation.length === 0 && config.configured && <div className="suggestion-list">{suggestionsFor(snapshot, t).map((suggestion) => <button key={suggestion.key} onClick={() => "question" in suggestion ? askSuggestion(suggestion.question) : setInputDialog(suggestion.dialog)} disabled={planning} title={"question" in suggestion ? suggestion.question : suggestion.label}><suggestion.icon size={15} /><span>{suggestion.label}</span></button>)}</div>}<div className="conversation-toolbar"><span>{conversation.length ? counted(t, conversation.length, "message", "messages") : t("newConversation")}</span><button onClick={() => setConversations((items) => ({ ...items, [snapshot.path]: [] }))} disabled={!conversation.length || planning}><Trash2 size={12} /> {t("clearConversation")}</button></div><div className="conversation" aria-live="polite">{conversation.map((turn) => <ConversationEntry key={turn.id} turn={turn} busy={planning} onApply={(plan) => void applyPlan(turn.id, plan)} onDismiss={() => updateTurn(snapshot.path, turn.id, (item) => ({ ...item, status: "cancelled", outcome: t("planDiscarded") }))} />)}<div ref={conversationEnd} /></div></div><div className="chat-compose"><textarea aria-label={t("assistantRequest")} disabled={!config.configured} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder={config.configured ? t("assistantPlaceholder") : t("configureAssistantPlaceholder")} rows={3} /><button className="send-button" aria-label={t("prepareRequest")} onClick={() => void propose(request)} disabled={planning || !request.trim() || !config.configured}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div></aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className={`status-good ${snapshot.isDirty ? "has-changes" : ""}`}><CircleDot size={12} /> {snapshot.isDirty ? counted(t, snapshot.changes.length, "change", "changes") : t("noUncommittedChanges")}</span><span className="status-separator" /><span>{counted(t, branchCount.local, "localBranch", "localBranches")}{branchCount.remoteOnly ? `, ${branchCount.remoteOnly} ${t("remoteOnly")}` : ""}</span></div><div className="status-right"><span><Clock3 size={12} /> {t("lastRead", { date: formatDate(active.loadedAt, locale) })}</span><span className="remote-status" title={remoteTitle(snapshot, t)}><Cloud size={12} /> {remoteLabel(snapshot, t)}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : t("llmNotConfigured")}</span></div></footer>
      </>}
      {deliveryReview && <DeliveryReviewModal review={deliveryReview} busy={planning}
        onClose={() => { updateTurn(deliveryReview.plan.repoPath, deliveryReview.turnId, (turn) => ({ ...turn, status: "cancelled", outcome: t("planDiscarded") })); setDeliveryReview(undefined); }}
        onApply={async () => { const review = deliveryReview; setDeliveryReview(undefined); await applyPlan(review.turnId, review.plan); }} />}
      {settingsOpen && <SettingsModal config={config} locale={locale} onLocaleChange={setLocale} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); notify({ message: t("settingsSaved"), tone: "success" }); }} />}
      {inputDialog && <InputModal dialog={inputDialog} branches={snapshot?.branches ?? []} onChange={(value) => setInputDialog({ ...inputDialog, value })} onClose={() => setInputDialog(undefined)} onSubmit={submitInputDialog} />}
      {selectedCommit && snapshot && <CommitModal commit={selectedCommit} repoPath={snapshot.path} onClose={() => setSelectedCommit(undefined)} />}
      {selectedFile && snapshot && <FileDiffModal file={selectedFile} repoPath={snapshot.path} onClose={() => setSelectedFile(undefined)} />}
      {proposal && <ConflictProposalModal proposal={proposal} busy={planning} onApply={(resolutions) => void applyResolutions(resolutions)} onClose={() => setProposal(undefined)} />}
      {resolving && <div className="resolving-overlay" role="status"><LoaderCircle className="spin" size={22} /><span>{t("readConflictSides")}</span></div>}
    </div>
    </I18nContext.Provider>
  );
}

function Welcome({ openProject }: { openProject: () => Promise<void> }) {
  const { t } = useI18n();
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><CatMark size={42} /></div><div className="eyebrow">{t("branchWorkspace")}</div><h1>{t("yourGitClearer")}</h1><p>{t("welcomeCopy")}</p><button className="primary-button welcome-button" onClick={() => void openProject()}><FolderOpen size={16} /> {t("openProject")}</button><div className="welcome-features"><span><GitMerge size={14} /> {t("safeRebase")}</span><span><MessageCircle size={14} /> {t("naturalLanguage")}</span><span><ShieldCheck size={14} /> {t("protectedCommands")}</span></div><div className="welcome-footnote">{t("configuredLlmProvider")}</div></div></div>;
}

/**
 * GitCat interprets every request with the configured model — there is no keyword fallback — so
 * the provider is a hard requirement rather than an optional extra.
 */
function ProviderRequired({ onConfigure, onExplore }: { onConfigure: () => void; onExplore: () => void }) {
  const { t } = useI18n();
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><CatMark size={42} /></div><div className="eyebrow">{t("requiredLlmProvider")}</div><h1>{t("connectModel")}</h1><p>{t("requiredProviderCopy")}</p><button className="primary-button welcome-button" onClick={onConfigure}><Settings2 size={16} /> {t("configureProvider")}</button><button className="ghost-button welcome-button" onClick={onExplore}><Eye size={15} /> {t("viewWithoutProvider")}</button><div className="welcome-features"><span><MessageCircle size={14} /> {t("anyLanguage")}</span><span><ShieldCheck size={14} /> {t("verifiedPlans")}</span><span><Bot size={14} /> {t("noKeywords")}</span></div><div className="welcome-footnote">{t("encryptedApiKey")}</div></div></div>;
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
  const { t } = useI18n();
  const label = edge === "sidebar" ? t("branchColumnWidth") : t("assistantColumnWidth");
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
    title={`${label} · ${t("resizePaneHint")}`}
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
  const { t } = useI18n();
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
        title={`${node.group.label}/ · ${counted(t, node.group.count, "branch", "branches")}`}
      ><ChevronRight className={`branch-chevron ${open ? "open" : ""}`} size={12} /><span className="branch-group-label">{node.group.label}</span><span className="branch-group-count">{node.group.count}</span></button>,
      ...(open ? renderNodes(node.group.children, depth + 1, trim || node.group.label) : [])
    ];
  });

  // A lone group, and the group of branches with no prefix at all, are headings over nothing.
  const topLevel: BranchNode[] = visible.groups.flatMap((group) =>
    visible.showHeaders && group.kind === "prefix" ? [{ kind: "group" as const, group }] : group.children);

  return <div className="sidebar-section branch-section">
    <div className="section-heading"><span>{t("branches")}</span><div className="branch-tools">
      <div className="mode-toggle" role="group" aria-label={t("branchListMode")}>
        <button className={view.mode === "tree" ? "active" : ""} aria-pressed={view.mode === "tree"} onClick={() => setMode("tree")} title={t("groupByPrefix")}><ListTree size={13} /></button>
        <button className={view.mode === "flat" ? "active" : ""} aria-pressed={view.mode === "flat"} onClick={() => setMode("flat")} title={t("flatList")}><List size={13} /></button>
      </div>
      <button className="mini-icon" onClick={onCreate} aria-label={t("createBranch")}><Plus size={14} /></button>
    </div></div>
    <div className="search-field"><Search size={14} /><input aria-label={t("filterBranches")} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("filterBranches")} /></div>
    <div className="branch-filters">
      <label className="order-field"><ArrowDownWideNarrow size={12} /><span className="visually-hidden">{t("orderBranches")}</span><select aria-label={t("orderBranches")} value={order} onChange={(event) => update({ order: event.target.value as BranchOrder })}>
        {(Object.keys(branchOrderLabels) as BranchOrder[]).map((value) => <option value={value} key={value}>{t(value === "activity" ? "recentActivity" : value === "active" ? "activeFirst" : "alphabetical")}</option>)}
      </select></label>
      {/* A repository with nothing integrated has nothing to hide, so the control does not appear at all. */}
      {merged.length > 0 && <button
        className={`merged-toggle ${hideMerged ? "active" : ""}`}
        aria-pressed={hideMerged}
        onClick={() => update({ hideMerged: !hideMerged })}
        title={t("mergedHiddenTitle", { count: merged.length, branch: snapshot.defaultBranch ?? "" })}
      >{hideMerged ? <EyeOff size={12} /> : <Eye size={12} />}<span>{t("mergedBranches")}</span><span className="merged-count">{merged.length}</span></button>}
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
        ? t("allOtherBranchesMerged", { branch: snapshot.defaultBranch ?? "" })
        : t("noMatchingBranches")}</div>}
    </div>
    {contextMenu && snapshot.defaultBranch && <div
      ref={contextMenuRef}
      className="branch-context-menu"
      role="menu"
      aria-label={t("actionsFor", { name: contextMenu.branch.name })}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    ><button
      role="menuitem"
      autoFocus
      disabled={busy}
      onClick={() => { const name = contextMenu.branch.name; setContextMenu(undefined); onMergeToDefault(name); }}
    ><GitMerge size={14} /><span>{t("mergeBranchTo", { name: contextMenu.branch.name, target: snapshot.defaultBranch ?? "" })}</span></button></div>}
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
  const { t } = useI18n();
  const [title, detail] = suggestion.kind === "prefix"
    ? [`${suggestion.variant}/ vs ${suggestion.canonical}/`,
       `${counted(t, suggestion.variantCount, "branchWrites", "branchesWrite")} ${suggestion.variant}/; ${counted(t, suggestion.canonicalCount, "writes", "write")} ${suggestion.canonical}/.`]
    : [`${suggestion.token}-… vs ${suggestion.token}/…`,
       `${counted(t, suggestion.renames.length, "branchUses", "branchesUse")} “-” where the rest of the repository uses “/”.`];
  return <div className="naming-suggestion">
    <div className="naming-heading">
      <Lightbulb size={13} />
      <div><strong>{title}</strong><span>{detail}</span></div>
      <button className="mini-icon" onClick={onDismiss} aria-label={t("dismissSuggestion", { title })} title={t("neverSuggestAgain")}><X size={13} /></button>
    </div>
    <ul>{suggestion.renames.map((rename) => <li key={rename.from}>
      <code title={`${rename.from} → ${rename.to}`}>{rename.from} → {rename.to}</code>
      <button className="outline-button small" disabled={busy} onClick={() => onRename(rename.from, rename.to)} title={t("prepareRename", { from: rename.from, to: rename.to })}>{t("rename")}</button>
    </li>)}</ul>
  </div>;
}

function presenceLabel(presence: Branch["presence"], t: Translate) {
  return presence === "local" ? t("branchLocal") : presence === "remote" ? t("branchRemote") : t("branchBoth");
}

/** Where the branch lives, at a glance: the machine, the cloud, or both. */
function PresenceBadge({ branch }: { branch: Branch }) {
  const { t } = useI18n();
  const detail = branch.remoteRef ? `${presenceLabel(branch.presence, t)} (${branch.remoteRef})` : presenceLabel(branch.presence, t);
  return <span className={`branch-presence ${branch.presence}`} title={detail} aria-label={detail} role="img">
    {branch.presence !== "remote" && <Laptop size={12} />}
    {branch.presence !== "local" && <Cloud size={12} />}
  </span>;
}

/**
 * One click prepares the switch as a plan; a double click just does it. The single-click action waits
 * out the double-click window so the same gesture never produces both.
 */
function branchTooltip(branch: Branch, defaultBranch: string | undefined, t: Translate) {
  const parts = [branch.name, presenceLabel(branch.presence, t)];
  if (branch.name === defaultBranch) parts.push(t("mainBranch"));
  // Integration is what tells you whether deleting the branch would lose anything.
  if (branch.mergedInto.length) parts.push(t("mergedInto", { branches: branch.mergedInto.join(t("and")) }));
  else if (!branch.isCurrent) parts.push(t("notMerged"));
  if (branch.checkedOutIn) parts.push(t("worktreeUse", { path: branch.checkedOutIn }));
  if (branch.stackedOn) parts.push(t("stackedOn", { branch: branch.stackedOn }));
  const lifecycle = lifecycleOf(branch.name);
  if (lifecycle !== "unknown") parts.push(t("lifecycle", { label: t(`lifecycle_${lifecycle}` as MessageKey) }));
  return parts.join(" · ");
}

/**
 * A click selects, a double click switches. Selecting is not a Git operation: it only decides which
 * branch the rest of the window is talking about, which is the thing you want far more often than a
 * checkout. Changing branch stays an explicit gesture — the double click, or the button on the row.
 */
function BranchRow({ branch, label, variant, merged, selected, defaultBranch, colour, depth, busy, register, onSelect, onSwitch, onSwitchNow, onDelete, onContextMenu }: { branch: Branch; label: string; variant: boolean; merged: boolean; selected: boolean; defaultBranch?: string; colour: string; depth: number; busy: boolean; register: (node: HTMLButtonElement | null) => void; onSelect: () => void; onSwitch: () => void; onSwitchNow: () => void; onDelete: () => void; onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void }) {
  const { t } = useI18n();
  const isDefault = branch.name === defaultBranch;
  const protectedByPrefix = isProtectedBranch(branch.name);
  // Read once per render rather than per row: the panel redraws on every snapshot anyway.
  const stale = staleDays(branch, Date.now());
  return <div onContextMenu={onContextMenu} className={`branch-row ${branch.isCurrent ? "current" : ""} ${selected ? "selected" : ""} ${merged ? "merged" : ""} ${branch.stackedOn ? "stacked" : ""} ${branch.presence}`}><button ref={register} className="branch-main" style={{ paddingLeft: 8 + depth * 13 }} onClick={onSelect} onDoubleClick={onSwitchNow} aria-current={branch.isCurrent} aria-pressed={selected} title={`${branchTooltip(branch, defaultBranch, t)}\n${t("branchClickHint")}`}><span className="branch-color" style={{ background: colour }} />{branch.stackedOn ? <GitFork size={14} className="branch-stack-icon" /> : <GitBranch size={14} />}<span className="branch-label">{label}</span>{variant && <span className="branch-variant" title={t("variantPrefix", { name: branch.name })}>{t("variant")}</span>}{merged && <span className="branch-merged" role="img" aria-label={t("mergedBadge", { branch: defaultBranch ?? "" })} title={t("mergedTitle", { branch: defaultBranch ?? "" })}><GitMerge size={12} /></span>}{branch.checkedOutIn && <span className="branch-worktree" role="img" aria-label={t("worktreeBadge", { path: branch.checkedOutIn })} title={t("worktreeBadge", { path: branch.checkedOutIn })}><FolderGit2 size={12} /></span>}{protectedByPrefix && <span className="branch-protected" role="img" aria-label={t("protectedBadge")} title={t("protectedTitle")}><ShieldCheck size={12} /></span>}{stale > 0 && <span className="branch-stale" role="img" aria-label={t("staleBadge", { days: stale })} title={t("staleTitle", { days: stale })}><Clock3 size={12} /></span>}<PresenceBadge branch={branch} />{branch.isCurrent && <span className="current-pill">{t("current")}</span>}{isDefault && <span className="current-pill">{t("primary")}</span>}{(branch.ahead > 0 || branch.behind > 0) && <span className="ahead-behind">{branch.ahead > 0 ? `↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}</button>{!branch.isCurrent && <button className="branch-switch" onClick={onSwitch} disabled={busy} aria-label={t("switchBranch", { name: branch.name })} title={t("switchBranchTitle", { name: branch.name })}><ArrowLeftRight size={12} /></button>}{!branch.isCurrent && !isDefault && !protectedByPrefix && branch.presence !== "remote" && <button className="branch-delete" onClick={onDelete} disabled={busy} aria-label={t("deleteBranch", { name: branch.name })} title={branch.mergedInto.length ? t("deleteMergedBranch", { name: branch.name, branches: branch.mergedInto.join(t("and")) }) : t("deleteUnmergedBranch", { name: branch.name })}><Trash2 size={12} /></button>}</div>;
}

/** Repository-wide activity remains pending until the user explicitly reviews it. */
function RepositoryOverview({ snapshot, filter, onSelect, onChanges }: {
  snapshot: RepoSnapshot; filter: string; onSelect: (commit: Commit) => void; onChanges: () => void;
}) {
  const { t } = useI18n();
  const storageKey = `gitcat-activity:${snapshot.path}`;
  const [baseline, setBaseline] = useState(() => {
    try { return parseActivityBaseline(localStorage.getItem(storageKey)) ?? activityBaseline(snapshot); }
    catch { return activityBaseline(snapshot); }
  });
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(baseline)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [storageKey, baseline]);
  const changed = changedBranches(baseline, activityBaseline(snapshot));
  const highlighted = new Set(snapshot.branches.filter((branch) => changed.includes(branch.name))
    .flatMap((branch) => branch.lastCommit ? [branch.lastCommit.shortHash] : []));
  const current = snapshot.branches.find((branch) => branch.isCurrent);
  return <>
    <div className={`activity-overview ${changed.length ? "has-updates" : ""}`}>
      <div className="overview-heading"><div>
        <h3>{changed.length ? t("branchesUpdated", { count: changed.length }) : t("recentHistory")}</h3>
      </div>{changed.length > 0 && <button className="outline-button small" onClick={() => setBaseline(activityBaseline(snapshot))}><Check size={13} />{t("markReviewed")}</button>}</div>
      {changed.length > 0 && <p>{t("sinceReview")}</p>}
      {changed.length > 0 && <div className="updated-branches">{changed.map((name) => <span key={name} title={name}>{name}{!snapshot.branches.some((branch) => branch.name === name) ? ` · ${t("removedBranch")}` : ""}</span>)}</div>}
      <details className="overview-details"><summary>{t("repositoryStatus")}</summary><p>{t("overviewIntro")}</p><div className="overview-stats"><button onClick={onChanges} className={snapshot.changes.length ? "needs-attention" : ""}><FileDiff size={14} /><strong>{snapshot.changes.length}</strong>{t("uncommittedFiles")}</button>
        <span><ArrowDownToLine size={14} /><strong>{current?.upstream ? current.behind : "—"}</strong>{t("incomingCurrent")}</span>
        <span><ArrowUpFromLine size={14} /><strong>{current?.upstream ? current.ahead : "—"}</strong>{t("outgoingCurrent")}</span></div>
      <small>{t(current?.upstream ? "knownRemoteState" : "noRemoteComparison")}</small></details>
      {storageError && <p role="alert">{t("activityStorageError")}</p>}
    </div>
    <HistoryView snapshot={snapshot} selection={snapshot.currentBranch} filter={filter} onSelect={onSelect} overview highlighted={highlighted} />
  </>;
}

function HistoryView({ snapshot, selection, filter, onSelect, overview = false, highlighted }: {
  snapshot: RepoSnapshot; selection: string; filter: string; onSelect: (commit: Commit) => void; overview?: boolean; highlighted?: Set<string>;
}) {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(() => readHistoryPrefs(snapshot.path));
  const [page, setPage] = useState<{ commits: Commit[]; hasMore: boolean; comparedTo?: string }>({ commits: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Every load is numbered, so a slow answer for a scope the user already left cannot overwrite the
  // one they are looking at.
  const request = useRef(0);

  const { byFamily } = prefs;
  const scope = overview ? "all" : prefs.scope;
  const branch = scope === "all" ? undefined : selection;

  const fetchPage = (skip: number) => {
    const id = ++request.current;
    setLoading(true);
    window.gitcat.loadHistory(snapshot.path, { scope, branch, skip }).then((next) => {
      if (request.current !== id) return;
      setPage((current) => ({
        commits: skip === 0 ? next.commits : [...current.commits, ...next.commits],
        hasMore: next.hasMore,
        comparedTo: next.comparedTo
      }));
      setError(undefined);
    }).catch((reason) => {
      if (request.current !== id) return;
      setError(cleanError(reason, t("fallbackReadHistory")));
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
    all: t("allBranches"),
    branch: t("branchScope", { branch: selection }),
    "branch-only": t("branchOnlyScope", { branch: selection })
  };

  return <div className={`graph-scroll ${overview ? "overview-graph" : ""}`} style={{ "--track-w": `${trackWidth}px` } as CSSProperties}>
    <div className="graph-header">
      <div className="graph-scope">
        {overview ? <span className="overview-order">{t("historyDirection")}</span> : <label className="scope-field"><GitBranch size={12} /><span className="visually-hidden">{t("historyScope")}</span><select aria-label={t("historyScope")} value={scope} onChange={(event) => update({ scope: event.target.value as HistoryScope })}>
          {(Object.keys(scopeLabels) as HistoryScope[]).map((value) => <option value={value} key={value}>{scopeLabels[value]}</option>)}
        </select></label>}
        {scope === "branch-only" && <span className="scope-note">{page.comparedTo
          ? t("comparedTo", { branch: page.comparedTo })
          : t("noDefaultComparison")}</span>}
      </div>
      <div className="graph-header-right">
        <button className="graph-colour-toggle" aria-pressed={byFamily} onClick={() => update({ byFamily: !byFamily })} title={byFamily
          ? t("familyColourTitle")
          : t("positionColourTitle")}><Palette size={12} /> {byFamily ? t("byFamily") : t("byPosition")}</button>
        <span className="graph-count">{needle
          ? t("loadedCommits", { shown: visible.length, total: page.commits.length })
          : page.hasMore ? t("commitsMore", { count: page.commits.length }) : t("noMoreCommits", { count: page.commits.length })}</span>
      </div>
    </div>
    {overview && <><details className="overview-legend"><summary><Info size={12} />{t("readGraph")}</summary><p>{t("prReferenceNote")}</p></details><div className="overview-columns"><span>{t("branchesAndTags")}</span><span>{t("graphLabel")}</span><span>{t("changesAndPRs")}</span></div></>}
    {needle && <div className="graph-note">{t("filteredHistoryNote", { count: page.commits.length })}</div>}
    {error && <div className="graph-note error" role="alert">{error}</div>}
    {visible.length ? visible.map((commit, index) => <CommitRow
      key={commit.hash}
      commit={commit}
      overview={overview}
      updated={highlighted?.has(commit.shortHash)}
      row={rows.get(commit.hash)}
      lanes={lanes}
      trackWidth={trackWidth}
      remotes={snapshot.remotes}
      colour={byFamily ? familyColour(rows.get(commit.hash)?.family ?? "") : branchColor(index)}
      byFamily={byFamily}
      onSelect={() => onSelect(commit)}
    />) : !loading && <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>{t("noCommits")}</strong><span>{needle ? t("filterNoCommits") : scope === "branch-only" ? t("branchNoUniqueCommits", { branch: selection, base: page.comparedTo ?? t("primary") }) : t("branchNoHistory")}</span></div>}
    {loading && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> {t("readHistory")}</div>}
    {!loading && page.hasMore && !needle && <button className="load-more" onClick={() => fetchPage(page.commits.length)}>{t("loadMoreCommits")}</button>}
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

function CommitRow({ commit, row, lanes, trackWidth, remotes, colour, byFamily, onSelect, overview = false, updated = false }: { overview?: boolean; updated?: boolean; commit: Commit; row?: GraphRow; lanes: number; trackWidth: number; remotes: string[]; colour: string; byFamily: boolean; onSelect: () => void }) {
  const { t, locale } = useI18n();
  const lane = row && lanes ? Math.min(row.lane, lanes - 1) : 0;
  const chips = refChips(commit.refs, remotes);
  const shown = chips.slice(0, 2);
  const rest = chips.slice(2);
  const pr = pullRequestReference(commit.subject);
  const refs = <div className="commit-refs">
      {(overview ? chips : shown).map((chip) => <span className={`ref-tag ${chip.kind}`} key={chip.label} title={chip.kind === "remote" ? `${chip.label} · ${t("remoteOnlyTitle")}` : chip.label}>
        {chip.kind === "tag" ? <Tag size={11} /> : chip.kind === "remote" ? <Cloud size={11} /> : <GitBranch size={11} />}{chip.label}
      </span>)}
      {!overview && rest.length > 0 && <span className="ref-tag more" title={rest.map((chip) => chip.label).join("\n")}>+{rest.length}</span>}
    </div>;
  return <div className={`commit-row ${updated ? "updated-commit" : ""}`}>
    {overview && refs}<div className="graph-track" style={{ width: trackWidth }}>
    {row && lanes > 0 ? <GraphLanes row={row} lanes={lanes} colour={colour} byFamily={byFamily} /> : <span className="track-line" />}
    <span className="commit-node" style={{ left: laneX(lane) - 5.5, borderColor: colour, boxShadow: `0 0 0 4px ${colour}18` }} />
  </div><button className="commit-content" onClick={onSelect} aria-label={t("inspectCommit", { hash: commit.shortHash, subject: commit.subject })}>
    <div className="commit-main">
      <div className="commit-subject" title={commit.subject}>{updated && <span className="activity-badge">{t("updatedLabel")}</span>}{overview && pr && <span className="pr-badge">PR #{pr}</span>}{overview && commit.parents.length > 1 && <GitMerge size={13} className="merge-marker" />}{commit.subject || t("commitWithoutMessage")}</div>
      <div className="commit-meta">
        <span className="hash-chip">{commit.shortHash}</span>
        <span className="commit-author">{commit.author}</span>
        <span className="meta-divider">·</span>
        {/* Relative is what gets scanned; the exact date, with its year, is one hover away. */}
        <span title={formatDateFull(commit.date, locale)}>{relativeTime(commit.date, locale)}</span>
      </div>
    </div>
    {!overview && refs}
    <Info size={15} className="commit-more" />
  </button></div>;
}

function changeStatus(code: string, t: Translate) {
  if (code.includes("?")) return t("untracked");
  if (code.includes("R")) return t("renamed");
  if (code.includes("C")) return t("copied");
  if (code.includes("A")) return t("added");
  if (code.includes("D")) return t("deleted");
  if (code.includes("U")) return t("conflict");
  return t("modified");
}

function BranchWorkCard({ snapshot, busy, onSave, onIntegrate }: {
  snapshot: RepoSnapshot; busy: boolean; onSave: () => void; onIntegrate: () => void;
}) {
  const { t } = useI18n();
  const source = snapshot.branches.find((branch) => branch.isCurrent);
  const target = snapshot.defaultBranch;
  const canIntegrate = Boolean(source && target && target !== snapshot.currentBranch);
  const integrated = Boolean(target && source?.mergedInto.includes(target) && !snapshot.isDirty);
  const blocked = Boolean(snapshot.pending || snapshot.conflicts.length || (!source && snapshot.head) || snapshot.currentBranch === "HEAD");
  const newFiles = snapshot.changes.filter((file) => file.code.includes("?")).length;
  return <div className={`branch-work-card ${snapshot.isDirty ? "is-dirty" : "is-saved"}`}>
    <div className="work-symbol"><GitBranch size={22} /></div>
    <div className="branch-work-copy">
    <div className="branch-work-heading"><GitBranch size={16} /><strong title={snapshot.currentBranch}>{snapshot.currentBranch}</strong>
      <span>{snapshot.isDirty ? t("workNeedsSaving", { count: snapshot.changes.length }) : t("workSaved")}</span></div>
    <p>{blocked ? t("finishPendingFirst") : snapshot.isDirty ? t("workSaveGuidance", { count: newFiles }) : integrated ? t("workIntegrated", { target: target! }) : canIntegrate ? t("workReadyToIntegrate", { target: target! }) : t(target ? "workOnMain" : "workNoMain")}</p>
    </div><div className="branch-work-actions">
      {snapshot.isDirty && <button className={canIntegrate ? "outline-button" : "primary-button"} disabled={busy || blocked} onClick={onSave}><GitCommitHorizontal size={14} />{t("saveChanges")}</button>}
      {canIntegrate && <button className="primary-button" disabled={busy || blocked || integrated} onClick={onIntegrate}><GitMerge size={14} />{t(snapshot.isDirty ? "saveAndIntegrate" : "integrateInto", { target: target! })}</button>}
    </div>
  </div>;
}

function ChangesView({ snapshot, formOpen, message, generating, busy, onOpenForm, onOpenFile, onMessageChange, onGenerate, onPrepare, merge, configured, stale, onReviewAgain, onMergeChange }: {
  snapshot: RepoSnapshot; formOpen: boolean; message: string; generating: boolean; busy: boolean;
  onOpenForm: () => void; onOpenFile: (file: FileChange) => void; onMessageChange: (message: string) => void; onGenerate: () => void; onPrepare: () => void;
  merge: boolean; configured: boolean; stale: boolean; onReviewAgain: () => void; onMergeChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const hasChanges = snapshot.changes.length > 0;
  const canMerge = snapshot.defaultBranch && snapshot.defaultBranch !== snapshot.currentBranch;
  return <div className="changes-view">
    <div className="changes-heading"><div><span className="eyebrow">{t("worktree", { branch: snapshot.currentBranch })}</span><h3>{hasChanges ? t("reviewFiles", { count: snapshot.changes.length }) : t("everythingClean")}</h3></div></div>
    {hasChanges ? <>
      <p className="file-inclusion-note">{t("allFilesIncluded")}</p>
      {formOpen ? <div className="commit-form">
        <div className="commit-form-heading"><h3>{t("saveDescription")}</h3><button className="outline-button small" onClick={onGenerate} disabled={!configured || generating || busy}>{generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{t(generating ? "generatingSaveDescription" : "generateDescription")}</button></div>
        <label htmlFor="commit-description">{t("commitMessage")}</label><textarea id="commit-description" value={message} onChange={(event) => onMessageChange(event.target.value)} maxLength={120} rows={2} placeholder={t("commitPlaceholder")} disabled={generating || busy} />
        <div className="commit-form-meta"><span>{t(configured ? "editableDescription" : "manualSaveDescription")}</span><span>{message.length}/120</span></div>
        {canMerge && <label className="delivery-option"><input type="checkbox" checked={merge} disabled={busy} onChange={(event) => onMergeChange(event.target.checked)} /><span>{t("integrateAfterSave", { target: snapshot.defaultBranch! })}</span></label>}
        {stale && <div className="delivery-stale" role="alert">{t("filesChangedReview")} <button className="outline-button small" onClick={onReviewAgain}>{t("reviewUpdatedFiles")}</button></div>}
        <div className="commit-form-actions"><button className="primary-button" onClick={onPrepare} disabled={stale || !message.trim() || generating || busy}><ShieldCheck size={14} />{t(merge && canMerge ? "reviewSaveAndMerge" : "reviewSave")}</button></div>
      </div> : <button className="outline-button" onClick={onOpenForm} disabled={busy}>{t("saveChanges")}</button>}
      <div className="change-list">{snapshot.changes.map((change, index) => <button className="change-row" key={`${change.path}-${index}`} onClick={() => onOpenFile(change)} title={t("showFile", { path: change.path })}>
        <span className={`change-code code-${change.code[0]?.toLowerCase()}`}>{change.code.includes("?") ? "+" : change.code}</span>
        <span className="change-status">{change.code.includes("?") ? t("newFileIncluded") : changeStatus(change.code, t)}</span><span className="change-path" title={change.path}>{change.path}</span><Info size={13} className="change-more" />
      </button>)}</div>
    </> : <div className="graph-empty"><Check size={26} /><strong>{t("noUncommittedChanges")}</strong><span>{t("savedNextStep")}</span></div>}
  </div>;
}

function DeliveryReviewModal({ review, busy, onClose, onApply }: {
  review: { turnId: number; plan: ActionPlan }; busy: boolean; onClose: () => void; onApply: () => Promise<void>;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.focus();
    return () => previous?.focus();
  }, []);
  useEscape(onClose);
  return <div className="modal-backdrop"><section className="modal delivery-review-modal" ref={container} tabIndex={-1} onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} role="dialog" aria-modal="true" aria-label={t("reviewDeliveryTitle")}>
    <div className="modal-heading"><h2>{t("reviewDeliveryTitle")}</h2><button className="icon-button" onClick={onClose} aria-label={t("cancel")}><X size={18} /></button></div>
    <PlanCard plan={review.plan} busy={busy} onApply={onApply} onDismiss={onClose} />
  </section></div>;
}

function ConversationEntry({ turn, busy, onApply, onDismiss }: { turn: ConversationTurn; busy: boolean; onApply: (plan: ActionPlan) => void; onDismiss: () => void }) {
  const { t } = useI18n();
  // A sequence reports itself step by step, marks included, so it needs no outer verdict icon or colour.
  const sequence = (turn.plan?.steps.length ?? 0) > 1;
  return <article className="conversation-turn"><div className="conversation-question"><span>{t("you")}</span><p>{turn.question}</p></div><div className={`conversation-response ${turn.status === "error" ? "error" : ""}`}><span className="conversation-avatar"><CatMark size={17} outline /></span><div>{turn.status === "loading" && <div className="conversation-loading"><LoaderCircle className="spin" size={14} /> {t("preparingResponse")}</div>}{turn.answer && <p>{turn.answer}</p>}{turn.plan && (turn.status === "ready" || turn.status === "executing") && <PlanCard plan={turn.plan} onApply={async () => onApply(turn.plan!)} onDismiss={onDismiss} busy={busy || turn.status === "executing"} />}{turn.plan && !turn.plan.allowed && turn.status === "completed" && <PlanCard plan={turn.plan} onApply={async () => undefined} onDismiss={onDismiss} busy={false} />}{turn.outcome && (sequence ? <div className="conversation-report"><span>{turn.outcome}</span></div> : <div className="conversation-outcome"><Check size={13} /><span>{turn.outcome}</span></div>)}{turn.error && <div className="conversation-error"><AlertTriangle size={13} /><span>{turn.error}</span></div>}</div></div></article>;
}


function PlanCard({ plan, onApply, onDismiss, busy }: { plan: ActionPlan; onApply: () => Promise<void>; onDismiss: () => void; busy: boolean }) {
  const { t } = useI18n();
  const asking = plan.kind === "question";
  return <div className={`plan-card ${plan.allowed ? "allowed" : asking ? "asking" : "rejected"}`}><div className="plan-header"><div className="plan-icon">{plan.allowed ? <Sparkles size={15} /> : asking ? <MessageCircle size={15} /> : <AlertTriangle size={15} />}</div><div><strong>{plan.summary}</strong><span>{plan.source === "llm" ? t("interpretedByProvider") : t("directAction")}</span></div><button className="mini-icon" onClick={onDismiss} aria-label={asking ? t("dismissQuestion") : t("dismissPlan")}><X size={14} /></button></div><p>{plan.rationale}</p>{plan.effects && <ul className="plan-effects">{plan.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}{plan.repositoryPlan && <pre className="repository-plan-json">{JSON.stringify(plan.repositoryPlan, null, 2)}</pre>}{plan.allowed && (plan.steps.length > 1
      ? <ol className="plan-steps">{plan.steps.map((step, index) => <li key={`${step.command}-${index}`}><span className="step-summary">{step.summary}</span><code><TerminalSquare size={11} />{step.command}</code></li>)}</ol>
      : <div className="command-preview"><TerminalSquare size={14} /><code>{plan.command}</code></div>)}
    {plan.allowed && plan.requiresConfirmation && plan.steps.length > 1 && <p className="plan-hint">{t("planStepsHint", { count: plan.steps.length })}</p>}
    {/* A plan with nothing to confirm is already running, so it offers no button that could decide otherwise. */}
    {plan.allowed && !plan.requiresConfirmation
      ? <p className="plan-running"><LoaderCircle className="spin" size={12} /> {t("runningWithoutConfirmation")}</p>
      : plan.allowed ? <div className="plan-actions"><button className="ghost-button" onClick={onDismiss}>{t("cancel")}</button><button className="primary-button" onClick={() => void onApply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {t("confirmAction")}</button></div>
      : asking ? <p className="plan-hint">{t("answerBelow")}</p>
      : <button className="ghost-button plan-close" onClick={onDismiss}>{t("understood")}</button>}</div>;
}

function SettingsModal({ config, locale, onLocaleChange, onClose, onSaved }: { config: LlmConfig; locale: Locale; onLocaleChange: (locale: Locale) => void; onClose: () => void; onSaved: (config: LlmConfig) => void }) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config.model || "gpt-5.6-luna");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEscape(onClose);
  const save = async () => {
    if (!model.trim()) { setError(t("indicateModel")); return; }
    setSaving(true); setError(undefined);
    try { onSaved(await window.gitcat.saveLlmConfig({ apiKey, model, clearApiKey })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("fallbackSaveConfig")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><div className="eyebrow">{t("llmProvider")}</div><h2 id="settings-title">{t("settings")}</h2></div><button className="icon-button soft" onClick={onClose} aria-label={t("closeSettings")}><X size={17} /></button></div><div className="provider-card"><div className="provider-logo">AI</div><div><strong>OpenAI</strong><span>{t("apiKeyLocal")}</span></div><span className={`connected-dot ${config.configured ? "on" : ""}`} /></div><label>{t("language")}<select value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}><option value="en">{t("english")}</option><option value="es">{t("spanish")}</option></select><small>{t("languageHelp")}</small></label><label>{t("apiKey")}<input autoFocus type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={config.configured ? t("savedApiKeyPlaceholder") : "sk-…"} autoComplete="off" /></label>{config.configured && <label className="checkbox-label"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /> {t("removeSavedApiKey")}</label>}<label>{t("model")}<input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t("modelPlaceholder")} /><small>{t("modelHelp")}</small></label><div className="modal-note"><ShieldCheck size={15} /><span>{t("settingsNote")}</span></div>{error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>{t("cancel")}</button><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("save")}</button></div></div></div>;
}

/**
 * Naming a branch, with what the repository already writes offered as completions. When the name
 * starts with a prefix this repo spells differently, it says so and stops there: creation is never
 * blocked, because the convention is the user's to set, not the app's to enforce.
 */
function InputModal({ dialog, branches, onChange, onClose, onSubmit }: { dialog: InputDialog; branches: Branch[]; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  const { t } = useI18n();
  useEscape(onClose);
  const creating = dialog.operation === "create_branch";
  const options = useMemo(
    () => creating ? namingCompletions(branches) : branches.filter((branch) => !branch.isCurrent).map((branch) => branch.name),
    [creating, branches]
  );
  const hint = useMemo(() => creating ? variantHint(dialog.value, branches) : undefined, [creating, dialog.value, branches]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="input-modal" role="dialog" aria-modal="true" aria-labelledby="input-modal-title" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><div className="modal-heading"><div><div className="eyebrow">{t("gitOperation")}</div><h2 id="input-modal-title">{dialog.title}</h2></div><button type="button" className="icon-button soft" onClick={onClose} aria-label={t("close")}><X size={17} /></button></div><label>{dialog.label}<input autoFocus value={dialog.value} onChange={(event) => onChange(event.target.value)} list={options.length ? "branch-options" : undefined} maxLength={200} /></label>{options.length > 0 && <datalist id="branch-options">{options.map((option) => <option value={option} key={option} />)}</datalist>}{hint && <p className="naming-hint" role="status"><Lightbulb size={12} /><span>{t("repositoryUses", { prefix: hint.canonical, count: counted(t, hint.count, "branch", "branches"), suggestion: `${hint.canonical}/…` })} <button type="button" onClick={() => onChange(`${hint.canonical}/${dialog.value.trim().slice(hint.typed.length + 1)}`)}><code>{hint.canonical}/…</code></button></span></p>}<div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>{t("cancel")}</button><button className="primary-button" disabled={!dialog.value.trim()}><GitBranch size={14} /> {t("prepare")}</button></div></form></div>;
}

function pendingLabel(kind: PendingOperationKind, t: Translate) {
  return t(kind === "rebase" ? "pendingRebase" : kind === "merge" ? "pendingMerge" : kind === "cherry_pick" ? "pendingCherryPick" : "pendingRevert");
}

/**
 * The repository is holding a half-finished job. This says which one, how far it got and what is in
 * the way, because "a rebase is happening" is not enough to decide anything — and every way out is
 * spelled out in terms of what it costs, since aborting and skipping both throw work away.
 */
function PendingBanner({ snapshot, busy, onContinue, onSkip, onAbort, onResolve }: {
  snapshot: RepoSnapshot; busy: boolean;
  onContinue: () => void; onSkip: () => void; onAbort: () => void; onResolve: () => void;
}) {
  const { t } = useI18n();
  const pending = snapshot.pending!;
  const progress = pending.step && pending.total ? t("pendingProgress", { step: pending.step, total: pending.total }) : "";
  const target = pending.branch && pending.onto ? t("pendingTargetBoth", { branch: pending.branch, onto: pending.onto }) : pending.onto ? t("pendingTarget", { onto: pending.onto }) : "";
  const blocked = snapshot.conflicts.length;
  return <div className="rebase-banner">
    <AlertTriangle size={16} />
    <div>
      <strong>{pendingLabel(pending.kind, t)}{progress}</strong>
      <span>{blocked
        ? `${counted(t, blocked, "conflictFile", "conflictFiles")}${target}. ${t("conflictsBlock")}`
        : t("noOpenConflicts", { target })}</span>
    </div>
    {blocked > 0 && <button className="outline-button small" onClick={onResolve} disabled={busy} title={t("proposeResolutionTitle")}><Sparkles size={13} /> {t("proposeResolution")}</button>}
    <button className="outline-button small" onClick={onContinue} disabled={busy || blocked > 0} title={blocked ? t("conflictsRemain") : t("continueTitle")}>{t("continue")}</button>
    {canSkipPending(pending.kind) && <button className="danger-link" onClick={onSkip} disabled={busy} title={t("skipTitle")}>{t("skipCommit")}</button>}
    <button className="danger-link" onClick={onAbort} disabled={busy} title={t("abortTitle")}>{t("abort")}</button>
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
  const { t } = useI18n();
  const [accepted, setAccepted] = useState<string[]>(() => proposal.resolutions.filter((item) => item.confidence === "high").map((item) => item.path));
  useEscape(onClose);
  const toggle = (path: string) => setAccepted((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const chosen = proposal.resolutions.filter((resolution) => accepted.includes(resolution.path));

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="proposal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">{t("proposedResolution")}</div><h2 id="proposal-title">{t("reviewBeforeAccepting")}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label={t("dismissProposal")}><X size={17} /></button>
      </div>
      <div className="modal-note"><ShieldCheck size={15} /><span>{t("nothingWritten")}</span></div>
      {proposal.resolutions.map((resolution) => <div className={`resolution ${accepted.includes(resolution.path) ? "accepted" : ""}`} key={resolution.path}>
        <label className="resolution-heading">
          <input type="checkbox" checked={accepted.includes(resolution.path)} onChange={() => toggle(resolution.path)} />
          <div>
            <strong>{resolution.path}</strong>
            <span>{resolution.rationale}</span>
          </div>
          {resolution.confidence === "low" && <span className="resolution-doubt" title={t("reviewCarefully")}>{t("reviewCarefully")}</span>}
        </label>
        <DiffView diff={lineDiff(proposal.current[resolution.path] ?? "", resolution.content)} truncated={false} />
      </div>)}
      {proposal.skipped.length > 0 && <div className="resolution-skipped">
        <span className="eyebrow">{t("unresolved")}</span>
        {proposal.skipped.map((entry) => <div key={entry.path}><strong>{entry.path}</strong><span>{entry.reason}</span></div>)}
      </div>}
      <div className="modal-actions">
        <button className="ghost-button" onClick={onClose}>{t("discardAll")}</button>
        <button className="primary-button" onClick={() => onApply(chosen)} disabled={busy || !chosen.length}>
          <Check size={14} /> {t("acceptFiles", { count: counted(t, chosen.length, "file", "files") })}
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
  const { t } = useI18n();
  const lines = useMemo(() => diff.split("\n"), [diff]);
  if (!diff.trim()) return <div className="diff-empty">{t("binaryDiff")}</div>;
  return <div className="diff-view"><pre>{lines.map((line, index) => {
    const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
      ? "meta"
      : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
    return <span className={`diff-line ${kind}`} key={index}>{line || " "}</span>;
  })}</pre>{truncated && <div className="diff-note">{t("diffTruncated")}</div>}</div>;
}

function PendingDiffView({ detail }: { detail: CommitDetail }) {
  const { t } = useI18n();
  return <div className="diff-pending" aria-busy="true">
    <DiffView diff={detail.diff} truncated={detail.truncated} />
    <div className="diff-pending-overlay" role="status"><LoaderCircle className="spin" size={15} /> {t("readingFile")}</div>
  </div>;
}

/**
 * What a commit actually changed. Until now this dialog listed a hash, an author and a date — every
 * fact about the commit except the only one anyone opens it for.
 */
function CommitModal({ commit, repoPath, onClose }: { commit: Commit; repoPath: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<FileChange>();
  const [fileDetail, setFileDetail] = useState<{ path: string; detail: CommitDetail }>();
  const [fileError, setFileError] = useState<{ path: string; message: string }>();
  useEscape(onClose);
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    setSelectedFile(undefined);
    setFileDetail(undefined);
    setFileError(undefined);
    window.gitcat.getCommitDetail(repoPath, commit.hash)
      .then((next) => { if (live) setDetail(next); })
      .catch((reason) => { if (live) setError(cleanError(reason, t("fallbackReadCommit"))); });
    return () => { live = false; };
  }, [repoPath, commit.hash]);
  useEffect(() => {
    if (!selectedFile) return;
    let live = true;
    window.gitcat.getCommitFileDiff(repoPath, commit.hash, selectedFile.path)
      .then((next) => { if (live) setFileDetail({ path: selectedFile.path, detail: next }); })
      .catch((reason) => { if (live) setFileError({ path: selectedFile.path, message: cleanError(reason, t("fallbackReadFile")) }); });
    return () => { live = false; };
  }, [repoPath, commit.hash, selectedFile?.path]);

  const selectedDetail = selectedFile && fileDetail?.path === selectedFile.path ? fileDetail.detail : undefined;
  const selectedError = selectedFile && fileError?.path === selectedFile.path ? fileError.message : undefined;

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="commit-modal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">COMMIT {commit.shortHash}</div><h2 id="commit-modal-title">{commit.subject || t("commitWithoutMessage")}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label={t("commitDetails")}><X size={17} /></button>
      </div>
      <dl>
        <div><dt>{t("author")}</dt><dd>{commit.author}<span>{commit.email}</span></dd></div>
        <div><dt>{t("date")}</dt><dd>{formatDateFull(commit.date, locale)}<span>{relativeTime(commit.date, locale)}</span></dd></div>
        <div><dt>{t("hash")}</dt><dd><code>{commit.hash}</code></dd></div>
        {commit.parents.length > 1 && <div><dt>{t("mergeDetailsLabel")}</dt><dd>{t("mergeDetails", { hash: commit.parents[0].slice(0, 7) })}</dd></div>}
      </dl>
      {error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      {!detail && !error && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> {t("readingChange")}</div>}
      {detail && <>
        <div className="detail-files"><span className="eyebrow">{counted(t, detail.files.length, "file", "files").toUpperCase()}</span>
          {detail.files.map((file) => <button className={`change-row ${selectedFile?.path === file.path ? "selected" : ""}`} key={file.path} onClick={() => setSelectedFile(file)} aria-pressed={selectedFile?.path === file.path} title={t("showFile", { path: file.path })}>
            <span className={`change-code code-${file.code[0]?.toLowerCase()}`}>{file.code}</span>
            <span className="change-status">{changeStatus(file.code, t)}</span>
            <span className="change-path" title={file.path}>{file.path}</span>
            <Info size={13} className="change-more" />
          </button>)}
        </div>
        {selectedFile && <div className="diff-toolbar"><span>{t("showingOnly")} <code>{selectedFile.path}</code></span><button className="ghost-button small" onClick={() => setSelectedFile(undefined)}>{t("showAllFiles")}</button></div>}
        {selectedError && <div className="modal-error" role="alert"><AlertTriangle size={14} />{selectedError}</div>}
        {selectedFile ? selectedDetail ? <DiffView diff={selectedDetail.diff} truncated={selectedDetail.truncated} /> : selectedError ? <DiffView diff={detail.diff} truncated={detail.truncated} /> : <PendingDiffView detail={detail} /> : <DiffView diff={detail.diff} truncated={detail.truncated} />}
      </>}
    </div>
  </div>;
}

/** The same reading for a file that has not been committed yet. */
function FileDiffModal({ file, repoPath, onClose }: { file: FileChange; repoPath: string; onClose: () => void }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  useEscape(onClose);
  useEffect(() => {
    let live = true;
    window.gitcat.getWorkingFileDiff(repoPath, file.path)
      .then((next) => { if (live) setDetail(next); })
      .catch((reason) => { if (live) setError(cleanError(reason, t("fallbackReadFile"))); });
    return () => { live = false; };
  }, [repoPath, file.path]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="file-modal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">{t("uncommittedChange", { status: changeStatus(file.code, t) })}</div><h2 id="file-modal-title">{file.path}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label={t("closeDiffs")}><X size={17} /></button>
      </div>
      {error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      {!detail && !error && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> {t("readingFile")}</div>}
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
