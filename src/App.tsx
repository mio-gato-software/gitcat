import { CatMark, SleepingCat } from "./CatMark";
import { NotificationCenter } from "./NotificationCenter";
import { addNotification, type Notification } from "../shared/notifications";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowDownWideNarrow, ArrowUpFromLine, Bot, Check, ChevronRight, CircleDot,
  Clock3, Cloud, CloudDownload, Copy, Eye, EyeOff, FileDiff, FileMinus, FilePen, FilePlus, FileSymlink, Folder, FolderGit2,
  FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitFork, ArrowLeftRight, GitMerge, Info, Laptop, Lightbulb, List,
  ListTree, LoaderCircle, Maximize2, MessageCircle, MessageSquareText, PanelLeftClose, PanelLeftOpen, Palette, Pencil, PencilLine, Plus,
  RefreshCcw, Search, Send, Settings2, ShieldCheck, Undo2,
  Sparkles, Tag, TerminalSquare, Trash2, UserRound, X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { buildBranchTree, filterBranchTree, groupPathFor, prefixOf } from "../shared/branch-tree";
import type { BranchNode } from "../shared/branch-tree";
import { branchSuggestions, namingCompletions, prefixAliases, variantHint } from "../shared/branch-consistency";
import type { BranchSuggestion } from "../shared/branch-consistency";
import { isProtectedBranch, lifecycleOf, staleDays } from "../shared/branch-lifecycle";
import { buildCommitGraph, familyColour, maxLanes, withWorkInProgress, workInProgressHash } from "../shared/commit-graph";
import { pullRequestReference } from "../shared/repository-activity";
import { refChips } from "../shared/ref-chips";
import type { RefChip } from "../shared/ref-chips";
import { authorAvatarUrl, avatarKey } from "../shared/avatar";
import { clampGraphColumn, graphColumnRange, parseGraphColumns } from "../shared/graph-columns";
import type { GraphColumn, GraphColumnWidths } from "../shared/graph-columns";
import { autoRefreshIntervalMs, backgroundFetchDue, refreshedProject } from "../shared/auto-refresh";
import type { GraphRow } from "../shared/commit-graph";
import { branchOrderLabels, defaultBranchOrder, isBranchOrder, isMergedIntoDefault, sortBranches } from "../shared/branch-order";
import type { BranchOrder } from "../shared/branch-order";
import type {
  ActionPlan, Branch, Commit, CommitDetail, ConflictApplyResult, ConflictProposal, ConversationMessage, ExecutionFailure,
  FileChange, FileStats, HistoryScope, LlmConfig, Locale, Operation, PendingOperationKind, ProjectLocateResult, ProjectUnavailableReason,
  RepoSnapshot, UnavailableProject
} from "../shared/types";
import { localeTag, readLocale, translate, writeLocale, type MessageKey, type Translate } from "./i18n";

type ProjectTab = { id: string; snapshot: RepoSnapshot; loadedAt: string; fetchedAt?: string };
/** One tab in the saved order: a project that opened, or a saved one that could not be opened this time. Its id is its saved path. */
type WorkspaceTab = { id: string; path: string; name: string; unavailable?: UnavailableProject };
/** What the panel of an unavailable project is showing besides its reason: a folder that did not fit, or one waiting for an answer. */
type LocateNotice =
  | { kind: "invalid"; result: Extract<ProjectLocateResult, { status: "invalid" }> }
  | { kind: "confirm"; result: Extract<ProjectLocateResult, { status: "confirm" }> };
type GraphFocus = { kind: "wip" } | { kind: "commit"; commit: Commit };
type InspectorTab = "details" | "assistant";
/** What was right-clicked: a commit, the branch label on it, both, or the uncommitted work. */
type MenuTarget = { x: number; y: number; commit?: Commit; branch?: string; work?: boolean };
type MenuEntry =
  | { key: string; icon: LucideIcon; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string }
  | { key: string; heading: string }
  | { key: string; separator: true };

const sidebarStorageKey = "gitcat-branch-panel";
function readSidebarHidden() {
  try { return localStorage.getItem(sidebarStorageKey) === "hidden"; } catch { return false; }
}
type ActivityItem = Notification;

/** `from` is the commit a new branch starts at, or the branch a rename starts from. */
type InputDialog = { operation: "create_branch" | "merge" | "rename_branch"; title: string; label: string; value: string; from?: string };
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

const graphColumnsStorageKey = "gitcat-graph-columns";
const graphColumnVar: Record<GraphColumn, string> = { refs: "--col-refs", graph: "--track-w", changes: "--col-changes", when: "--col-when" };

function readGraphColumns(): GraphColumnWidths {
  try { return parseGraphColumns(JSON.parse(localStorage.getItem(graphColumnsStorageKey) ?? "null")); } catch { return {}; }
}

function writeGraphColumns(widths: GraphColumnWidths) {
  try { localStorage.setItem(graphColumnsStorageKey, JSON.stringify(widths)); } catch { /* a view preference only */ }
}

/** Keeps both side panes inside their own range and never lets them squeeze the graph below its floor. */
function clampPanes({ sidebar, inspector }: PaneWidths, total: number): PaneWidths {
  const room = total > 0 ? total - paneRange.centre : Number.POSITIVE_INFINITY;
  const nextSidebar = clamp(sidebar, paneRange.sidebar[0], Math.min(paneRange.sidebar[1], room - paneRange.inspector[0]));
  const nextInspector = clamp(inspector, paneRange.inspector[0], Math.min(paneRange.inspector[1], room - nextSidebar));
  return { sidebar: Math.round(nextSidebar), inspector: Math.round(nextInspector) };
}

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
 * How this repository's history is being read. The main view opens on every branch at once, because
 * that is what answers "what changed here"; scoping to one branch is a choice away in its header.
 */
type HistoryPrefs = { scope: HistoryScope; byFamily: boolean };

const historyPrefsStorageKey = (path: string) => `gitcat-graph:${path}`;
/**
 * Where the old History tab kept its choices. Its scope described that tab, not the main view, so
 * only the colouring carries over; the graph starts on every branch until the user narrows it.
 */
const legacyHistoryPrefsStorageKey = (path: string) => `gitcat-history:${path}`;

function readHistoryPrefs(path: string): HistoryPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(historyPrefsStorageKey(path)) ?? "null");
    const legacy = stored ? null : JSON.parse(localStorage.getItem(legacyHistoryPrefsStorageKey(path)) ?? "null");
    return {
      scope: ["all", "branch", "branch-only"].includes(stored?.scope) ? stored.scope : "all",
      byFamily: (stored ?? legacy)?.byFamily !== false
    };
  } catch { /* a corrupt entry just means the defaults */ }
  return { scope: "all", byFamily: true };
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

/**
 * View choices remembered for a project follow it to its new location, but only once the new folder
 * has been validated as that project. Choices already saved at the new location win.
 */
function moveRepositoryViewState(from: string, to: string) {
  if (from === to) return;
  for (const key of [historyPrefsStorageKey, legacyHistoryPrefsStorageKey, branchViewStorageKey]) {
    try {
      const value = localStorage.getItem(key(from));
      if (value !== null && localStorage.getItem(key(to)) === null) localStorage.setItem(key(to), value);
      localStorage.removeItem(key(from));
    } catch { /* view preferences only */ }
  }
}

const unavailableReasonKeys: Record<ProjectUnavailableReason, { reason: MessageKey; next: MessageKey; short: MessageKey }> = {
  storage: { reason: "unavailableStorage", next: "unavailableStorageNext", short: "reasonShortStorage" },
  missing: { reason: "unavailableMissing", next: "unavailableMissingNext", short: "reasonShortMissing" },
  permission: { reason: "unavailablePermission", next: "unavailablePermissionNext", short: "reasonShortPermission" },
  tool: { reason: "unavailableTool", next: "unavailableToolNext", short: "reasonShortTool" },
  not_repository: { reason: "unavailableNotRepository", next: "unavailableNotRepositoryNext", short: "reasonShortNotRepository" }
};

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
  /** Saved projects that could not be opened. They keep their tab and their saved place until removed explicitly. */
  const [unavailable, setUnavailable] = useState<UnavailableProject[]>([]);
  /** The saved order of the workspace, so a project that is back, or found elsewhere, keeps its place. */
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  /** The unavailable project being retried or located, so its buttons wait for the answer. */
  const [recoveringPath, setRecoveringPath] = useState<string>();
  const [locateNotice, setLocateNotice] = useState<{ path: string; notice: LocateNotice }>();
  const [activeId, setActiveId] = useState<string>();
  const [selectedBranch, setSelectedBranch] = useState<string>();
  const [commitFilter, setCommitFilter] = useState("");
  const [request, setRequest] = useState("");
  const [conversations, setConversations] = useState<Record<string, ConversationTurn[]>>({});
  const [refreshingPath, setRefreshingPath] = useState<string>();
  /** Which toolbar button started the check in flight, so only that one spins. */
  const [refreshKind, setRefreshKind] = useState<"refresh" | "fetch">("refresh");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({ provider: "openai", model: "gpt-5.6-luna", configured: false });
  /** What the details pane is about: the uncommitted work, or one commit picked in the graph. */
  const [focus, setFocus] = useState<GraphFocus>();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [graphCommits, setGraphCommits] = useState<Commit[]>([]);
  const [jumpTo, setJumpTo] = useState<{ hash: string; at: number }>();
  const [modalCommit, setModalCommit] = useState<{ commit: Commit; file?: FileChange }>();
  const [menu, setMenu] = useState<MenuTarget>();
  const [sidebarHidden, setSidebarHidden] = useState(readSidebarHidden);
  const [selectedFile, setSelectedFile] = useState<FileChange>();
  const [proposal, setProposal] = useState<ConflictProposal>();
  /** How the last attempt to apply the open proposal went, when it did not settle everything. */
  const [proposalResult, setProposalResult] = useState<ConflictApplyResult>();
  const [applyingResolution, setApplyingResolution] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [inputDialog, setInputDialog] = useState<InputDialog>();
  const [commitMessage, setCommitMessage] = useState("");
  const [deliveryMerge, setDeliveryMerge] = useState(false);
  const [deliveryStateId, setDeliveryStateId] = useState<string>();
  const [deliveryReview, setDeliveryReview] = useState<{ turnId: number; plan: ActionPlan }>();
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [panes, setPanes] = useState<PaneWidths | undefined>(readPaneWidths);
  const requestSequence = useRef(0);
  /** Counts every deliberate snapshot update, so a slower background read never overwrites a newer one. */
  const snapshotWrites = useRef(0);
  const syncing = useRef(false);
  const syncFailedFor = useRef<string>(undefined);
  /** When each repository last asked its remote, whether or not the remote answered. */
  const fetchAttempts = useRef(new Map<string, number>());
  const fetchFailedFor = useRef<string>(undefined);
  const activitySequence = useRef(0);
  const conversationSequence = useRef(0);
  const workspaceRestored = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLElement>(null);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const active = projects.find((project) => project.id === activeId);
  const activeUnavailable = active ? undefined : unavailable.find((project) => project.path === activeId);
  const snapshot = active?.snapshot;
  const tabs = useMemo<WorkspaceTab[]>(() => {
    const all: WorkspaceTab[] = [
      ...projects.map((project) => ({ id: project.id, path: project.snapshot.path, name: project.snapshot.name })),
      ...unavailable.map((project) => ({ id: project.path, path: project.path, name: project.name, unavailable: project }))
    ];
    const rank = (path: string) => { const index = workspaceOrder.indexOf(path); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return all.map((tab, index) => ({ tab, index })).sort((a, b) => rank(a.tab.path) - rank(b.tab.path) || a.index - b.index).map(({ tab }) => tab);
  }, [projects, unavailable, workspaceOrder]);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const conversation = snapshot ? conversations[snapshot.path] ?? [] : [];
  const planning = conversation.some((turn) => turn.status === "loading" || turn.status === "executing");
  // Something prepared against the current state that the user has not decided on yet.
  const awaitingDecision = conversation.some((turn) => turn.status === "ready") || Boolean(deliveryReview || inputDialog || proposal || generatingDescription
    || (snapshot?.isDirty && deliveryStateId === snapshot.stateId));
  // A hidden branch panel gives its column to the graph; its saved width waits for it to come back.
  const paneStyle = panes || sidebarHidden
    ? { ...(panes ? { "--sidebar-w": `${panes.sidebar}px`, "--inspector-w": `${panes.inspector}px` } : {}), ...(sidebarHidden ? { "--sidebar-w": "0px" } : {}) } as CSSProperties
    : undefined;
  const toggleSidebar = (hidden: boolean) => {
    setSidebarHidden(hidden);
    try { localStorage.setItem(sidebarStorageKey, hidden ? "hidden" : "shown"); } catch { /* a view preference only */ }
  };

  // Adopt whatever widths the stylesheet chose for this window, so the handles start on the real borders.
  useLayoutEffect(() => {
    if (panes || sidebarHidden || !layoutRef.current) return;
    const columns = getComputedStyle(layoutRef.current).gridTemplateColumns.split(" ").map(Number.parseFloat);
    if (columns.length === 3 && columns.every(Number.isFinite)) setPanes({ sidebar: columns[0], inspector: columns[2] });
  }, [panes, snapshot, workspaceReady, exploring, config.configured, sidebarHidden]);

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
      const missing = workspace.unavailable ?? [];
      setProjects(restored);
      setUnavailable(missing);
      setWorkspaceOrder(workspace.order ?? [...restored.map((project) => project.snapshot.path), ...missing.map((project) => project.path)]);
      // The project that was in front stays in front, even when it has to explain why it cannot open.
      setActiveId(restored.find((project) => project.snapshot.path === workspace.activePath)?.id
        ?? missing.find((project) => project.path === workspace.activePath)?.path
        ?? restored[0]?.id ?? missing[0]?.path);
    }).catch((error) => {
      notify({ message: error instanceof Error ? error.message : t("fallbackRestoreProjects"), tone: "error" });
    }).finally(() => {
      workspaceRestored.current = true;
      setWorkspaceReady(true);
    });
  }, []);

  useEffect(() => {
    if (!workspaceRestored.current || !workspaceReady) return;
    const paths = tabs.map((tab) => tab.path);
    const activePath = tabs.find((tab) => tab.id === activeId)?.path;
    window.gitcat.saveWorkspace(paths, activePath).catch((error) => {
      notify({ message: error instanceof Error ? error.message : t("fallbackSaveWorkspace"), tone: "error" });
    });
  }, [tabs, activeId, workspaceReady, t]);


  useEffect(() => {
    requestSequence.current += 1;
    setRequest("");
    setSelectedBranch(undefined);
    setCommitFilter("");
    setFocus(undefined);
    setMenu(undefined);
    setInspectorTab("details");
    setGraphCommits([]);
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

  const updateSnapshot = (path: string, next: RepoSnapshot, fetched = false) => {
    snapshotWrites.current += 1;
    const now = new Date().toISOString();
    setProjects((items) => items.map((project) => project.snapshot.path === path
      ? { ...project, snapshot: next, loadedAt: now, ...(fetched ? { fetchedAt: now } : {}) }
      : project));
  };

  const openProject = async () => {
    try {
      const next = await window.gitcat.selectProject();
      if (!next) return;
      const existing = projects.find((project) => project.snapshot.path === next.path);
      if (existing) { updateSnapshot(next.path, next); setActiveId(existing.id); return; }
      // A saved project that was unavailable and is opened again by hand comes back in its own tab.
      const returning = unavailable.some((project) => project.path === next.path);
      const id = returning ? next.path : `${next.path}-${Date.now()}`;
      if (returning) setUnavailable((items) => items.filter((project) => project.path !== next.path));
      setProjects((items) => [...items, { id, snapshot: next, loadedAt: new Date().toISOString() }]);
      setActiveId(id);
      addActivity({ label: t("projectOpen"), detail: next.name, tone: "success" });
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackOpenProject")), tone: "error" });
    }
  };

  const closeProject = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (activeId === id) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id);
    setProjects((items) => items.filter((project) => project.id !== id));
    setUnavailable((items) => items.filter((project) => project.path !== id));
    if (locateNotice?.path === id) setLocateNotice(undefined);
  };

  /** Asks again whether an unavailable project can be opened. A project that is back keeps its tab and its place. */
  const retryUnavailable = async (project: UnavailableProject) => {
    if (recoveringPath) return;
    setRecoveringPath(project.path);
    setLocateNotice(undefined);
    try {
      const outcome = await window.gitcat.retryProject(project.path);
      if ("project" in outcome) {
        const next = outcome.project;
        setUnavailable((items) => items.filter((item) => item.path !== project.path));
        setWorkspaceOrder((order) => order.map((path) => path === project.path ? next.path : path));
        setProjects((items) => [...items.filter((item) => item.snapshot.path !== next.path), { id: project.path, snapshot: next, loadedAt: new Date().toISOString() }]);
        addActivity({ label: t("projectOpen"), detail: t("projectRecovered", { name: next.name }), tone: "success" });
      } else {
        setUnavailable((items) => items.map((item) => item.path === project.path ? outcome.unavailable : item));
        addActivity({ label: t("gitNeedsAttention"), detail: t("stillUnavailable", { name: project.name, reason: t(unavailableReasonKeys[outcome.unavailable.reason].short) }), tone: "warning" });
      }
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackRetryProject")), tone: "error" });
    } finally { setRecoveringPath(undefined); }
  };

  /** Takes a validated new location in place of the unavailable entry, moving view choices only when it is that project. */
  const adoptLocation = (from: string, result: Extract<ProjectLocateResult, { status: "relocated" }>) => {
    const next = result.project;
    if (result.carriedOver) moveRepositoryViewState(from, next.path);
    const existing = projects.find((project) => project.snapshot.path === next.path);
    // The folder may also be another saved entry that was waiting; it is the same project now, listed once.
    setUnavailable((items) => items.filter((item) => item.path !== from && item.path !== next.path));
    setLocateNotice(undefined);
    if (existing) {
      // The folder was already open in another tab: that tab is the project, and the old entry goes.
      updateSnapshot(next.path, next);
      setWorkspaceOrder((order) => order.filter((path) => path !== from));
      if (activeId === from) setActiveId(existing.id);
    } else {
      setWorkspaceOrder((order) => order.map((path) => path === from ? next.path : path));
      setProjects((items) => [...items, { id: from, snapshot: next, loadedAt: new Date().toISOString() }]);
    }
    addActivity({ label: t("projectOpen"), detail: t(result.carriedOver ? "projectRelocated" : "projectRelocatedFresh", { name: next.name, path: next.path }), tone: "success" });
  };

  const handleLocateResult = (from: string, result: ProjectLocateResult) => {
    if (result.status === "canceled") return;
    if (result.status === "relocated") adoptLocation(from, result);
    else setLocateNotice({ path: from, notice: result.status === "invalid" ? { kind: "invalid", result } : { kind: "confirm", result } });
  };

  /** Lets the person point at the folder's new place. The main process checks it is a repository before anything changes. */
  const locateUnavailable = async (project: UnavailableProject) => {
    if (recoveringPath) return;
    setRecoveringPath(project.path);
    setLocateNotice(undefined);
    try {
      handleLocateResult(project.path, await window.gitcat.locateProject(project.path, { title: t("locateDialogTitle", { name: project.name }), button: t("locateDialogButton") }));
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackLocateProject")), tone: "error" });
    } finally { setRecoveringPath(undefined); }
  };

  const confirmLocation = async (from: string, candidateId: string) => {
    if (recoveringPath) return;
    setRecoveringPath(from);
    setLocateNotice(undefined);
    try {
      handleLocateResult(from, await window.gitcat.confirmLocateProject(candidateId));
    } catch {
      notify({ message: t("locateExpired"), tone: "error" });
    } finally { setRecoveringPath(undefined); }
  };

  /**
   * The Refresh button: "am I up to date?". It reads this Mac's copy first, so the answer never waits
   * on the network, then asks the remote for news. Neither step changes a branch or a file. When the
   * remote cannot be reached, the local view is still current and the assistant is asked for a way on.
   *
   * The Fetch button is the same check without the local read first. Refresh already covers it, but
   * people who know Git look for Fetch by name, and a missing verb reads as a missing ability.
   */
  const refreshEverything = async (kind: "refresh" | "fetch" = "refresh") => {
    const path = snapshot?.path;
    if (!path || !snapshot || refreshingPath) return;
    setRefreshingPath(path);
    setRefreshKind(kind);
    let failure: string | undefined;
    try {
      const local = kind === "fetch" ? snapshot : await window.gitcat.getSnapshot(path);
      if (kind === "refresh") updateSnapshot(path, local);
      if (!local.remotes.length) {
        addActivity({ label: t("stateUpdated"), detail: t("refreshedLocal", { branch: local.currentBranch }), tone: "neutral" });
        return;
      }
      fetchAttempts.current.set(path, Date.now());
      try {
        const next = await window.gitcat.fetchRemotes(path);
        updateSnapshot(path, next, true);
        fetchFailedFor.current = undefined;
        addActivity({ label: t("stateUpdated"), detail: t("refreshedRemote", { branch: next.currentBranch, remote: remoteLabel(next, t) }), tone: "neutral" });
      } catch (error) {
        failure = cleanError(error, t("fallbackFetch"));
        addActivity({ label: t("remoteUnreachable"), detail: t("remoteUnreachableDetail", { remote: remoteLabel(local, t), reason: failure }), tone: "warning" });
      }
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackRefresh")), tone: "error" });
    } finally { setRefreshingPath(undefined); }
    if (failure && config.configured) await recoverFrom(path, {
      command: "git fetch --all --prune",
      summary: t("checkRemote"),
      error: failure,
      skipped: []
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

  /**
   * A quiet re-read of the repository on screen, so work done in a terminal, an editor or another
   * tool shows up without pressing Refresh. It waits while GitCat itself is reading or changing the
   * repository, and a failure is reported once rather than on every attempt.
   */
  const syncActive = async () => {
    const path = snapshotRef.current?.path;
    if (!path || syncing.current || refreshingPath || planning || resolving) return;
    syncing.current = true;
    const writes = snapshotWrites.current;
    const adopt = (next: RepoSnapshot, fetched = false) => {
      const at = new Date().toISOString();
      setProjects((items) => items.map((project) => project.snapshot.path === path ? refreshedProject(project, next, at, fetched ? at : undefined) : project));
    };
    try {
      const local = await window.gitcat.getSnapshot(path);
      if (snapshotWrites.current !== writes) return;
      adopt(local);
      syncFailedFor.current = undefined;
      const now = Date.now();
      if (!backgroundFetchDue({ hasRemote: local.remotes.length > 0, awaitingDecision, lastAttempt: fetchAttempts.current.get(path), now })) return;
      fetchAttempts.current.set(path, now);
      let next: RepoSnapshot;
      try { next = await window.gitcat.fetchRemotes(path); } catch (error) {
        // Offline or signed out: the local view stays current, and one notice is enough until it recovers.
        if (fetchFailedFor.current !== path) addActivity({ label: t("remoteUnreachable"), detail: t("remoteUnreachableDetail", { remote: remoteLabel(local, t), reason: cleanError(error, t("fallbackFetch")) }), tone: "warning" });
        fetchFailedFor.current = path;
        return;
      }
      fetchFailedFor.current = undefined;
      if (snapshotWrites.current !== writes) return;
      adopt(next, true);
      if (next.stateId !== local.stateId) addActivity({ label: t("remoteHasNews"), detail: t("remoteHasNewsDetail", { remote: remoteLabel(next, t) }), tone: "neutral" });
    } catch (error) {
      if (syncFailedFor.current !== path) notify({ message: cleanError(error, t("fallbackRefresh")), tone: "error" });
      syncFailedFor.current = path;
    } finally { syncing.current = false; }
  };
  const syncActiveRef = useRef(syncActive);
  syncActiveRef.current = syncActive;

  // Opening a tab shows that repository as it is now, not as it was when the tab was last looked at.
  useEffect(() => { if (workspaceReady) void syncActiveRef.current(); }, [activeId, workspaceReady]);

  // While the window is showing, it keeps itself current; coming back to it reads straight away.
  useEffect(() => {
    const sync = () => void syncActiveRef.current();
    const tick = () => { if (document.visibilityState === "visible") sync(); };
    const timer = window.setInterval(tick, autoRefreshIntervalMs);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const updateTurn = (path: string, id: number, update: (turn: ConversationTurn) => ConversationTurn) => {
    setConversations((items) => ({
      ...items,
      [path]: (items[path] ?? []).map((turn) => turn.id === id ? update(turn) : turn)
    }));
  };

  /** A new turn brings the assistant forward, unless it only reports a gesture that explains itself. */
  const addTurn = (path: string, question: string, reveal = true) => {
    const turn: ConversationTurn = { id: ++conversationSequence.current, question, status: "loading" };
    setConversations((items) => ({ ...items, [path]: [...(items[path] ?? []), turn] }));
    if (reveal) setInspectorTab("assistant");
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
      create_branch: args.from ? t("createNamedBranchFrom", { name: args.name, hash: args.from.slice(0, 7) }) : t("createNamedBranch", { name: args.name }),
      delete_branch: t("deleteNamedBranch", { name: args.name }),
      rename_branch: t("renameNamedBranch", { name: args.name, to: args.to }),
      fetch: t("updateRemoteRefs"),
      pull: t("pullCurrentBranch"),
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
    setProposalResult(undefined);
    try {
      setProposal(await window.gitcat.proposeConflictResolution(snapshot.path, locale));
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackProposeResolution")), tone: "error" });
    } finally { setResolving(false); }
  };

  const closeProposal = () => { setProposal(undefined); setProposalResult(undefined); };

  /**
   * Sends only the proposal id and the accepted paths: the reviewed content stays in the main process,
   * which checks it against the repository before writing anything. A refusal keeps the review open
   * with what happened to each file, so the next step is visible rather than a dead end.
   */
  const applyResolutions = async (accepted: string[]) => {
    if (!snapshot || !proposal || !accepted.length || applyingResolution) return;
    const path = snapshot.path;
    setApplyingResolution(true);
    try {
      const result = await window.gitcat.applyConflictResolution(path, proposal.id, accepted, locale);
      updateSnapshot(path, result.snapshot);
      const applied = result.outcomes.filter((outcome) => outcome.status === "applied").map((outcome) => outcome.path);
      if (result.complete) {
        closeProposal();
        addActivity({ label: t("conflictsResolved"), detail: counted(t, applied.length, "acceptedFile", "acceptedFiles"), tone: "success" });
        return;
      }
      // Applied files are done and leave the review; the rest can be retried or reviewed again.
      setProposal({ ...proposal, resolutions: proposal.resolutions.filter((item) => !applied.includes(item.path)) });
      setProposalResult(result);
      if (applied.length) addActivity({ label: t("conflictsPartlyResolved"), detail: counted(t, applied.length, "acceptedFile", "acceptedFiles"), tone: "warning" });
    } catch (error) {
      notify({ message: cleanError(error, t("fallbackApplyResolution")), tone: "error" });
      await refreshProject(path, false);
    } finally { setApplyingResolution(false); }
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
        if (plan.steps.some((step) => step.operation === "commit")) setCommitMessage("");
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
    const turnId = addTurn(path, t("branchSwitchQuestion", { name }), false);
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
    const value = inputDialog.value.trim();
    const operation = inputDialog.operation;
    const args: Record<string, string> = operation === "rename_branch" && inputDialog.from ? { name: inputDialog.from, to: value }
      : operation === "create_branch" && inputDialog.from ? { name: value, from: inputDialog.from }
      : { name: value };
    setInputDialog(undefined);
    void prepare(operation, args);
  };

  const openCommitForm = () => {
    if (!snapshot?.changes.length) return;
    setFocus({ kind: "wip" });
    setInspectorTab("details");
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

  /**
   * What the details pane shows when nothing has been picked: the uncommitted work if there is any,
   * because that is what changes next, and otherwise the commit the checkout is standing on. A commit
   * picked from an older list is swapped for the loaded one, which carries its body and stats.
   */
  const richer = (commit: Commit) => graphCommits.find((item) => item.hash === commit.hash || item.hash.startsWith(commit.shortHash || commit.hash)) ?? commit;
  const headCommit = snapshot?.head ? graphCommits.find((commit) => commit.hash === snapshot.head) ?? snapshot.commits.find((commit) => commit.hash === snapshot.head) : undefined;
  const activeFocus: GraphFocus | undefined = !snapshot ? undefined
    : focus?.kind === "commit" ? { kind: "commit", commit: richer(focus.commit) }
    : snapshot.isDirty ? { kind: "wip" }
    : headCommit ? { kind: "commit", commit: headCommit } : undefined;
  const waiting = conversation.filter((turn) => turn.status === "ready").length;

  const focusOn = (next: GraphFocus, jump = false) => {
    setFocus(next);
    setInspectorTab("details");
    if (jump && next.kind === "commit") setJumpTo({ hash: next.commit.hash, at: Date.now() });
  };

  const copyText = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text)
      .then(() => addActivity({ label: t("copiedToClipboard"), detail: what, tone: "neutral" }))
      .catch(() => notify({ message: t("clipboardFailed"), tone: "error" }));
  };

  /**
   * What a right click offers, built from the repository as it is now. Every Git change still goes
   * through a plan: the menu only picks the operation, it never runs one that needs a confirmation.
   * Anything without a direct operation is asked of the assistant, which plans it the same way.
   */
  const menuItems = (target: MenuTarget): MenuEntry[] => {
    if (!snapshot) return [];
    const current = snapshot.currentBranch;
    const base = snapshot.defaultBranch;
    const ask = (question: string) => { void propose(question); };
    const assistantHint = config.configured ? undefined : t("llmNotConfigured");
    const entries: MenuEntry[] = [];

    if (target.work) {
      const canIntegrate = Boolean(base && base !== current);
      entries.push({ key: "save", icon: GitCommitHorizontal, label: t("saveChanges"), onSelect: () => beginDelivery(false) });
      if (canIntegrate) entries.push({ key: "save-integrate", icon: GitMerge, label: t("saveAndIntegrate", { target: base! }), onSelect: () => beginDelivery(true) });
      entries.push({ key: "explain-work", icon: MessageSquareText, label: t("explainWork"), onSelect: () => ask(t("explainWorkQuestion", { branch: current })), disabled: !config.configured, hint: assistantHint });
      return entries;
    }

    const branch = target.branch ? snapshot.branches.find((item) => item.name === target.branch) : undefined;
    if (branch) {
      const name = branch.name;
      const local = branch.presence !== "remote";
      entries.push({ key: "branch-heading", heading: name });
      if (!branch.isCurrent) entries.push({ key: "switch", icon: ArrowLeftRight, label: t("switchBranch", { name }), onSelect: () => void switchBranch(name), hint: t("doubleClickHint") });
      if (branch.isCurrent && branch.upstream) entries.push({ key: "pull", icon: ArrowDownToLine, label: t("pullLatest"), onSelect: () => void prepare("pull") });
      if (branch.isCurrent) entries.push({ key: "push", icon: ArrowUpFromLine, label: t(branch.upstream ? "pushBranch" : "publishBranch"), onSelect: () => void prepare("push") });
      // An already-contained branch would merge nothing, and the default branch is never rewritten from here.
      if (!branch.isCurrent && current !== "HEAD" && !branch.mergedInto.includes(current)) entries.push({ key: "merge", icon: GitMerge, label: t("mergeBranchTo", { name, target: current }), onSelect: () => void prepare("merge", { name }) });
      if (local && base && name !== base && base !== current && !branch.mergedInto.includes(base)) entries.push({ key: "merge-default", icon: GitMerge, label: t("mergeBranchTo", { name, target: base }), onSelect: () => void prepareMergeToDefault(name) });
      if (!branch.isCurrent && local && current !== "HEAD" && current !== base) entries.push({ key: "rebase", icon: GitFork, label: t("rebaseCurrentOnto", { branch: current, onto: name }), onSelect: () => void prepare("rebase", { onto: name }) });
      if (base && name !== base) entries.push({ key: "explain-branch", icon: MessageSquareText, label: t("explainBranch"), onSelect: () => ask(t("explainBranchQuestion", { branch: name, base })), disabled: !config.configured, hint: assistantHint });
      if (local && name !== base) entries.push({ key: "rename", icon: Pencil, label: t("renameBranchAction"), onSelect: () => setInputDialog({ operation: "rename_branch", title: t("renameNamedBranchTitle", { name }), label: t("branchName"), value: name, from: name }) });
      if (!branch.isCurrent && local && name !== base && !isProtectedBranch(name)) entries.push({ key: "delete", icon: Trash2, label: t("deleteBranch", { name }), onSelect: () => void prepare("delete_branch", { name }), danger: true });
    }

    const commit = target.commit;
    if (commit) {
      if (entries.length) entries.push({ key: "commit-separator", separator: true });
      entries.push({ key: "commit-heading", heading: t("commitActions", { hash: commit.shortHash }) });
      entries.push({ key: "branch-here", icon: GitBranchPlus, label: t("createBranchHere"), onSelect: () => setInputDialog({ operation: "create_branch", title: t("newBranchFrom", { hash: commit.shortHash }), label: t("branchName"), value: "", from: commit.hash }) });
      entries.push({ key: "diff", icon: Maximize2, label: t("fullDiff"), onSelect: () => setModalCommit({ commit }) });
      entries.push({ key: "explain-commit", icon: MessageSquareText, label: t("explainCommit"), onSelect: () => ask(t("explainCommitQuestion", { hash: commit.shortHash, subject: commit.subject })), disabled: !config.configured, hint: assistantHint });
      entries.push({ key: "revert", icon: Undo2, label: t("revertCommit"), onSelect: () => ask(t("revertCommitQuestion", { hash: commit.shortHash, subject: commit.subject, branch: current })), disabled: !config.configured, hint: assistantHint ?? t("revertCommitHint") });
    }

    entries.push({ key: "copy-separator", separator: true });
    if (commit) entries.push({ key: "copy-hash", icon: Copy, label: t("copyHash"), onSelect: () => copyText(commit.hash, commit.shortHash) });
    if (commit) entries.push({ key: "copy-message", icon: Copy, label: t("copyMessage"), onSelect: () => copyText(commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject, commit.subject) });
    if (branch) entries.push({ key: "copy-branch", icon: Copy, label: t("copyBranchName"), onSelect: () => copyText(branch.name, branch.name) });
    return entries;
  };

  /** Picking a branch also points the graph at its tip, so the list answers "where is it" straight away. */
  const selectBranch = (name: string) => {
    setSelectedBranch(name);
    const tip = snapshot?.branches.find((branch) => branch.name === name)?.lastCommit;
    if (tip) focusOn({ kind: "commit", commit: richer(tip) }, true);
  };


  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
    <div className={`app-shell platform-${window.gitcat.platform}`}>
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><CatMark size={28} /></div><span>GitCat</span></div>
        <div className="window-tabs" role="tablist" aria-label={t("openProjects")}>
          {tabs.map((tab) => <div key={tab.id} className={`window-tab ${tab.id === activeId ? "active" : ""} ${tab.unavailable ? "unavailable" : ""}`}
            title={tab.unavailable ? t("unavailableTab", { name: tab.name, reason: t(unavailableReasonKeys[tab.unavailable.reason].short) }) : undefined}>
            <button role="tab" aria-selected={tab.id === activeId} onClick={() => setActiveId(tab.id)}>{tab.unavailable ? <AlertTriangle size={14} /> : <GitBranch size={14} />}<span>{tab.name}</span></button>
            <button className="tab-close" onClick={() => closeProject(tab.id)} aria-label={t(tab.unavailable ? "removeFromRecentNamed" : "closeProject", { name: tab.name })}><X size={13} /></button>
          </div>)}
          <button className="icon-button tab-add" onClick={() => void openProject()} aria-label={t("openProject")}><Plus size={16} /></button>
        </div>
        <div className="top-actions"><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={t("settings")}><Settings2 size={17} /></button></div>
      </header>
      <NotificationCenter items={activity} onDismiss={dismissActivity} onClear={dismissAllActivity} t={t} />

      {!workspaceReady ? <div className="workspace-loading"><LoaderCircle className="spin" size={24} /><span>{t("restoringProjects")}</span></div> : !config.configured && !exploring ? <ProviderRequired onConfigure={() => setSettingsOpen(true)} onExplore={() => setExploring(true)} /> : activeUnavailable ? <UnavailableProjectPanel
        key={activeUnavailable.path}
        project={activeUnavailable}
        busy={recoveringPath === activeUnavailable.path}
        notice={locateNotice?.path === activeUnavailable.path ? locateNotice.notice : undefined}
        onRetry={() => void retryUnavailable(activeUnavailable)}
        onLocate={() => void locateUnavailable(activeUnavailable)}
        onConfirm={(candidateId) => void confirmLocation(activeUnavailable.path, candidateId)}
        onDismissNotice={() => setLocateNotice(undefined)}
        onRemove={() => closeProject(activeUnavailable.path)}
      /> : !snapshot ? <Welcome openProject={openProject} /> : <>
        {!config.configured && <div className="provider-banner" role="status"><Eye size={14} /><span><strong>{t("noProviderBanner")}</strong> {t("noProviderBannerDetail")}</span><button className="outline-button small" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /> {t("configure")}</button></div>}


        <RepoToolbar
          snapshot={snapshot}
          busy={planning}
          deliveryBusy={planning || generatingDescription}
          refreshing={refreshingPath === snapshot.path && refreshKind === "refresh"}
          fetching={refreshingPath === snapshot.path && refreshKind === "fetch"}
          refreshDisabled={Boolean(refreshingPath)}
          onRefresh={() => void refreshEverything()}
          onFetch={() => void refreshEverything("fetch")}
          onPull={() => void prepare("pull")}
          onPush={() => void prepare("push")}
          onBranch={() => setInputDialog({ operation: "create_branch", title: t("newBranch"), label: t("branchName"), value: "" })}
          onSave={() => beginDelivery(false)}
          onIntegrate={() => beginDelivery(true)}
        />
        <main className="main-layout" ref={layoutRef} style={paneStyle}>
          {panes && !sidebarHidden && <PaneDivider edge="sidebar" width={panes.sidebar} onPointerDown={startResize("sidebar")} onNudge={(delta) => nudgePane("sidebar", delta)} onReset={() => resetPane("sidebar")} />}
          {panes && <PaneDivider edge="inspector" width={panes.inspector} onPointerDown={startResize("inspector")} onNudge={(delta) => nudgePane("inspector", delta)} onReset={() => resetPane("inspector")} />}
          {!sidebarHidden && <aside className="sidebar">
            <BranchPanel
              key={snapshot.path}
              snapshot={snapshot}
              busy={planning}
              selected={selection}
              onSelect={selectBranch}
              onCreate={() => setInputDialog({ operation: "create_branch", title: t("newBranch"), label: t("branchName"), value: "" })}
              onSwitch={(name) => void prepare("checkout", { name })}
              onSwitchNow={(name) => void switchBranch(name)}
              onDelete={(name) => void prepare("delete_branch", { name })}
              onRename={(name, to) => void prepare("rename_branch", { name, to })}
              onMenu={(branch, x, y) => setMenu({ x, y, branch: branch.name })}
              onCollapse={() => toggleSidebar(true)}
            />
            <div className="sidebar-mascot"><SleepingCat /><span>{t("oneStepAtATime")}</span></div>
          </aside>}

          <section className={`graph-area ${sidebarHidden ? "full-width" : ""}`}>
            {snapshot.pending && <PendingBanner
              snapshot={snapshot}
              busy={planning}
              onContinue={() => void prepare("continue_operation")}
              onSkip={() => void prepare("skip_operation")}
              onAbort={() => void prepare("abort_operation")}
              onResolve={() => void resolveConflicts()}
            />}
            <HistoryView
              key={snapshot.path}
              snapshot={snapshot}
              selection={selection}
              filter={commitFilter}
              onFilterChange={setCommitFilter}
              focus={activeFocus}
              jumpTo={jumpTo}
              onFocus={focusOn}
              onOpen={(commit) => setModalCommit({ commit })}
              onLoaded={setGraphCommits}
              onCheckout={(name) => void switchBranch(name)}
              onMenu={(target) => setMenu(target)}
              sidebarHidden={sidebarHidden}
              onShowSidebar={() => toggleSidebar(false)}
            />
          </section>

          <aside className="inspector">
            <div className="inspector-tabs" role="tablist" aria-label={t("inspectorTabs")}>
              <button role="tab" aria-selected={inspectorTab === "details"} className={inspectorTab === "details" ? "active" : ""} onClick={() => setInspectorTab("details")}><FileDiff size={14} />{t("detailsTab")}</button>
              <button role="tab" aria-selected={inspectorTab === "assistant"} className={inspectorTab === "assistant" ? "active" : ""} onClick={() => setInspectorTab("assistant")}><CatMark size={15} outline />{t("assistantTab")}{planning ? <LoaderCircle className="spin" size={12} /> : waiting > 0 ? <span className="tab-count attention" title={t("plansWaiting", { count: waiting })}>{waiting}</span> : conversation.length > 0 && <span className="tab-count">{conversation.length}</span>}</button>
            </div>
            {inspectorTab === "details" ? <div className="inspector-body">
              {activeFocus?.kind === "wip"
                ? <ChangesView snapshot={snapshot} merge={deliveryMerge} configured={config.configured} stale={Boolean(deliveryStateId && deliveryStateId !== snapshot.stateId)} onReviewAgain={() => beginDelivery(deliveryMerge)} onMergeChange={setDeliveryMerge} onOpenFile={setSelectedFile} message={commitMessage} generating={generatingDescription} busy={planning} onMessageChange={setCommitMessage} onGenerate={() => void generateDescription()} onPrepare={prepareCommit} />
                : activeFocus
                  ? <CommitInspector key={activeFocus.commit.hash} commit={activeFocus.commit} snapshot={snapshot} known={graphCommits} onFocus={(commit) => focusOn({ kind: "commit", commit }, true)} onOpen={(file) => setModalCommit({ commit: activeFocus.commit, file })} />
                  : <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>{t("noCommitSelected")}</strong><span>{t("noCommitSelectedHint")}</span></div>}
            </div> : <div className="assistant-body"><p className="assistant-copy">{config.configured ? t("assistantConfiguredCopy") : t("assistantUnconfiguredCopy")}</p>{conversation.length === 0 && config.configured && <div className="suggestion-list">{suggestionsFor(snapshot, t).map((suggestion) => <button key={suggestion.key} onClick={() => "question" in suggestion ? askSuggestion(suggestion.question) : setInputDialog(suggestion.dialog)} disabled={planning} title={"question" in suggestion ? suggestion.question : suggestion.label}><suggestion.icon size={15} /><span>{suggestion.label}</span></button>)}</div>}<div className="conversation-toolbar"><span>{conversation.length ? counted(t, conversation.length, "message", "messages") : t("newConversation")}</span><button onClick={() => setConversations((items) => ({ ...items, [snapshot.path]: [] }))} disabled={!conversation.length || planning}><Trash2 size={12} /> {t("clearConversation")}</button></div><div className="conversation" aria-live="polite">{conversation.map((turn) => <ConversationEntry key={turn.id} turn={turn} busy={planning} onApply={(plan) => void applyPlan(turn.id, plan)} onDismiss={() => updateTurn(snapshot.path, turn.id, (item) => ({ ...item, status: "cancelled", outcome: t("planDiscarded") }))} />)}<div ref={conversationEnd} /></div></div>}
            <div className="chat-compose"><textarea aria-label={t("assistantRequest")} disabled={!config.configured} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder={config.configured ? t("assistantPlaceholder") : t("configureAssistantPlaceholder")} rows={2} /><button className="send-button" aria-label={t("prepareRequest")} onClick={() => void propose(request)} disabled={planning || !request.trim() || !config.configured}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div>
          </aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className={`status-good ${snapshot.isDirty ? "has-changes" : ""}`}><CircleDot size={12} /> {snapshot.isDirty ? counted(t, snapshot.changes.length, "change", "changes") : t("noUncommittedChanges")}</span><span className="status-separator" /><span>{counted(t, branchCount.local, "localBranch", "localBranches")}{branchCount.remoteOnly ? `, ${branchCount.remoteOnly} ${t("remoteOnly")}` : ""}</span></div><div className="status-right"><span><Clock3 size={12} /> {t("lastRead", { date: formatDate(active.loadedAt, locale) })}</span><span className="remote-status" title={snapshot.remotes.length ? `${remoteTitle(snapshot, t)}\n${active.fetchedAt ? t("remoteCheckedAt", { date: formatDate(active.fetchedAt, locale) }) : t("remoteNotChecked")}` : remoteTitle(snapshot, t)}><Cloud size={12} /> {remoteLabel(snapshot, t)}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : t("llmNotConfigured")}</span></div></footer>
      </>}
      {deliveryReview && <DeliveryReviewModal review={deliveryReview} busy={planning}
        onClose={() => { updateTurn(deliveryReview.plan.repoPath, deliveryReview.turnId, (turn) => ({ ...turn, status: "cancelled", outcome: t("planDiscarded") })); setDeliveryReview(undefined); }}
        onApply={async () => { const review = deliveryReview; setDeliveryReview(undefined); await applyPlan(review.turnId, review.plan); }} />}
      {settingsOpen && <SettingsModal config={config} locale={locale} onLocaleChange={setLocale} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); notify({ message: t("settingsSaved"), tone: "success" }); }} />}
      {inputDialog && <InputModal dialog={inputDialog} branches={snapshot?.branches ?? []} onChange={(value) => setInputDialog({ ...inputDialog, value })} onClose={() => setInputDialog(undefined)} onSubmit={submitInputDialog} />}
      {menu && snapshot && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} label={menu.work ? t("uncommittedHeading") : menu.commit ? t("commitActions", { hash: menu.commit.shortHash }) : t("actionsFor", { name: menu.branch ?? "" })} onClose={() => setMenu(undefined)} />}
      {modalCommit && snapshot && <CommitModal commit={modalCommit.commit} initialFile={modalCommit.file} repoPath={snapshot.path} onClose={() => setModalCommit(undefined)} />}
      {selectedFile && snapshot && <FileDiffModal file={selectedFile} repoPath={snapshot.path} onClose={() => setSelectedFile(undefined)} />}
      {proposal && snapshot?.path === proposal.repoPath && <ConflictProposalModal key={proposal.id} proposal={proposal} result={proposalResult} busy={planning || applyingResolution || resolving} onApply={(accepted) => void applyResolutions(accepted)} onReviewAgain={() => void resolveConflicts()} onClose={closeProposal} />}
      {resolving && <div className="resolving-overlay" role="status"><LoaderCircle className="spin" size={22} /><span>{t("readConflictSides")}</span></div>}
    </div>
    </I18nContext.Provider>
  );
}

/**
 * A saved project that could not be opened. It says what happened in plain words, keeps the last
 * known path in view, and offers the ways on that fit: try again, point at the new folder, or let
 * it go. Removing is always a separate, explicit choice.
 */
function UnavailableProjectPanel({ project, busy, notice, onRetry, onLocate, onConfirm, onDismissNotice, onRemove }: {
  project: UnavailableProject;
  busy: boolean;
  notice?: LocateNotice;
  onRetry: () => void;
  onLocate: () => void;
  onConfirm: (candidateId: string) => void;
  onDismissNotice: () => void;
  onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const keys = unavailableReasonKeys[project.reason];
  const checked = new Date(project.checkedAt);
  // A folder that moved or stopped being a repository is found, not waited for; the rest usually comes back.
  const locateFirst = project.reason === "missing" || project.reason === "not_repository";
  const retry = <button key="retry" className={`${locateFirst ? "ghost-button" : "primary-button"} welcome-button`} disabled={busy} onClick={onRetry}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />} {t("retryProject")}</button>;
  const locate = <button key="locate" className={`${locateFirst ? "primary-button" : "ghost-button"} welcome-button`} disabled={busy} onClick={onLocate}><FolderOpen size={15} /> {t("locateMovedFolder")}</button>;
  return <div className="welcome unavailable-project" role="region" aria-label={t("unavailableTab", { name: project.name, reason: t(keys.short) })}>
    <div className="welcome-glow" />
    <div className="welcome-card">
      <div className="welcome-mark"><AlertTriangle size={30} /></div>
      <div className="eyebrow">{t("unavailableEyebrow")}</div>
      <h1>{project.name}</h1>
      <p className="unavailable-reason">{t(keys.reason)} {t(keys.next)}</p>
      <div className="unavailable-location"><span>{t("lastKnownLocation")}</span><code>{project.path}</code></div>
      {notice?.kind === "invalid" && <div className="unavailable-notice warning" role="alert">
        <p>{t("locateInvalid", { path: notice.result.path, reason: t(unavailableReasonKeys[notice.result.reason].short) })}</p>
        {notice.result.detail && <code>{notice.result.detail}</code>}
      </div>}
      {notice?.kind === "confirm" && <div className="unavailable-notice" role="alert">
        <p>{t(notice.result.match === "different" ? "locateConfirmDifferent" : "locateConfirmUnverified", { path: notice.result.path, name: project.name })}</p>
        <p>{t(notice.result.match === "different" ? "locateConfirmDifferentNext" : "locateConfirmUnverifiedNext")}</p>
        <div className="unavailable-notice-actions">
          <button className="primary-button small" disabled={busy} onClick={() => onConfirm(notice.result.candidateId)}><Check size={13} /> {t("useThisFolder")}</button>
          <button className="outline-button small" disabled={busy} onClick={onLocate}><FolderOpen size={13} /> {t("chooseAnotherFolder")}</button>
          <button className="ghost-button small" disabled={busy} onClick={onDismissNotice}>{t("cancel")}</button>
        </div>
      </div>}
      {locateFirst ? [locate, retry] : [retry, locate]}
      <button className="ghost-button welcome-button unavailable-remove" disabled={busy} onClick={onRemove}><Trash2 size={15} /> {t("removeFromRecent")}</button>
      <div className="welcome-footnote">{t("unavailableKept")} {Number.isNaN(checked.valueOf()) ? "" : t("lastChecked", { time: checked.toLocaleTimeString(localeTag(locale)) })}</div>
      {project.detail && <details className="unavailable-detail"><summary>{t("systemDetail")}</summary><code>{project.detail}</code></details>}
    </div>
  </div>;
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
function BranchPanel({ snapshot, busy, selected, onSelect, onCreate, onSwitch, onSwitchNow, onDelete, onRename, onMenu, onCollapse }: {
  snapshot: RepoSnapshot; busy: boolean; selected: string; onSelect: (name: string) => void; onCreate: () => void;
  onSwitch: (name: string) => void; onSwitchNow: (name: string) => void; onDelete: (name: string) => void;
  onRename: (from: string, to: string) => void; onMenu: (branch: Branch, x: number, y: number) => void; onCollapse: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<BranchView | undefined>(() => readBranchView(snapshot.path));
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<{ scrollTop: number; focused?: string }>(undefined);

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
    event.preventDefault();
    event.stopPropagation();
    onMenu(branch, event.clientX, event.clientY);
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
      <button className="mini-icon" onClick={onCollapse} aria-label={t("hideBranchPanel")} title={t("hideBranchPanel")}><PanelLeftClose size={14} /></button>
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

/**
 * A coarse "when" for the graph's margin. It only appears where it changes from the row above, so a
 * run of commits from the same day reads as one block instead of repeating itself on every line.
 */
function timeMarker(date: string, locale: Locale) {
  const value = Date.parse(date);
  if (Number.isNaN(value)) return "";
  const startOfDay = (time: number) => { const day = new Date(time); day.setHours(0, 0, 0, 0); return day.valueOf(); };
  const days = Math.round((startOfDay(Date.now()) - startOfDay(value)) / 86_400_000);
  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: "auto" });
  if (days < 7) return formatter.format(-Math.max(days, 0), "day");
  if (days < 30) return formatter.format(-Math.round(days / 7), "week");
  if (days < 365) return formatter.format(-Math.round(days / 30), "month");
  return formatter.format(-Math.round(days / 365), "year");
}

type FileKind = "added" | "modified" | "deleted" | "renamed" | "conflict";

/** Conflicts first: "DU" or "AA" is a file both sides touched, whatever else its letters say. */
function fileKind(code: string): FileKind {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
  if (code.includes("?") || code.includes("A")) return "added";
  if (code.includes("R") || code.includes("C")) return "renamed";
  if (code.includes("D")) return "deleted";
  return "modified";
}

const fileKindIcons: Record<FileKind, LucideIcon> = {
  added: FilePlus, modified: FilePen, deleted: FileMinus, renamed: FileSymlink, conflict: AlertTriangle
};

function workSummary(files: FileChange[], t: Translate) {
  const counts = new Map<FileKind, number>();
  for (const file of files) counts.set(fileKind(file.code), (counts.get(fileKind(file.code)) ?? 0) + 1);
  const words: Record<FileKind, [MessageKey, MessageKey]> = {
    modified: ["summaryModifiedOne", "summaryModified"], added: ["summaryAddedOne", "summaryAdded"], deleted: ["summaryDeletedOne", "summaryDeleted"],
    renamed: ["summaryRenamedOne", "summaryRenamed"], conflict: ["summaryConflictOne", "summaryConflict"]
  };
  return (Object.keys(words) as FileKind[]).flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count ? [{ kind, count, label: t(words[kind][count === 1 ? 0 : 1], { count }) }] : [];
  });
}

/**
 * The whole repository as one graph, newest first: which branch each line of work belongs to, what
 * every commit said and how much it changed, and — above it all — the work that is not saved yet.
 */
function HistoryView({ snapshot, selection, filter, onFilterChange, focus, jumpTo, onFocus, onOpen, onLoaded, onCheckout, onMenu, sidebarHidden, onShowSidebar }: {
  snapshot: RepoSnapshot; selection: string; filter: string; onFilterChange: (value: string) => void;
  focus?: GraphFocus; jumpTo?: { hash: string; at: number }; onFocus: (focus: GraphFocus) => void;
  onOpen: (commit: Commit) => void; onLoaded: (commits: Commit[]) => void;
  onCheckout: (branch: string) => void; onMenu: (target: MenuTarget) => void;
  sidebarHidden: boolean; onShowSidebar: () => void;
}) {
  const { t, locale } = useI18n();
  const [prefs, setPrefs] = useState(() => readHistoryPrefs(snapshot.path));
  const [page, setPage] = useState<{ commits: Commit[]; hasMore: boolean; comparedTo?: string }>({ commits: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Every load is numbered, so a slow answer for a scope the user already left cannot overwrite the
  // one they are looking at.
  const request = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const jumped = useRef(0);
  const [columns, setColumns] = useState<GraphColumnWidths>(readGraphColumns);

  const { byFamily, scope } = prefs;
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
  useEffect(() => { onLoaded(page.commits); }, [page.commits]);

  const update = (next: Partial<HistoryPrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    writeHistoryPrefs(snapshot.path, merged);
  };

  const needle = filter.trim().toLocaleLowerCase();
  // The working tree only belongs in a list that contains the commit it continues from.
  const showWork = snapshot.isDirty && Boolean(snapshot.head) && !needle && (scope === "all" || branch === snapshot.currentBranch);
  const listed = useMemo(
    () => showWork ? withWorkInProgress(page.commits, snapshot.head, snapshot.currentBranch) : page.commits,
    [showWork, page.commits, snapshot.head, snapshot.currentBranch]
  );
  const graph = useMemo(
    () => buildCommitGraph(listed, snapshot.remotes, snapshot.defaultBranch),
    [listed, snapshot.remotes, snapshot.defaultBranch]
  );
  const rows = useMemo(() => new Map(graph.rows.map((row) => [row.commit.hash, row])), [graph]);
  const visible = useMemo(() => needle
    ? page.commits.filter((commit) => [commit.subject, commit.body ?? "", commit.author, commit.hash, ...commit.refs]
        .some((field) => field.toLocaleLowerCase().includes(needle)))
    : listed, [page.commits, listed, needle]);
  // A filtered list is a selection of commits, not a graph: the lanes between them no longer connect.
  const lanes = needle ? 0 : Math.min(graph.laneCount, maxLanes);
  const trackWidth = lanes ? Math.max(40, lanes * laneWidth + laneOffset) : 40;
  const columnStyle = {
    ...Object.fromEntries(Object.entries(columns).map(([column, width]) => [graphColumnVar[column as GraphColumn], `${width}px`])),
    "--track-w": `${columns.graph ?? trackWidth}px`
  } as CSSProperties;

  const setColumn = (column: GraphColumn, width: number | undefined) => setColumns((current) => {
    const next = { ...current };
    if (width === undefined) delete next[column]; else next[column] = clampGraphColumn(column, width);
    writeGraphColumns(next);
    return next;
  });

  /**
   * Dragging writes the width straight onto the scroller, so a long history does not re-render on
   * every pointer move; the width becomes state, and is remembered, when the drag ends. A grip on a
   * column's leading edge grows the column leftwards, so its delta is reversed.
   */
  const startColumnResize = (column: GraphColumn, side: "start" | "end") => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const grip = event.currentTarget;
    const cell = grip.parentElement;
    const target = scroller.current;
    if (!cell || !target) return;
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    let width = startWidth;
    let moved = false;
    grip.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      moved = true;
      const delta = moveEvent.clientX - startX;
      width = clamp(startWidth + (side === "end" ? delta : -delta), ...graphColumnRange[column]);
      target.style.setProperty(graphColumnVar[column], `${width}px`);
    };
    const stop = () => {
      grip.releasePointerCapture(event.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      if (moved) setColumn(column, width);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  };

  const columnGrip = (column: GraphColumn, side: "start" | "end", label: string) => <span
    className={`column-grip ${side}`}
    role="separator"
    aria-orientation="vertical"
    aria-label={t("resizeColumn", { column: label })}
    aria-valuemin={graphColumnRange[column][0]}
    aria-valuemax={graphColumnRange[column][1]}
    tabIndex={0}
    title={`${t("resizeColumn", { column: label })} · ${t("resizePaneHint")}`}
    onPointerDown={startColumnResize(column, side)}
    onDoubleClick={() => setColumn(column, undefined)}
    onKeyDown={(event) => {
      const step = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[event.key];
      const cell = event.currentTarget.parentElement;
      if (step === undefined || !cell) return;
      event.preventDefault();
      setColumn(column, cell.getBoundingClientRect().width + (side === "end" ? step : -step));
    }}
  />;
  const markers = useMemo(() => {
    let previous = "";
    return visible.map((commit) => {
      const label = commit.date ? timeMarker(commit.date, locale) : "";
      if (!label || label === previous) return "";
      previous = label;
      return label;
    });
  }, [visible, locale]);
  const summary = useMemo(() => workSummary(snapshot.changes, t).map((item) => item.label).join(" · "), [snapshot.changes, t]);

  const isFocused = (commit: Commit) => commit.hash === workInProgressHash
    ? focus?.kind === "wip"
    : focus?.kind === "commit" && (commit.hash === focus.commit.hash || commit.hash.startsWith(focus.commit.shortHash || focus.commit.hash));
  const focusCommit = (commit: Commit) => onFocus(commit.hash === workInProgressHash ? { kind: "wip" } : { kind: "commit", commit });

  // Picking a branch in the sidebar brings its tip into view once, and never again on a later reload.
  useEffect(() => {
    if (!jumpTo || jumped.current === jumpTo.at) return;
    const target = visible.find((commit) => commit.hash.startsWith(jumpTo.hash) || jumpTo.hash.startsWith(commit.hash));
    const node = target && buttons.current.get(target.hash);
    if (!node) return;
    jumped.current = jumpTo.at;
    node.scrollIntoView({ block: "center" });
  }, [jumpTo, visible]);

  /** Up and down walk the graph the way a list of files is walked, and the details pane follows. */
  const walk = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = visible.findIndex(isFocused);
    const next = visible[Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), visible.length - 1)];
    if (!next || next === visible[index]) return;
    event.preventDefault();
    focusCommit(next);
    const node = buttons.current.get(next.hash);
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  };

  const scopeLabels: Record<HistoryScope, string> = {
    all: t("allBranches"),
    branch: t("branchScope", { branch: selection }),
    "branch-only": t("branchOnlyScope", { branch: selection })
  };

  return <div className="graph-panel">
    <div className="graph-header">
      {sidebarHidden && <button className="mini-icon" onClick={onShowSidebar} aria-label={t("showBranchPanel")} title={t("showBranchPanel")}><PanelLeftOpen size={15} /></button>}
      <div className="graph-scope">
        <label className="scope-field"><GitBranch size={12} /><span className="visually-hidden">{t("historyScope")}</span><select aria-label={t("historyScope")} value={scope} onChange={(event) => update({ scope: event.target.value as HistoryScope })}>
          {(Object.keys(scopeLabels) as HistoryScope[]).map((value) => <option value={value} key={value}>{scopeLabels[value]}</option>)}
        </select></label>
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
        <div className="search-field commit-search"><Search size={13} /><input aria-label={t("searchCommits")} value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder={t("searchCommits")} /></div>
      </div>
    </div>
    {needle && <div className="graph-note">{t("filteredHistoryNote", { count: page.commits.length })}</div>}
    {error && <div className="graph-note error" role="alert">{error}</div>}
    <div className="graph-scroll" ref={scroller} style={columnStyle} onKeyDown={walk}>
      <div className="graph-columns">
        <span><span aria-hidden="true">{t("branchesAndTags")}</span>{columnGrip("refs", "end", t("branchesAndTags"))}</span>
        <span><span aria-hidden="true">{t("graphLabel")}</span>{columnGrip("graph", "end", t("graphLabel"))}</span>
        <span aria-hidden="true">{t("columnMessage")}</span>
        <span className="col-changes">{columnGrip("changes", "start", t("columnChanges"))}<span aria-hidden="true">{t("columnChanges")}</span></span>
        <span className="col-when">{columnGrip("when", "start", t("columnWhen"))}<span aria-hidden="true">{t("columnWhen")}</span></span>
      </div>
      {visible.length ? visible.map((commit, index) => <CommitRow
        key={commit.hash}
        commit={commit}
        work={commit.hash === workInProgressHash ? { summary, count: snapshot.changes.length, branch: snapshot.currentBranch } : undefined}
        head={commit.hash === snapshot.head}
        selected={isFocused(commit)}
        marker={markers[index]}
        row={rows.get(commit.hash)}
        lanes={lanes}
        remotes={snapshot.remotes}
        colour={byFamily ? familyColour(rows.get(commit.hash)?.family ?? "") : branchColor(index)}
        byFamily={byFamily}
        register={(node) => { if (node) buttons.current.set(commit.hash, node); else buttons.current.delete(commit.hash); }}
        onSelect={() => focusCommit(commit)}
        onOpen={() => commit.hash === workInProgressHash ? focusCommit(commit) : onOpen(commit)}
        onCheckout={onCheckout}
        onMenu={(branch, x, y) => {
          focusCommit(commit);
          onMenu(commit.hash === workInProgressHash ? { x, y, work: true } : { x, y, commit, branch });
        }}
      />) : !loading && <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>{t("noCommits")}</strong><span>{needle ? t("filterNoCommits") : scope === "branch-only" ? t("branchNoUniqueCommits", { branch: selection, base: page.comparedTo ?? t("primary") }) : t("branchNoHistory")}</span></div>}
      {loading && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> {t("readHistory")}</div>}
      {!loading && page.hasMore && !needle && <button className="load-more" onClick={() => fetchPage(page.commits.length)}>{t("loadMoreCommits")}</button>}
    </div>
  </div>;
}

const laneWidth = 20;
const laneOffset = 14;
const laneX = (lane: number) => lane * laneWidth + laneOffset;

/**
 * One row of the graph. The lines are an SVG stretched to whatever height the row ends up with, and
 * the node stays a DOM element so that stretching never turns the circle into an ellipse. Both are
 * anchored to the same midpoint, so the joint always lands on the node whatever the row measures.
 * A row with refs also draws the short rule that ties its labels to the node they name.
 */
function GraphLanes({ row, lanes, colour, byFamily, connector, dashed }: { row: GraphRow; lanes: number; colour: string; byFamily: boolean; connector: boolean; dashed: boolean }) {
  const width = lanes * laneWidth + laneOffset;
  const visible = (lane: number) => lane < lanes;
  const tone = (family: string) => byFamily ? familyColour(family) : "#4a4d4b";
  const dash = dashed ? "3 3" : undefined;
  // A fixed width, so a graph column dragged wider leaves room beside the lanes instead of stretching them.
  return <svg className="graph-lanes" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" style={{ width }} aria-hidden="true">
    {connector && visible(row.lane) && <line className="ref-link" x1={0} y1={50} x2={laneX(row.lane)} y2={50} stroke={colour} />}
    {row.through.filter((line) => visible(line.lane)).map((line) =>
      <line key={`t${line.lane}`} x1={laneX(line.lane)} y1={0} x2={laneX(line.lane)} y2={100} stroke={tone(line.family)} />)}
    {row.incoming.filter(visible).map((lane) => lane === row.lane
      ? <line key={`i${lane}`} x1={laneX(lane)} y1={0} x2={laneX(lane)} y2={50} stroke={colour} />
      : <path key={`i${lane}`} d={`M ${laneX(lane)} 0 L ${laneX(lane)} 20 Q ${laneX(lane)} 50 ${laneX(row.lane)} 50`} fill="none" stroke={colour} />)}
    {row.outgoing.filter(visible).map((lane) => lane === row.lane
      ? <line key={`o${lane}`} x1={laneX(lane)} y1={50} x2={laneX(lane)} y2={100} stroke={colour} strokeDasharray={dash} />
      : <path key={`o${lane}`} d={`M ${laneX(row.lane)} 50 Q ${laneX(lane)} 50 ${laneX(lane)} 80 L ${laneX(lane)} 100`} fill="none" stroke={colour} strokeDasharray={dash} />)}
  </svg>;
}

/** Same name, same colour, on every machine: the tone comes from the author, not from the list. */
function authorTone(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  const hue = [14, 34, 56, 96, 128, 168, 190, 212, 246, 276, 302, 344][(hash >>> 0) % 12];
  return { background: `hsl(${hue} 30% 30%)`, color: `hsl(${hue} 75% 86%)` };
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => [...word][0] ?? "").join("").toLocaleUpperCase() || "?";
}

/** Photo answers are kept for the session, and a photo that failed to load is not asked for again. */
const avatarUrls = new Map<string, string | undefined>();
const avatarLookups = new Map<string, Promise<string | undefined>>();
const missingAvatars = new Set<string>();

function lookupAvatar(key: string) {
  let lookup = avatarLookups.get(key);
  if (!lookup) {
    lookup = authorAvatarUrl(key).catch(() => undefined);
    void lookup.then((url) => avatarUrls.set(key, url));
    avatarLookups.set(key, lookup);
  }
  return lookup;
}

/** The author's photo laid over their initials, which stay underneath for as long as there is no photo. */
function AuthorPhoto({ email }: { email: string }) {
  const key = avatarKey(email);
  const [url, setUrl] = useState(() => key && !missingAvatars.has(key) ? avatarUrls.get(key) : undefined);
  useEffect(() => {
    let live = true;
    setUrl(key && !missingAvatars.has(key) ? avatarUrls.get(key) : undefined);
    if (key && !missingAvatars.has(key)) void lookupAvatar(key).then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [key]);
  if (!url) return null;
  return <img className="author-photo" src={url} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => { missingAvatars.add(key); setUrl(undefined); }} />;
}

function Avatar({ name, email, size }: { name: string; email: string; size: number }) {
  return <span className="avatar-chip" style={{ ...authorTone(email || name), width: size, height: size, fontSize: Math.round(size * 0.4) }} title={email ? `${name} <${email}>` : name} aria-hidden="true">{initials(name)}<AuthorPhoto email={email} /></span>;
}

/** Small counts stay exact; past a thousand lines the scale matters more than the last digit. */
function compactCount(value: number, locale: Locale) {
  return new Intl.NumberFormat(localeTag(locale), value >= 1_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value);
}

/** Lines in and out, and a five-block bar for the proportion — the shape of a change, readable at a glance. */
function ChangeStats({ additions, deletions, files, binary = false }: { additions: number; deletions: number; files?: number; binary?: boolean }) {
  const { t, locale } = useI18n();
  const total = additions + deletions;
  const title = files === undefined ? undefined : t("commitStatsTitle", { files, additions, deletions });
  if (binary) return <span className="change-stats binary">{t("binaryFile")}</span>;
  if (!total) return <span className="change-stats empty" title={title}>{files ? counted(t, files, "file", "files") : "—"}</span>;
  const added = Math.round((additions / total) * 5);
  return <span className="change-stats" title={title}>
    {additions > 0 && <span className="stat-add">+{compactCount(additions, locale)}</span>}
    {deletions > 0 && <span className="stat-del">−{compactCount(deletions, locale)}</span>}
    <span className="stat-bar" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className={index < added ? "add" : "del"} />)}</span>
  </span>;
}

function CommitRow({ commit, row, lanes, remotes, colour, byFamily, selected, head, marker, work, register, onSelect, onOpen, onCheckout, onMenu }: {
  commit: Commit; row?: GraphRow; lanes: number; remotes: string[]; colour: string; byFamily: boolean;
  selected: boolean; head: boolean; marker: string;
  work?: { summary: string; count: number; branch: string };
  register: (node: HTMLButtonElement | null) => void; onSelect: () => void; onOpen: () => void;
  onCheckout: (branch: string) => void; onMenu: (branch: string | undefined, x: number, y: number) => void;
}) {
  const { t, locale } = useI18n();
  const lane = row && lanes ? Math.min(row.lane, lanes - 1) : 0;
  const chips = work ? [] : refChips(commit.refs, remotes);
  const [first, ...rest] = chips;
  // "+N" opens every label on the commit, stacked over the rows below, the way the row would show them
  // if it were tall enough. It closes on a click elsewhere or Escape.
  const [stackOpen, setStackOpen] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!stackOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!stackRef.current?.contains(target) && !moreRef.current?.contains(target)) setStackOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setStackOpen(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [stackOpen]);
  const pr = pullRequestReference(commit.subject);
  const merge = commit.parents.length > 1;
  const chipTitle = (chip: RefChip) => chip.kind === "remote" ? `${chip.label} · ${t("remoteOnlyTitle")}` : chip.label;
  const node = work ? "wip" : merge ? "merge" : "avatar";
  // A branch label is the branch: a double click moves there, a right click is about that branch.
  const branchOf = (chip?: RefChip) => chip && chip.kind !== "tag" ? chip.label : undefined;
  const chipEvents = (chip: RefChip) => chip.kind === "tag" ? {} : {
    onDoubleClick: (event: ReactMouseEvent) => { event.stopPropagation(); if (chip.kind !== "head") onCheckout(chip.label); },
    onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation(); onMenu(chip.label, event.clientX, event.clientY); }
  };
  const size = node === "merge" ? 10 : 20;
  const chipTag = (chip: RefChip) => <span className={`ref-tag ${chip.kind}`} key={`${chip.kind}:${chip.label}`} title={`${chipTitle(chip)}${chip.kind === "tag" ? "" : `\n${t(chip.kind === "head" ? "currentBranchHint" : "doubleClickSwitchHint")}`}`} {...chipEvents(chip)}>
    {chip.kind === "head" ? <Check size={11} /> : chip.kind === "tag" ? <Tag size={11} /> : chip.kind === "remote" ? <Cloud size={11} /> : <GitBranch size={11} />}<span>{chip.label}</span>
  </span>;
  return <div
    className={`commit-row ${selected ? "selected" : ""} ${head ? "head" : ""} ${work ? "wip" : ""}`}
    style={{ "--lane": colour } as CSSProperties}
    data-hash={commit.hash}
    onClick={onSelect}
    onDoubleClick={onOpen}
    onContextMenu={(event) => { event.preventDefault(); onMenu(branchOf(first), event.clientX, event.clientY); }}
  >
    <div className="commit-refs">
      {first && chipTag(first)}
      {rest.length > 0 && <button
        ref={moreRef}
        className="ref-tag more"
        aria-expanded={stackOpen}
        aria-label={t("showAllRefs", { count: chips.length })}
        title={rest.map(chipTitle).join("\n")}
        onClick={(event) => { event.stopPropagation(); setStackOpen((open) => !open); }}
        onDoubleClick={(event) => event.stopPropagation()}
      >+{rest.length}</button>}
      {first && <span className="ref-connector" />}
    </div>
    {stackOpen && <div className="ref-stack" ref={stackRef} role="group" aria-label={t("showAllRefs", { count: chips.length })}>{chips.map(chipTag)}</div>}
    <div className="graph-track">
      {row && lanes > 0 ? <GraphLanes row={row} lanes={lanes} colour={colour} byFamily={byFamily} connector={Boolean(first)} dashed={Boolean(work)} /> : <span className="track-line" />}
      <span className={`commit-node ${node}`} style={{ left: laneX(lane) - size / 2, borderColor: colour, ...(node === "avatar" ? authorTone(commit.email || commit.author) : node === "merge" ? { background: colour } : {}) }} title={work ? undefined : `${commit.author} · ${formatDateFull(commit.date, locale)}`}>
        {node === "avatar" ? <>{initials(commit.author)}<AuthorPhoto email={commit.email} /></> : node === "wip" ? <PencilLine size={10} /> : null}
      </span>
    </div>
    <button className="commit-content" ref={register} aria-pressed={selected} aria-label={work ? t("inspectWork", { branch: work.branch }) : t("inspectCommit", { hash: commit.shortHash, subject: commit.subject })}>
      {work ? <>
        <span className="wip-tag">// WIP</span>
        <span className="commit-subject">{work.summary}</span>
      </> : <>
        {pr && <span className="pr-badge" title={t("prReferenceNote")}>PR #{pr}</span>}
        {merge && <GitMerge size={12} className="merge-marker" />}
        <span className="commit-subject" title={commit.subject}>{commit.subject || t("commitWithoutMessage")}</span>
        {commit.body && <span className="commit-body">{commit.body.replace(/\s+/g, " ")}</span>}
      </>}
    </button>
    <div className="commit-changes">
      {work ? <span className="change-stats wip-count">{counted(t, work.count, "file", "files")}</span>
        : commit.stats && <ChangeStats additions={commit.stats.additions} deletions={commit.stats.deletions} files={commit.stats.files} />}
    </div>
    <div className="commit-when" title={commit.date ? formatDateFull(commit.date, locale) : undefined}>{marker && <span>{marker}</span>}</div>
  </div>;
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

/**
 * The repository bar: where you are, the everyday Git verbs, and the next step for this branch. The
 * verbs still go through a plan, so a click here explains itself before anything changes.
 */
function RepoToolbar({ snapshot, busy, deliveryBusy, refreshing, fetching, refreshDisabled, onRefresh, onFetch, onPull, onPush, onBranch, onSave, onIntegrate }: {
  snapshot: RepoSnapshot; busy: boolean; deliveryBusy: boolean; refreshing: boolean; fetching: boolean; refreshDisabled: boolean;
  onRefresh: () => void; onFetch: () => void; onPull: () => void; onPush: () => void; onBranch: () => void;
  onSave: () => void; onIntegrate: () => void;
}) {
  const { t } = useI18n();
  const source = snapshot.branches.find((branch) => branch.isCurrent);
  const target = snapshot.defaultBranch;
  const canIntegrate = Boolean(source && target && target !== snapshot.currentBranch);
  const integrated = Boolean(target && source?.mergedInto.includes(target) && !snapshot.isDirty);
  const blocked = Boolean(snapshot.pending || snapshot.conflicts.length || (!source && snapshot.head) || snapshot.currentBranch === "HEAD");
  const newFiles = snapshot.changes.filter((file) => file.code.includes("?")).length;
  const guidance = blocked ? t("finishPendingFirst") : snapshot.isDirty ? t("workSaveGuidance", { count: newFiles }) : integrated ? t("workIntegrated", { target: target! }) : canIntegrate ? t("workReadyToIntegrate", { target: target! }) : t(target ? "workOnMain" : "workNoMain");
  const tool = (Icon: LucideIcon, label: string, onClick: () => void, disabled: boolean, title?: string, spinning = false) =>
    <button className="tool-button" onClick={onClick} disabled={disabled} title={title ?? label}>{spinning ? <LoaderCircle className="spin" size={17} /> : <Icon size={17} />}<span>{label}</span></button>;
  return <div className="repo-toolbar">
    <div className="toolbar-context">
      <div className="toolbar-field"><span className="toolbar-caption">{t("toolbarRepository")}</span><strong title={snapshot.path}>{snapshot.name}</strong></div>
      <ChevronRight size={14} className="toolbar-separator" aria-hidden="true" />
      <div className="toolbar-field branch"><span className="toolbar-caption">{t("toolbarBranch")}</span><strong title={snapshot.currentBranch}><GitBranch size={13} /><span>{snapshot.currentBranch}</span></strong></div>
      {source?.upstream && (source.ahead > 0 || source.behind > 0) && <span className="toolbar-sync" title={t("syncTitle", { ahead: source.ahead, behind: source.behind, upstream: source.upstream })}>
        {source.behind > 0 && <span><ArrowDownToLine size={11} />{source.behind}</span>}
        {source.ahead > 0 && <span><ArrowUpFromLine size={11} />{source.ahead}</span>}
      </span>}
    </div>
    <div className="toolbar-tools">
      {tool(RefreshCcw, t("refresh"), onRefresh, refreshDisabled, t("refreshTitle"), refreshing)}
      {tool(CloudDownload, t("fetch"), onFetch, refreshDisabled || !snapshot.remotes.length, snapshot.remotes.length ? t("fetchTitle") : t("noRemoteFetchTitle"), fetching)}
      {tool(ArrowDownToLine, t("pull"), onPull, busy, t("pullTitle"))}
      {tool(ArrowUpFromLine, t("push"), onPush, busy, t("pushTitle"))}
      <span className="tool-divider" aria-hidden="true" />
      {tool(GitBranchPlus, t("branchTool"), onBranch, busy, t("newBranch"))}
    </div>
    <div className={`toolbar-delivery ${snapshot.isDirty ? "is-dirty" : "is-saved"}`} title={guidance}>
      <span className="delivery-status">{snapshot.isDirty
        ? <><CircleDot size={12} />{t("workNeedsSaving", { count: snapshot.changes.length })}</>
        : integrated ? <><Check size={12} />{t("integratedStatus", { target: target! })}</> : <><Check size={12} />{t("workSaved")}</>}</span>
      <div className="delivery-actions">
        {snapshot.isDirty && <button className={canIntegrate ? "outline-button" : "primary-button"} disabled={deliveryBusy || blocked} onClick={onSave}><GitCommitHorizontal size={14} />{t("saveChanges")}</button>}
        {canIntegrate && !integrated && <button className="primary-button" disabled={deliveryBusy || blocked} onClick={onIntegrate}><GitMerge size={14} />{t(snapshot.isDirty ? "saveAndIntegrate" : "integrateInto", { target: target! })}</button>}
      </div>
    </div>
  </div>;
}

type FileListMode = "path" | "tree";
const fileListStorageKey = "gitcat-file-list-mode";

function readFileListMode(): FileListMode {
  try { return localStorage.getItem(fileListStorageKey) === "tree" ? "tree" : "path"; }
  catch { return "path"; }
}

/** How many files of each kind, and how many lines in and out when they were counted. */
function ChangeSummary({ files, stats }: { files: FileChange[]; stats?: Record<string, FileStats> }) {
  const { t } = useI18n();
  const totals = stats && Object.values(stats).reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
  return <div className="change-summary">
    {workSummary(files, t).map((item) => { const Icon = fileKindIcons[item.kind]; return <span key={item.kind} className={`kind-${item.kind}`}><Icon size={13} />{item.label}</span>; })}
    {totals && (totals.additions > 0 || totals.deletions > 0) && <ChangeStats additions={totals.additions} deletions={totals.deletions} files={files.length} />}
  </div>;
}

/**
 * The files a change touched, as a flat list of paths or as the folders they live in. Either way
 * each file says what happened to it and how much, and a click opens exactly that file's diff.
 */
function FileList({ files, stats, onOpen }: { files: FileChange[]; stats?: Record<string, FileStats>; onOpen: (file: FileChange) => void }) {
  const { t } = useI18n();
  const [mode, setModeState] = useState<FileListMode>(readFileListMode);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const setMode = (next: FileListMode) => {
    setModeState(next);
    try { localStorage.setItem(fileListStorageKey, next); } catch { /* the default is fine */ }
  };
  const sorted = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);

  const fileRow = (file: FileChange, depth: number, label: string, folder: string, index: number) => {
    const kind = fileKind(file.code);
    const Icon = fileKindIcons[kind];
    const status = file.code.includes("?") ? t("newFileIncluded") : changeStatus(file.code, t);
    const counts = stats?.[file.path];
    return <button className={`change-row kind-${kind}`} key={`${file.path}-${index}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onOpen(file)} title={`${status} · ${file.from ? `${file.from} → ` : ""}${file.path}`}>
      <span className="change-status"><Icon size={14} /><span className="visually-hidden">{status}</span></span>
      <span className="change-path">{folder && <span className="change-folder">{folder}</span>}<span className="change-name">{label}</span></span>
      {counts && <ChangeStats additions={counts.additions} deletions={counts.deletions} binary={counts.binary} />}
    </button>;
  };

  const tree = () => {
    const rows: ReactNode[] = [];
    let open: string[] = [];
    sorted.forEach((file, index) => {
      const parts = file.path.split("/");
      const folders = parts.slice(0, -1);
      // Close whatever the previous path had open that this one does not share, then open the rest.
      let shared = 0;
      while (shared < open.length && open[shared] === folders[shared]) shared += 1;
      open = open.slice(0, shared);
      for (let depth = shared; depth < folders.length; depth += 1) {
        const key = folders.slice(0, depth + 1).join("/");
        const hidden = folders.slice(0, depth).some((_, level) => collapsed.has(folders.slice(0, level + 1).join("/")));
        open.push(folders[depth]);
        if (hidden) continue;
        const isOpen = !collapsed.has(key);
        rows.push(<button key={`dir:${key}`} className="change-folder-row" style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={isOpen} onClick={() => setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        })}><ChevronRight size={12} className={`branch-chevron ${isOpen ? "open" : ""}`} /><Folder size={13} /><span>{folders[depth]}</span></button>);
      }
      const hidden = folders.some((_, level) => collapsed.has(folders.slice(0, level + 1).join("/")));
      if (!hidden) rows.push(fileRow(file, folders.length, parts[parts.length - 1], "", index));
    });
    return rows;
  };

  return <div className="file-list">
    <div className="file-list-toolbar">
      <span>{counted(t, files.length, "file", "files")}</span>
      <div className="mode-toggle" role="group" aria-label={t("fileListMode")}>
        <button className={mode === "path" ? "active" : ""} aria-pressed={mode === "path"} onClick={() => setMode("path")} title={t("pathView")}><List size={13} /><span>{t("pathView")}</span></button>
        <button className={mode === "tree" ? "active" : ""} aria-pressed={mode === "tree"} onClick={() => setMode("tree")} title={t("treeView")}><ListTree size={13} /><span>{t("treeView")}</span></button>
      </div>
    </div>
    <div className="change-list">
      {mode === "path" ? sorted.map((file, index) => {
        const cut = file.path.lastIndexOf("/");
        return fileRow(file, 0, file.path.slice(cut + 1), cut >= 0 ? file.path.slice(0, cut + 1) : "", index);
      }) : tree()}
    </div>
  </div>;
}

/** The uncommitted work: what changed, and the form that turns it into a saved version. */
function ChangesView({ snapshot, message, generating, busy, onOpenFile, onMessageChange, onGenerate, onPrepare, merge, configured, stale, onReviewAgain, onMergeChange }: {
  snapshot: RepoSnapshot; message: string; generating: boolean; busy: boolean;
  onOpenFile: (file: FileChange) => void; onMessageChange: (message: string) => void; onGenerate: () => void; onPrepare: () => void;
  merge: boolean; configured: boolean; stale: boolean; onReviewAgain: () => void; onMergeChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const hasChanges = snapshot.changes.length > 0;
  const canMerge = snapshot.defaultBranch && snapshot.defaultBranch !== snapshot.currentBranch;
  return <div className="changes-view">
    <div className="detail-head"><span className="detail-kind"><PencilLine size={13} />{t("uncommittedHeading")}</span><span className="detail-branch" title={snapshot.currentBranch}><GitBranch size={12} />{snapshot.currentBranch}</span></div>
    {hasChanges ? <>
      <ChangeSummary files={snapshot.changes} />
      <FileList files={snapshot.changes} onOpen={onOpenFile} />
      <div className="commit-form">
        <div className="commit-form-heading"><h3>{t("saveDescription")}</h3><button className="outline-button small" onClick={onGenerate} disabled={!configured || generating || busy}>{generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{t(generating ? "generatingSaveDescription" : "generateDescription")}</button></div>
        <label htmlFor="commit-description" className="visually-hidden">{t("commitMessage")}</label><textarea id="commit-description" value={message} onChange={(event) => onMessageChange(event.target.value)} maxLength={120} rows={3} placeholder={t("commitPlaceholder")} disabled={generating || busy} />
        <div className="commit-form-meta"><span>{t(configured ? "editableDescription" : "manualSaveDescription")}</span><span>{message.length}/120</span></div>
        {canMerge && <label className="delivery-option"><input type="checkbox" checked={merge} disabled={busy} onChange={(event) => onMergeChange(event.target.checked)} /><span>{t("integrateAfterSave", { target: snapshot.defaultBranch! })}</span></label>}
        {stale && <div className="delivery-stale" role="alert">{t("filesChangedReview")} <button className="outline-button small" onClick={onReviewAgain}>{t("reviewUpdatedFiles")}</button></div>}
        <div className="commit-form-actions"><button className="primary-button" onClick={onPrepare} disabled={stale || !message.trim() || generating || busy}><ShieldCheck size={14} />{t(merge && canMerge ? "reviewSaveAndMerge" : "reviewSave")}</button></div>
        <p className="file-inclusion-note">{t("allFilesIncluded")}</p>
      </div>
    </> : <div className="graph-empty"><Check size={26} /><strong>{t("noUncommittedChanges")}</strong><span>{t("savedNextStep")}</span></div>}
  </div>;
}

/**
 * Everything about one commit without leaving the graph: its message, who wrote it and when, the
 * commits it continues, and every file it touched with how much. The full diff is one click away.
 */
function CommitInspector({ commit, snapshot, known, onFocus, onOpen }: {
  commit: Commit; snapshot: RepoSnapshot; known: Commit[]; onFocus: (commit: Commit) => void; onOpen: (file?: FileChange) => void;
}) {
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    window.gitcat.getCommitDetail(snapshot.path, commit.hash)
      .then((next) => { if (live) setDetail(next); })
      .catch((reason) => { if (live) setError(cleanError(reason, t("fallbackReadCommit"))); });
    return () => { live = false; };
  }, [snapshot.path, commit.hash]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const hash = detail?.hash ?? commit.hash;
  const body = detail?.body ?? commit.body;
  const chips = refChips(commit.refs, snapshot.remotes);
  const copy = () => { void navigator.clipboard?.writeText(hash).then(() => setCopied(true)).catch(() => undefined); };
  return <div className="commit-inspector">
    <div className="detail-head">
      <span className="detail-kind"><GitCommitHorizontal size={13} />commit</span>
      <code title={hash}>{hash.slice(0, 7)}</code>
      <button className="mini-icon" onClick={copy} aria-label={t("copyHash")} title={copied ? t("copied") : t("copyHash")}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
      <button className="ghost-button small" onClick={() => onOpen()} title={t("fullDiffTitle")}><Maximize2 size={13} />{t("fullDiff")}</button>
    </div>
    <div className="detail-message">
      <h3>{commit.subject || t("commitWithoutMessage")}</h3>
      {body && <p>{body}</p>}
    </div>
    <div className="detail-author">
      <Avatar name={commit.author} email={commit.email} size={34} />
      <div><strong>{commit.author || "—"}</strong><span title={formatDateFull(commit.date, locale)}>{t("authoredOn", { date: formatDate(commit.date, locale) })} · {relativeTime(commit.date, locale)}</span></div>
      {commit.parents.length > 0 && <div className="detail-parents"><span>{t(commit.parents.length > 1 ? "parentsLabel" : "parentLabel")}</span>{commit.parents.map((parent) => {
        const found = known.find((item) => item.hash === parent);
        return found
          ? <button key={parent} className="hash-link" onClick={() => onFocus(found)} title={found.subject}>{parent.slice(0, 7)}</button>
          : <code key={parent}>{parent.slice(0, 7)}</code>;
      })}</div>}
    </div>
    {chips.length > 0 && <div className="detail-refs">{chips.map((chip) => <span className={`ref-tag ${chip.kind}`} key={`${chip.kind}:${chip.label}`} title={chip.kind === "remote" ? `${chip.label} · ${t("remoteOnlyTitle")}` : chip.label}>
      {chip.kind === "tag" ? <Tag size={11} /> : chip.kind === "remote" ? <Cloud size={11} /> : <GitBranch size={11} />}{chip.label}
    </span>)}</div>}
    {commit.parents.length > 1 && <p className="detail-note"><GitMerge size={12} />{t("mergeDetails", { hash: commit.parents[0].slice(0, 7) })}</p>}
    {error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}
    {!detail && !error && <div className="graph-loading"><LoaderCircle className="spin" size={15} /> {t("readingChange")}</div>}
    {detail && <>
      <ChangeSummary files={detail.files} stats={detail.stats} />
      {detail.files.length ? <FileList files={detail.files} stats={detail.stats} onOpen={(file) => onOpen(file)} /> : <p className="detail-note">{t("commitTouchesNothing")}</p>}
    </>}
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
  const creating = dialog.operation === "create_branch" || dialog.operation === "rename_branch";
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
function ConflictProposalModal({ proposal, result, busy, onApply, onReviewAgain, onClose }: {
  proposal: ConflictProposal; result?: ConflictApplyResult; busy: boolean;
  onApply: (accepted: string[]) => void; onReviewAgain: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState<string[]>(() => proposal.resolutions.filter((item) => item.confidence === "high").map((item) => item.path));
  useEscape(onClose);
  const outcomeOf = (path: string) => result?.outcomes.find((outcome) => outcome.path === path);
  // A file that moved on since the review can never be written from this proposal; neither can any
  // file once the operation or the repository is not the one it was drafted for.
  const blocked = (path: string) => result?.stale === "operation" || result?.stale === "repository" || outcomeOf(path)?.status === "changed";
  const toggle = (path: string) => setAccepted((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const chosen = proposal.resolutions.filter((resolution) => accepted.includes(resolution.path) && !blocked(resolution.path));
  const applied = result?.outcomes.filter((outcome) => outcome.status === "applied") ?? [];
  const failed = result?.outcomes.find((outcome) => outcome.status === "failed");

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="commit-modal wide" role="dialog" aria-modal="true" aria-labelledby="proposal-title">
      <div className="modal-heading">
        <div><div className="eyebrow">{t("proposedResolution")}</div><h2 id="proposal-title">{t("reviewBeforeAccepting")}</h2></div>
        <button className="icon-button soft" onClick={onClose} aria-label={t("dismissProposal")}><X size={17} /></button>
      </div>
      {result
        ? <div className="modal-note attention" role="alert"><AlertTriangle size={15} /><div>
          {result.stale === "files" && <span>{t("proposalStaleFiles")}</span>}
          {result.stale === "operation" && <span>{t("proposalStaleOperation")}</span>}
          {result.stale === "repository" && <span>{t("proposalOtherRepository")}</span>}
          {!result.stale && applied.length > 0 && <span>{t("proposalPartlyApplied", { files: applied.map((outcome) => outcome.path).join(", ") })}</span>}
          {!result.stale && !applied.length && <span>{t("proposalNotApplied")}</span>}
          {failed && <span>{t(failed.restored ? "resolutionFailedRestored" : "resolutionFailedNotRestored", { path: failed.path })}{failed.detail ? ` (${failed.detail})` : ""}</span>}
          {result.outcomes.some((outcome) => outcome.status === "changed") && !failed && result.stale === undefined && <span>{t("proposalChangedDuringApply")}</span>}
          <button className="outline-button small" onClick={onReviewAgain} disabled={busy}><Sparkles size={13} /> {t("reviewConflictsAgain")}</button>
        </div></div>
        : <div className="modal-note"><ShieldCheck size={15} /><span>{t("nothingWritten")}</span></div>}
      {proposal.resolutions.map((resolution) => <div className={`resolution ${accepted.includes(resolution.path) && !blocked(resolution.path) ? "accepted" : ""}`} key={resolution.path}>
        <label className="resolution-heading">
          <input type="checkbox" checked={accepted.includes(resolution.path) && !blocked(resolution.path)} disabled={blocked(resolution.path)} onChange={() => toggle(resolution.path)} />
          <div>
            <strong>{resolution.path}</strong>
            <span>{resolution.rationale}</span>
          </div>
          {outcomeOf(resolution.path)?.status === "changed" && <span className="resolution-doubt">{t("changedSinceReview")}</span>}
          {outcomeOf(resolution.path)?.status === "failed" && <span className="resolution-doubt">{t("resolutionNotApplied")}</span>}
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
        <button className="primary-button" onClick={() => onApply(chosen.map((resolution) => resolution.path))} disabled={busy || !chosen.length}>
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
function CommitModal({ commit, initialFile, repoPath, onClose }: { commit: Commit; initialFile?: FileChange; repoPath: string; onClose: () => void }) {
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
    setSelectedFile(initialFile);
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

/**
 * A menu at the pointer. It closes on a click elsewhere, on Escape, on scroll or on resize, and the
 * arrow keys move between its entries, so it behaves like the menus of the rest of the system.
 */
function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuEntry[]; label: string; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);
  const walk = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return <div ref={menu} className="context-menu" role="menu" aria-label={label} style={position} onKeyDown={walk} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item) => "separator" in item ? <div key={item.key} className="menu-separator" role="separator" />
      : "heading" in item ? <div key={item.key} className="menu-heading" title={item.heading}>{item.heading}</div>
      : <button key={item.key} role="menuitem" title={item.hint} className={item.danger ? "danger" : ""} disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>
        <item.icon size={14} /><span>{item.label}</span>
      </button>)}
  </div>;
}
