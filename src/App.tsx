import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bot, Check, ChevronDown, CircleDot,
  Clock3, Cloud, FileDiff, FolderOpen, GitBranch, GitCommitHorizontal, GitFork,
  GitMerge, Info, LoaderCircle, MessageCircle, Plus, RefreshCcw, Search, Send,
  Settings2, ShieldCheck, Sparkles, TerminalSquare, Trash2, UserRound, X
} from "lucide-react";
import type { ActionPlan, Branch, Commit, LlmConfig, Operation, RepoSnapshot } from "../shared/types";

type ProjectTab = { id: string; snapshot: RepoSnapshot; loadedAt: string };
type ActivityItem = { id: number; label: string; detail: string; tone: "success" | "neutral" | "warning" };
type Toast = { message: string; tone: "success" | "error" };
type InputDialog = { operation: "create_branch" | "commit" | "merge"; title: string; label: string; value: string };

const palette = ["#62d6c8", "#c59bff", "#f0b26e", "#7da7ff", "#ef7c95"];

function formatDate(date: string) {
  if (!date) return "ahora";
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);
}

function shortPath(path: string) {
  const pieces = path.split(/[\\/]/);
  return pieces.length > 3 ? `…/${pieces.slice(-2).join("/")}` : path;
}

function branchColor(index: number) { return palette[index % palette.length]; }

export default function App() {
  const [projects, setProjects] = useState<ProjectTab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [branchFilter, setBranchFilter] = useState("");
  const [commitFilter, setCommitFilter] = useState("");
  const [request, setRequest] = useState("");
  const [pendingPlan, setPendingPlan] = useState<ActionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [refreshingPath, setRefreshingPath] = useState<string>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({ provider: "openai", model: "luna", configured: false });
  const [toast, setToast] = useState<Toast>();
  const [view, setView] = useState<"history" | "changes">("history");
  const [selectedCommit, setSelectedCommit] = useState<Commit>();
  const [assistantResult, setAssistantResult] = useState<string>();
  const [inputDialog, setInputDialog] = useState<InputDialog>();
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const requestSequence = useRef(0);
  const activitySequence = useRef(0);
  const activityTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const workspaceRestored = useRef(false);

  const active = projects.find((project) => project.id === activeId);
  const snapshot = active?.snapshot;

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
    setPendingPlan(null);
    setAssistantResult(undefined);
    setRequest("");
    setBranchFilter("");
    setCommitFilter("");
    setView("history");
    setPlanning(false);
  }, [activeId]);

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
    setPendingPlan(null);
    try {
      const next = await window.branchline.getSnapshot(path);
      updateSnapshot(path, next);
      if (announce) addActivity({ label: "Estado actualizado", detail: next.currentBranch, tone: "neutral" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "No se pudo actualizar el estado.", tone: "error" });
    } finally { setRefreshingPath(undefined); }
  };

  const showPlan = async (loader: () => Promise<ActionPlan>) => {
    if (!snapshot || planning) return;
    const sequence = ++requestSequence.current;
    const repoPath = snapshot.path;
    setPlanning(true);
    setPendingPlan(null);
    setAssistantResult(undefined);
    try {
      const plan = await loader();
      if (sequence !== requestSequence.current || plan.repoPath !== repoPath) return;
      if (plan.answer) {
        setAssistantResult(plan.answer);
        setPendingPlan(null);
        addActivity({ label: "Respuesta preparada", detail: plan.summary, tone: "neutral" });
        return;
      }
      setPendingPlan(plan);
      addActivity({ label: plan.allowed ? "Plan preparado" : "Solicitud rechazada", detail: plan.summary, tone: plan.allowed ? "neutral" : "warning" });
    } catch (error) {
      if (sequence === requestSequence.current) setToast({ message: error instanceof Error ? error.message : "No se pudo preparar la acción.", tone: "error" });
    } finally {
      if (sequence === requestSequence.current) setPlanning(false);
    }
  };

  const propose = async (text: string) => {
    if (!snapshot || !text.trim()) return;
    setRequest(text);
    await showPlan(() => window.branchline.planAction(snapshot.path, text));
  };

  const prepare = async (operation: Operation, args: Record<string, string> = {}) => {
    if (!snapshot) return;
    await showPlan(() => window.branchline.prepareOperation(snapshot.path, operation, args));
  };

  const applyPlan = async () => {
    if (!pendingPlan?.allowed || planning) return;
    const plan = pendingPlan;
    setPlanning(true);
    try {
      const result = await window.branchline.executePlan(plan.repoPath, plan.id);
      updateSnapshot(plan.repoPath, result.snapshot);
      setPendingPlan(null);
      if (result.error) {
        addActivity({ label: "Git requiere atención", detail: result.error, tone: "warning" });
        setToast({ message: result.error, tone: "error" });
      } else {
        addActivity({ label: "Acción ejecutada", detail: plan.command, tone: "success" });
        setToast({ message: result.output || `${plan.summary} completado.`, tone: "success" });
      }
    } catch (error) {
      setPendingPlan(null);
      setToast({ message: error instanceof Error ? error.message : "Git no pudo completar la acción.", tone: "error" });
      await refreshProject(plan.repoPath, false);
    } finally { setPlanning(false); }
  };

  const submitInputDialog = () => {
    if (!inputDialog?.value.trim()) return;
    const args: Record<string, string> = inputDialog.operation === "commit" ? { message: inputDialog.value.trim() }
      : inputDialog.operation === "merge" ? { name: inputDialog.value.trim() }
      : { name: inputDialog.value.trim() };
    const operation = inputDialog.operation;
    setInputDialog(undefined);
    void prepare(operation, args);
  };

  const showRecentAuthors = () => {
    if (!snapshot) return;
    const counts = new Map<string, number>();
    snapshot.commits.slice(0, 30).forEach((commit) => counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1));
    const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([author, count]) => `${author}: ${count}`).join(" · ");
    setAssistantResult(summary || "No hay commits recientes que analizar.");
    setPendingPlan(null);
  };

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

      {!workspaceReady ? <div className="workspace-loading"><LoaderCircle className="spin" size={24} /><span>Restaurando proyectos…</span></div> : !snapshot ? <Welcome openProject={openProject} configured={config.configured} /> : <>
        <div className="workspace-header">
          <div className="project-title"><div className="folder-icon"><FolderOpen size={17} /></div><div><div className="eyebrow">PROYECTO ACTIVO</div><div className="project-name">{snapshot.name}<span className="project-path" title={snapshot.path}>{shortPath(snapshot.path)}</span></div></div></div>
          <div className="workspace-actions"><button className="ghost-button" onClick={() => void refreshProject()} disabled={Boolean(refreshingPath)}>{refreshingPath === snapshot.path ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />} Actualizar</button><button className="outline-button" onClick={() => void prepare("fetch")} disabled={planning}><ArrowDownToLine size={15} /> Fetch</button><button className="primary-button" onClick={() => void prepare("push")} disabled={planning}><ArrowUpFromLine size={15} /> Push</button></div>
        </div>

        <main className="main-layout">
          <aside className="sidebar">
            <div className="sidebar-section branch-section"><div className="section-heading"><span>RAMAS</span><button className="mini-icon" onClick={() => setInputDialog({ operation: "create_branch", title: "Nueva rama", label: "Nombre de la rama", value: "" })} aria-label="Crear rama"><Plus size={14} /></button></div><div className="search-field"><Search size={14} /><input aria-label="Filtrar ramas" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} placeholder="Filtrar ramas" /></div><div className="branch-list">
              {filteredBranches.map((branch, index) => <BranchRow branch={branch} index={index} key={branch.name} busy={planning} onSwitch={() => void prepare("checkout", { name: branch.name })} onDelete={() => void prepare("delete_branch", { name: branch.name })} />)}
              {!filteredBranches.length && <div className="empty-small">No hay ramas que coincidan.</div>}
            </div></div>
            <div className="sidebar-section"><div className="section-heading"><span>REMOTOS</span><button className="mini-icon" onClick={() => void prepare("fetch")} aria-label="Actualizar remotos" disabled={planning}><RefreshCcw size={13} /></button></div>{snapshot.remotes.length ? snapshot.remotes.map((remote) => <div className="remote-row" key={remote}><Cloud size={14} /><span>{remote}</span><span className="remote-count">configurado</span></div>) : <div className="empty-small">Sin remotos configurados.</div>}</div>
            <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={15} /><span>Acciones protegidas<br /><small>Git se ejecuta con una lista segura.</small></span></div><button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> Configuración LLM <ChevronDown size={13} /></button></div>
          </aside>

          <section className="graph-area">
            <div className="graph-toolbar"><div className="view-tabs"><button className={`view-tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>Historial</button><button className={`view-tab ${view === "changes" ? "active" : ""}`} onClick={() => setView("changes")}>Cambios <span className="count-badge">{snapshot.changes.length}</span></button></div>{view === "history" && <div className="graph-tools"><div className="search-field commit-search"><Search size={14} /><input aria-label="Buscar commits" value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} placeholder="Buscar commits" /></div></div>}</div>
            {snapshot.isRebasing && <div className="rebase-banner"><AlertTriangle size={16} /><div><strong>Rebase en curso</strong><span>Resuelve los conflictos y elige cómo continuar.</span></div><button className="outline-button small" onClick={() => void prepare("continue_rebase")}>Continuar</button><button className="danger-link" onClick={() => void prepare("abort_rebase")}>Abortar</button></div>}
            <div className="current-branch-card"><div className="branch-dot" style={{ background: branchColor(0) }} /><div><span className="eyebrow">RAMA ACTUAL</span><div className="current-branch-name">{snapshot.currentBranch}<span className="branch-status">{snapshot.isDirty ? "Cambios locales" : "Limpia"}</span></div></div><div className="branch-stats"><span><ArrowDownToLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.behind ?? 0} detrás</span><span><ArrowUpFromLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.ahead ?? 0} adelante</span></div><button className="outline-button small" onClick={() => setInputDialog({ operation: "commit", title: "Crear commit", label: "Mensaje del commit", value: "" })} disabled={!snapshot.isDirty || planning}><GitCommitHorizontal size={14} /> Commit</button></div>
            {view === "history" ? <div className="graph-scroll"><div className="graph-header"><span>HISTORIAL DE COMMITS</span><span>{filteredCommits.length} commits visibles</span></div>{filteredCommits.length ? filteredCommits.map((commit, index) => <CommitRow commit={commit} index={index} key={commit.hash} onSelect={() => setSelectedCommit(commit)} />) : <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>No hay commits que mostrar</strong><span>El repositorio todavía no tiene historial o el filtro no coincide.</span></div>}</div>
              : <ChangesView snapshot={snapshot} />}
          </section>

          <aside className="inspector"><div className="inspector-header"><div><div className="eyebrow">ASISTENTE DE RAMAS</div><h2>¿Qué quieres saber o hacer?</h2></div><div className="assistant-icon"><Bot size={18} /></div></div><p className="assistant-copy">Pregunta sobre el repositorio o describe una acción de Git. Las acciones se muestran como un plan verificable antes de ejecutarse.</p><div className="suggestion-list"><button onClick={showRecentAuthors}><UserRound size={15} /><span>¿Quién hizo cambios recientemente?</span></button><button onClick={() => setInputDialog({ operation: "merge", title: "Fusionar rama", label: "Rama que quieres fusionar", value: "" })}><GitMerge size={15} /><span>Fusionar otra rama</span></button><button onClick={() => { setView("changes"); setAssistantResult(`${snapshot.changes.length} cambio${snapshot.changes.length === 1 ? "" : "s"} local${snapshot.changes.length === 1 ? "" : "es"}.`); }}><FileDiff size={15} /><span>Ver cambios del repositorio</span></button></div>{assistantResult && <div className="assistant-result"><Info size={15} /><span>{assistantResult}</span><button onClick={() => setAssistantResult(undefined)} aria-label="Cerrar resultado"><X size={13} /></button></div>}<div className="chat-compose"><textarea aria-label="Solicitud para el asistente" value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder="Ej. ¿quién trabajó en esta rama la última vez?" rows={3} /><button className="send-button" aria-label="Preparar solicitud" onClick={() => void propose(request)} disabled={planning || !request.trim()}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div>{pendingPlan && pendingPlan.repoPath === snapshot.path && <PlanCard plan={pendingPlan} onApply={applyPlan} onDismiss={() => setPendingPlan(null)} busy={planning} />}</aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className="status-good"><CircleDot size={12} /> {snapshot.isDirty ? `${snapshot.changes.length} cambio${snapshot.changes.length === 1 ? "" : "s"}` : "Sin cambios locales"}</span><span className="status-separator" /><span>{snapshot.branches.length} ramas locales</span></div><div className="status-right"><span><Clock3 size={12} /> Última lectura {formatDate(active.loadedAt)}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : "LLM no configurado"}</span></div></footer>
      </>}
      {activity.length > 0 && <div className="activity-dock" aria-live="polite">{activity.slice(0, 3).map((item) => <div className={`activity-item ${item.tone}`} role={item.tone === "warning" ? "alert" : "status"} key={item.id}><span className="activity-symbol">{item.tone === "success" ? <Check size={13} /> : item.tone === "warning" ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={13} />}</span><div className="activity-copy"><strong>{item.label}</strong><span title={item.detail}>{item.detail}</span></div><button className="activity-close" onClick={() => dismissActivity(item.id)} aria-label={`Cerrar notificación: ${item.label}`}><X size={14} /></button></div>)}</div>}
      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{toast.message}</span><button onClick={() => setToast(undefined)} aria-label="Cerrar notificación"><X size={14} /></button></div>}
      {settingsOpen && <SettingsModal config={config} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); setToast({ message: "Configuración guardada.", tone: "success" }); }} />}
      {inputDialog && <InputModal dialog={inputDialog} branches={snapshot?.branches ?? []} onChange={(value) => setInputDialog({ ...inputDialog, value })} onClose={() => setInputDialog(undefined)} onSubmit={submitInputDialog} />}
      {selectedCommit && <CommitModal commit={selectedCommit} onClose={() => setSelectedCommit(undefined)} />}
    </div>
  );
}

function Welcome({ openProject, configured }: { openProject: () => Promise<void>; configured: boolean }) {
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><GitFork size={30} /></div><div className="eyebrow">WORKSPACE DE RAMAS</div><h1>Tu Git, más claro.</h1><p>Abre un proyecto para explorar ramas, entender quién cambió qué y preparar operaciones Git con ayuda de tu proveedor LLM.</p><button className="primary-button welcome-button" onClick={() => void openProject()}><FolderOpen size={16} /> Abrir proyecto</button><div className="welcome-features"><span><GitMerge size={14} /> Rebase seguro</span><span><MessageCircle size={14} /> Lenguaje natural</span><span><ShieldCheck size={14} /> Comandos protegidos</span></div><div className="welcome-footnote">{configured ? "Proveedor LLM configurado" : "Configura OpenAI desde el engranaje superior"}</div></div></div>;
}

function BranchRow({ branch, index, busy, onSwitch, onDelete }: { branch: Branch; index: number; busy: boolean; onSwitch: () => void; onDelete: () => void }) {
  return <div className={`branch-row ${branch.isCurrent ? "current" : ""}`}><button className="branch-main" onClick={onSwitch} disabled={branch.isCurrent || busy} aria-current={branch.isCurrent}><span className="branch-color" style={{ background: branchColor(index) }} /><GitBranch size={14} /><span className="branch-label">{branch.name}</span>{branch.isCurrent && <span className="current-pill">actual</span>}{(branch.ahead > 0 || branch.behind > 0) && <span className="ahead-behind">{branch.ahead > 0 ? `↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}</button>{!branch.isCurrent && <button className="branch-delete" onClick={onDelete} disabled={busy} aria-label={`Eliminar rama ${branch.name}`}><Trash2 size={12} /></button>}</div>;
}

function CommitRow({ commit, index, onSelect }: { commit: Commit; index: number; onSelect: () => void }) {
  return <div className="commit-row"><div className="graph-track"><span className="track-line" /><span className="commit-node" style={{ borderColor: branchColor(index), boxShadow: `0 0 0 4px ${branchColor(index)}18` }} /></div><div className="commit-content"><div className="commit-main"><div className="commit-subject">{commit.subject || "Commit sin mensaje"}</div><div className="commit-meta"><span className="hash-chip">{commit.shortHash}</span><span>{commit.author}</span><span className="meta-divider">·</span><span>{formatDate(commit.date)}</span></div></div><div className="commit-refs">{commit.refs.slice(0, 3).map((ref) => <span className="ref-tag" key={ref}><GitBranch size={11} />{ref.replace("HEAD -> ", "")}</span>)}</div><button className="commit-more" onClick={onSelect} aria-label={`Ver detalles del commit ${commit.shortHash}`}><Info size={15} /></button></div></div>;
}

function ChangesView({ snapshot }: { snapshot: RepoSnapshot }) {
  return <div className="changes-view"><div className="changes-heading"><div><span className="eyebrow">ÁRBOL DE TRABAJO</span><h3>{snapshot.changes.length ? `${snapshot.changes.length} cambios locales` : "Todo está limpio"}</h3></div><FileDiff size={19} /></div>{snapshot.changes.length ? <div className="change-list">{snapshot.changes.map((change, index) => <div className="change-row" key={`${change.path}-${index}`}><span className={`change-code code-${change.code[0]?.toLowerCase()}`}>{change.code}</span><span title={change.path}>{change.path}</span></div>)}</div> : <div className="graph-empty"><Check size={26} /><strong>No hay cambios sin confirmar</strong><span>El árbol de trabajo coincide con el último commit.</span></div>}</div>;
}

function PlanCard({ plan, onApply, onDismiss, busy }: { plan: ActionPlan; onApply: () => Promise<void>; onDismiss: () => void; busy: boolean }) {
  return <div className={`plan-card ${plan.allowed ? "allowed" : "rejected"}`}><div className="plan-header"><div className="plan-icon">{plan.allowed ? <Sparkles size={15} /> : <AlertTriangle size={15} />}</div><div><strong>{plan.summary}</strong><span>{plan.source === "llm" ? "Interpretado por el proveedor LLM" : plan.source === "local-fallback" ? "Plan local validado" : "Regla de alcance"}</span></div><button className="mini-icon" onClick={onDismiss} aria-label="Descartar plan"><X size={14} /></button></div><p>{plan.rationale}</p>{plan.allowed && <div className="command-preview"><TerminalSquare size={14} /><code>{plan.command}</code></div>}{plan.allowed ? <div className="plan-actions"><button className="ghost-button" onClick={onDismiss}>Cancelar</button><button className="primary-button" onClick={() => void onApply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {plan.requiresConfirmation ? "Confirmar acción" : "Aplicar"}</button></div> : <button className="ghost-button plan-close" onClick={onDismiss}>Entendido</button>}</div>;
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
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><div className="eyebrow">PROVEEDOR LLM</div><h2 id="settings-title">Configuración</h2></div><button className="icon-button soft" onClick={onClose} aria-label="Cerrar configuración"><X size={17} /></button></div><div className="provider-card"><div className="provider-logo">AI</div><div><strong>OpenAI</strong><span>Responses API · API key local</span></div><span className={`connected-dot ${config.configured ? "on" : ""}`} /></div><label>API key<input autoFocus type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={config.configured ? "Guardada de forma segura · escribe para reemplazar" : "sk-…"} autoComplete="off" /></label>{config.configured && <label className="checkbox-label"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /> Eliminar la API key guardada</label>}<label>Modelo<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Identificador del modelo" /><small>Usa el identificador de un modelo habilitado en tu proyecto de OpenAI.</small></label><div className="modal-note"><ShieldCheck size={15} /><span>La key se cifra con el almacenamiento seguro del sistema y nunca se expone de nuevo a la interfaz.</span></div>{error && <div className="modal-error" role="alert"><AlertTriangle size={14} />{error}</div>}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Guardar</button></div></div></div>;
}

function InputModal({ dialog, branches, onChange, onClose, onSubmit }: { dialog: InputDialog; branches: Branch[]; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  useEscape(onClose);
  const listId = dialog.operation === "merge" ? "branch-options" : undefined;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="input-modal" role="dialog" aria-modal="true" aria-labelledby="input-modal-title" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><div className="modal-heading"><div><div className="eyebrow">OPERACIÓN GIT</div><h2 id="input-modal-title">{dialog.title}</h2></div><button type="button" className="icon-button soft" onClick={onClose} aria-label="Cerrar"><X size={17} /></button></div><label>{dialog.label}<input autoFocus value={dialog.value} onChange={(event) => onChange(event.target.value)} list={listId} maxLength={dialog.operation === "commit" ? 120 : 200} /></label>{listId && <datalist id={listId}>{branches.filter((branch) => !branch.isCurrent).map((branch) => <option value={branch.name} key={branch.name} />)}</datalist>}<div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={!dialog.value.trim()}>{dialog.operation === "commit" ? <GitCommitHorizontal size={14} /> : <GitBranch size={14} />} Preparar</button></div></form></div>;
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
