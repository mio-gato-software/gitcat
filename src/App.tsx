import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bot, Check, ChevronDown, CircleDot,
  Clock3, Cloud, FileDiff, FolderOpen, GitBranch, GitCommitHorizontal, GitFork,
  GitMerge, LoaderCircle, Menu, MessageCircle, MoreHorizontal, Plus, RefreshCcw,
  Search, Send, Settings2, ShieldCheck, Sparkles, TerminalSquare, Trash2, UserRound, X
} from "lucide-react";
import type { ActionPlan, Branch, Commit, LlmConfig, RepoSnapshot } from "../shared/types";

type ProjectTab = { id: string; snapshot: RepoSnapshot; error?: string; loading?: boolean };
type ActivityItem = { id: number; label: string; detail: string; tone: "success" | "neutral" | "warning" };

const palette = ["#62d6c8", "#c59bff", "#f0b26e", "#7da7ff", "#ef7c95"];

function formatDate(date: string) {
  if (!date) return "ahora";
  const value = new Date(date);
  if (Number.isNaN(value.valueOf())) return date;
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);
}

function shortPath(path: string) {
  const pieces = path.split("/");
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
  const [refreshing, setRefreshing] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({ provider: "openai", model: "luna", configured: false });
  const [toast, setToast] = useState<string>();

  const active = projects.find((project) => project.id === activeId);
  const snapshot = active?.snapshot;

  useEffect(() => { window.branchline.getLlmConfig().then(setConfig).catch(() => undefined); }, []);

  const addActivity = (item: Omit<ActivityItem, "id">) => {
    setActivity((items) => [{ ...item, id: Date.now() }, ...items].slice(0, 6));
  };

  const openProject = async () => {
    try {
      const next = await window.branchline.selectProject();
      if (!next) return;
      const existing = projects.find((project) => project.snapshot.path === next.path);
      if (existing) { setActiveId(existing.id); return; }
      const id = `${next.path}-${Date.now()}`;
      setProjects((items) => [...items, { id, snapshot: next }]);
      setActiveId(id);
      addActivity({ label: "Proyecto abierto", detail: next.name, tone: "success" });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo abrir el proyecto.");
    }
  };

  const closeProject = (id: string) => {
    const remaining = projects.filter((project) => project.id !== id);
    setProjects(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id);
  };

  const refreshProject = async () => {
    if (!active) return;
    setRefreshing(true);
    try {
      const next = await window.branchline.getSnapshot(active.snapshot.path);
      setProjects((items) => items.map((project) => project.id === active.id ? { ...project, snapshot: next, error: undefined } : project));
      addActivity({ label: "Estado actualizado", detail: next.currentBranch, tone: "neutral" });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo actualizar el estado.");
    } finally { setRefreshing(false); }
  };

  const propose = async (text: string) => {
    if (!snapshot || planning || !text.trim()) return;
    setPlanning(true);
    setPendingPlan(null);
    setRequest(text);
    try {
      const plan = await window.branchline.planAction(snapshot.path, text);
      setPendingPlan(plan);
      addActivity({ label: plan.allowed ? "Plan preparado" : "Solicitud rechazada", detail: plan.summary, tone: plan.allowed ? "neutral" : "warning" });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo preparar la acción.");
    } finally { setPlanning(false); }
  };

  const applyPlan = async () => {
    if (!snapshot || !pendingPlan?.allowed) return;
    setPlanning(true);
    try {
      const result = await window.branchline.executePlan(snapshot.path, pendingPlan);
      setProjects((items) => items.map((project) => project.id === activeId ? { ...project, snapshot: result.snapshot, error: undefined } : project));
      addActivity({ label: "Acción ejecutada", detail: pendingPlan.command, tone: "success" });
      setToast(result.output || `${pendingPlan.summary} completado.`);
      setPendingPlan(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Git no pudo completar la acción.");
    } finally { setPlanning(false); }
  };

  const filteredBranches = useMemo(() => snapshot?.branches.filter((branch) => branch.name.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase())) ?? [], [snapshot, branchFilter]);
  const filteredCommits = useMemo(() => snapshot?.commits.filter((commit) => {
    const query = commitFilter.toLocaleLowerCase();
    return !query || commit.subject.toLocaleLowerCase().includes(query) || commit.author.toLocaleLowerCase().includes(query) || commit.shortHash.includes(query);
  }) ?? [], [snapshot, commitFilter]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><GitFork size={18} strokeWidth={2.4} /></div><span>branchline</span><span className="brand-beta">BETA</span></div>
        <div className="window-tabs">
          {projects.map((project) => <button key={project.id} className={`window-tab ${project.id === activeId ? "active" : ""}`} onClick={() => setActiveId(project.id)}>
            <GitBranch size={14} /><span>{project.snapshot.name}</span><X size={13} onClick={(event) => { event.stopPropagation(); closeProject(project.id); }} />
          </button>)}
          <button className="icon-button tab-add" onClick={openProject} aria-label="Abrir proyecto"><Plus size={16} /></button>
        </div>
        <div className="top-actions"><div className="sync-pill"><span className="pulse-dot" /> Local</div><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Configuración"><Settings2 size={17} /></button><div className="avatar"><UserRound size={15} /></div></div>
      </header>

      {!snapshot ? <Welcome openProject={openProject} configured={config.configured} /> : <>
        <div className="workspace-header">
          <div className="project-title"><div className="folder-icon"><FolderOpen size={17} /></div><div><div className="eyebrow">PROYECTO ACTIVO</div><div className="project-name">{snapshot.name}<span className="project-path">{shortPath(snapshot.path)}</span></div></div></div>
          <div className="workspace-actions"><button className="ghost-button" onClick={refreshProject} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />} Actualizar</button><button className="outline-button" onClick={() => propose("actualizar las referencias remotas")}><ArrowDownToLine size={15} /> Fetch</button><button className="primary-button" onClick={() => propose("publicar los cambios de la rama actual")}><ArrowUpFromLine size={15} /> Push</button></div>
        </div>

        <main className="main-layout">
          <aside className="sidebar">
            <div className="sidebar-section branch-section"><div className="section-heading"><span>RAMAS</span><button className="mini-icon" onClick={() => propose("crear una rama nueva llamada feature/mi-rama")}><Plus size={14} /></button></div><div className="search-field"><Search size={14} /><input value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} placeholder="Filtrar ramas" /></div><div className="branch-list">
              {filteredBranches.map((branch, index) => <BranchRow branch={branch} index={index} key={branch.name} onClick={() => propose(`cambiar a la rama ${branch.name}`)} />)}
              {!filteredBranches.length && <div className="empty-small">No hay ramas que coincidan.</div>}
            </div></div>
            <div className="sidebar-section"><div className="section-heading"><span>REMOTOS</span><button className="mini-icon"><MoreHorizontal size={14} /></button></div>{snapshot.remotes.length ? snapshot.remotes.map((remote) => <div className="remote-row" key={remote}><Cloud size={14} /><span>{remote}</span><span className="remote-count">conectado</span></div>) : <div className="empty-small">Sin remotos configurados.</div>}</div>
            <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={15} /><span>Acciones protegidas<br /><small>Git se ejecuta con una lista segura.</small></span></div><button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> Configuración LLM <ChevronDown size={13} /></button></div>
          </aside>

          <section className="graph-area">
            <div className="graph-toolbar"><div className="view-tabs"><button className="view-tab active">Historial</button><button className="view-tab">Cambios <span className="count-badge">{snapshot.changes.length}</span></button></div><div className="graph-tools"><div className="search-field commit-search"><Search size={14} /><input value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} placeholder="Buscar commits" /></div><button className="icon-button soft"><Menu size={16} /></button></div></div>
            {snapshot.isRebasing && <div className="rebase-banner"><AlertTriangle size={16} /><div><strong>Rebase en curso</strong><span>Resuelve los conflictos y continúa desde el asistente.</span></div><button className="outline-button small" onClick={() => propose("continuar el rebase después de resolver conflictos")}>Continuar</button><button className="danger-link" onClick={() => propose("abortar el rebase en curso")}>Abortar</button></div>}
            <div className="current-branch-card"><div className="branch-dot" style={{ background: branchColor(0) }} /><div><span className="eyebrow">RAMA ACTUAL</span><div className="current-branch-name">{snapshot.currentBranch}<span className="branch-status">{snapshot.isDirty ? "Cambios sin guardar" : "Limpia"}</span></div></div><div className="branch-stats"><span><ArrowDownToLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.behind ?? 0} detrás</span><span><ArrowUpFromLine size={13} />{snapshot.branches.find((branch) => branch.isCurrent)?.ahead ?? 0} adelante</span></div><button className="more-button"><MoreHorizontal size={17} /></button></div>
            <div className="graph-scroll"><div className="graph-header"><span>HISTORIAL DE COMMITS</span><span>{filteredCommits.length} commits visibles</span></div>{filteredCommits.length ? filteredCommits.map((commit, index) => <CommitRow commit={commit} index={index} key={commit.hash} onAction={propose} />) : <div className="graph-empty"><GitCommitHorizontal size={26} /><strong>No hay commits que mostrar</strong><span>El repositorio todavía no tiene historial o el filtro no coincide.</span></div>}</div>
          </section>

          <aside className="inspector"><div className="inspector-header"><div><div className="eyebrow">ASISTENTE DE RAMAS</div><h2>¿Qué quieres hacer?</h2></div><div className="assistant-icon"><Bot size={18} /></div></div><p className="assistant-copy">Describe una acción de Git en lenguaje natural. Prepararé el comando y te pediré confirmación cuando sea necesario.</p><div className="suggestion-list"><button onClick={() => propose("¿Quién hizo cambios recientemente?")}><UsersIcon /><span>¿Quién hizo cambios recientemente?</span></button><button onClick={() => propose("rebasear mi rama sobre main")}><GitMerge size={15} /><span>Rebasear sobre main</span></button><button onClick={() => propose("mostrar el estado actual")}><TerminalSquare size={15} /><span>Ver estado del repositorio</span></button></div><div className="chat-compose"><textarea value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void propose(request); } }} placeholder="Ej. cambia a feature/login y dime qué falta…" rows={3} /><button className="send-button" onClick={() => void propose(request)} disabled={planning || !request.trim()}>{planning ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div>{pendingPlan && <PlanCard plan={pendingPlan} onApply={applyPlan} onDismiss={() => setPendingPlan(null)} busy={planning} />}</aside>
        </main>
        <footer className="statusbar"><div className="status-left"><span className="status-good"><CircleDot size={12} /> {snapshot.isDirty ? `${snapshot.changes.length} cambio${snapshot.changes.length === 1 ? "" : "s"}` : "Sin cambios locales"}</span><span className="status-separator" /> <span>{snapshot.branches.length} ramas locales</span></div><div className="status-right"><span><Clock3 size={12} /> Última lectura {formatDate(new Date().toISOString())}</span><span className="provider-status"><Sparkles size={12} /> {config.configured ? `${config.provider} · ${config.model}` : "LLM no configurado"}</span></div></footer>
      </>}
      {activity.length > 0 && <div className="activity-dock">{activity.slice(0, 3).map((item) => <div className={`activity-item ${item.tone}`} key={item.id}><span className="activity-symbol">{item.tone === "success" ? <Check size={13} /> : item.tone === "warning" ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={13} />}</span><div><strong>{item.label}</strong><span>{item.detail}</span></div></div>)}</div>}
      {toast && <div className="toast"><Check size={15} /><span>{toast}</span><button onClick={() => setToast(undefined)}><X size={14} /></button></div>}
      {settingsOpen && <SettingsModal config={config} onClose={() => setSettingsOpen(false)} onSaved={(next) => { setConfig(next); setSettingsOpen(false); setToast("Configuración guardada."); }} />}
    </div>
  );
}

function Welcome({ openProject, configured }: { openProject: () => Promise<void>; configured: boolean }) {
  return <div className="welcome"><div className="welcome-glow" /><div className="welcome-card"><div className="welcome-mark"><GitFork size={30} /></div><div className="eyebrow">WORKSPACE DE RAMAS</div><h1>Tu Git, más claro.</h1><p>Abre un proyecto para explorar ramas, entender quién cambió qué y preparar operaciones Git con ayuda de tu proveedor LLM.</p><button className="primary-button welcome-button" onClick={() => void openProject()}><FolderOpen size={16} /> Abrir proyecto</button><div className="welcome-features"><span><GitMerge size={14} /> Rebase seguro</span><span><MessageCircle size={14} /> Lenguaje natural</span><span><ShieldCheck size={14} /> Comandos protegidos</span></div><div className="welcome-footnote">{configured ? "Proveedor LLM configurado" : "Configura OpenAI/Luna desde el engranaje superior"}</div></div></div>;
}

function BranchRow({ branch, index, onClick }: { branch: Branch; index: number; onClick: () => void }) {
  return <button className={`branch-row ${branch.isCurrent ? "current" : ""}`} onClick={onClick}><span className="branch-color" style={{ background: branchColor(index) }} /><GitBranch size={14} /><span className="branch-label">{branch.name}</span>{branch.isCurrent && <span className="current-pill">actual</span>}{(branch.ahead > 0 || branch.behind > 0) && <span className="ahead-behind">{branch.ahead > 0 ? `↑${branch.ahead}` : ""}{branch.behind > 0 ? ` ↓${branch.behind}` : ""}</span>}</button>;
}

function CommitRow({ commit, index, onAction }: { commit: Commit; index: number; onAction: (text: string) => void }) {
  return <div className="commit-row"><div className="graph-track"><span className="track-line" /><span className="commit-node" style={{ borderColor: branchColor(index), boxShadow: `0 0 0 4px ${branchColor(index)}18` }} /></div><div className="commit-content"><div className="commit-main"><div className="commit-subject">{commit.subject || "Commit sin mensaje"}</div><div className="commit-meta"><span className="hash-chip">{commit.shortHash}</span><span>{commit.author}</span><span className="meta-divider">·</span><span>{formatDate(commit.date)}</span></div></div><div className="commit-refs">{commit.refs.slice(0, 3).map((ref) => <span className="ref-tag" key={ref}><GitBranch size={11} />{ref.replace("HEAD -> ", "")}</span>)}</div><button className="commit-more" onClick={() => onAction(`mostrar detalles del commit ${commit.shortHash}`)}><MoreHorizontal size={16} /></button></div></div>;
}

function PlanCard({ plan, onApply, onDismiss, busy }: { plan: ActionPlan; onApply: () => Promise<void>; onDismiss: () => void; busy: boolean }) {
  return <div className={`plan-card ${plan.allowed ? "allowed" : "rejected"}`}><div className="plan-header"><div className="plan-icon">{plan.allowed ? <Sparkles size={15} /> : <AlertTriangle size={15} />}</div><div><strong>{plan.summary}</strong><span>{plan.source === "llm" ? "Interpretado por el proveedor LLM" : plan.source === "local-fallback" ? "Modo local · configura un LLM para interpretar mejor" : "Regla de alcance"}</span></div><button className="mini-icon" onClick={onDismiss}><X size={14} /></button></div><p>{plan.rationale}</p>{plan.allowed && <div className="command-preview"><TerminalSquare size={14} /><code>{plan.command}</code></div>}{plan.allowed ? <div className="plan-actions"><button className="ghost-button" onClick={onDismiss}>Cancelar</button><button className="primary-button" onClick={() => void onApply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {plan.requiresConfirmation ? "Confirmar acción" : "Aplicar"}</button></div> : <button className="ghost-button plan-close" onClick={onDismiss}>Entendido</button>}</div>;
}

function SettingsModal({ config, onClose, onSaved }: { config: LlmConfig; onClose: () => void; onSaved: (config: LlmConfig) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config.model || "luna");
  const [saving, setSaving] = useState(false);
  const save = async () => { setSaving(true); try { onSaved(await window.branchline.saveLlmConfig({ apiKey, model })); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal"><div className="modal-heading"><div><div className="eyebrow">PROVEEDOR LLM</div><h2>Configuración</h2></div><button className="icon-button soft" onClick={onClose}><X size={17} /></button></div><div className="provider-card"><div className="provider-logo">◉</div><div><strong>OpenAI</strong><span>Responses API · API key local</span></div><span className={`connected-dot ${config.configured ? "on" : ""}`} /></div><label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.configured ? "Guardada de forma segura · escribe para reemplazar" : "sk-…"} autoComplete="off" /></label><label>Modelo<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="luna" /><small>Se envía como identificador de modelo a OpenAI. Usa el nombre habilitado en tu proyecto.</small></label><div className="modal-note"><ShieldCheck size={15} /><span>La key se cifra con el almacenamiento seguro del sistema y nunca se expone a la interfaz.</span></div><div className="modal-actions"><button className="ghost-button" onClick={onClose}>Cancelar</button><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Guardar</button></div></div></div>;
}

function UsersIcon() { return <UserRound size={15} />; }
