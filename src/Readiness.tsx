import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, Cloud, CircleDashed, ExternalLink, LoaderCircle, RefreshCcw, TerminalSquare, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AuthorReadiness, ConfigScope, HelpPage, IdentityValues, ReadinessReport } from "../shared/types";
import type { MessageKey, Translate } from "./i18n";

/**
 * The readiness checklist: Git, who saves are attributed to, and where a publish goes with the access
 * this Mac has. It only shows what the main process read; every way on is an existing, confirmable
 * path (the identity review, connecting a remote) or plain guidance for Terminal, never a change made
 * here. Checking again is always safe because checking never changes anything.
 */

export type ReadinessActions = {
  onSetIdentity?: () => void;
  onConnectRemote?: () => void;
  onOpenPage: (page: HelpPage) => void;
};

export const ReadinessActionsContext = createContext<ReadinessActions>({ onOpenPage: () => undefined });

export type ReadinessItem = "git" | "author" | "remote";

export type ReadinessState = {
  report?: ReadinessReport;
  loading: boolean;
  error?: string;
  /** Reads everything again; with `access`, the remote is contacted too. */
  recheck: (access?: boolean) => Promise<void>;
};

/** Reads readiness for a repository (or for this Mac when there is none), again whenever `key` changes. */
export function useReadiness(path: string | undefined, { access = false, remote, key, enabled = true }: { access?: boolean; remote?: string; key?: unknown; enabled?: boolean } = {}): ReadinessState {
  const [state, setState] = useState<{ path?: string; report?: ReadinessReport }>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const recheck = useCallback(async (withAccess: boolean = access) => {
    const id = ++sequence.current;
    setLoading(true); setError(undefined);
    try {
      const report = await window.gitcat.checkReadiness(path, { ...(remote ? { remote } : {}), access: withAccess });
      if (id === sequence.current) setState({ path, report });
    } catch (reason) {
      if (id === sequence.current) setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(reason));
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }, [path, remote, access]);
  useEffect(() => { if (enabled) void recheck(); }, [recheck, key, enabled]);
  // Git installed or an identity set from Terminal shows up when the window comes back. Only the local
  // read repeats on its own; contacting the remote again stays the person's click.
  useEffect(() => {
    if (!enabled || access) return;
    const onFocus = () => void recheck(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [recheck, enabled, access]);
  // A report read for another project is never shown for this one.
  return { report: state.path === path ? state.report : undefined, loading, error, recheck };
}

export function identityText(values: IdentityValues) {
  return values.name || values.email ? `${values.name ?? "—"} <${values.email ?? "—"}>` : "";
}

function scopeText(scope: ConfigScope, t: Translate) {
  return t(`readinessScope_${scope}` as MessageKey);
}

/** Where the name and email come from, in words: one place, or two when they differ. */
export function authorOrigin(author: AuthorReadiness, t: Translate) {
  if (!author.name || !author.email) return "";
  return author.name.scope === author.email.scope
    ? scopeText(author.name.scope, t)
    : t("readinessScopeMixed", { name: scopeText(author.name.scope, t), email: scopeText(author.email.scope, t) });
}

type RowState = "ok" | "attention" | "missing" | "pending";
const rowIcons: Record<RowState, LucideIcon> = { ok: Check, attention: AlertTriangle, missing: AlertTriangle, pending: CircleDashed };

function Row({ item, state, icon: Icon, title, children }: { item: ReadinessItem; state: RowState; icon: LucideIcon; title: string; children?: ReactNode }) {
  const StateIcon = rowIcons[state];
  return <li className="readiness-row" data-item={item} data-state={state}>
    <span className="readiness-icon" aria-hidden="true"><Icon size={13} /></span>
    <div className="readiness-body"><strong><StateIcon size={11} className="readiness-state-icon" />{title}</strong>{children}</div>
  </li>;
}

function Terminal({ command }: { command: string }) {
  return <code className="readiness-command"><TerminalSquare size={11} />{command}</code>;
}

export function ReadinessChecklist({ readiness, items, t, compact = false, title, remoteChoice }: {
  readiness: ReadinessState; items: ReadinessItem[]; t: Translate; compact?: boolean; title?: string;
  /** Several remotes: which one to check, chosen here. */
  remoteChoice?: { value?: string; onChange: (remote: string) => void };
}) {
  const actions = useContext(ReadinessActionsContext);
  const { report, loading, error, recheck } = readiness;
  const recheckButton = (label: MessageKey = "readinessRecheck", access = false) =>
    <button type="button" className="ghost-button small" onClick={() => void recheck(access)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCcw size={12} />} {t(label)}</button>;
  const page = (target: HelpPage, label: MessageKey) =>
    <button type="button" className="ghost-button small" onClick={() => actions.onOpenPage(target)}><ExternalLink size={12} /> {t(label)}</button>;

  if (!report) {
    return <section className={`readiness-checklist ${compact ? "compact" : ""}`} aria-label={title ?? t("readinessTitle")} aria-busy={loading}>
      {title && <h4>{title}</h4>}
      {error ? <p className="readiness-error" role="alert"><AlertTriangle size={12} /> {t("readinessLoadFailed", { error })} {recheckButton()}</p>
        : <p className="readiness-loading"><LoaderCircle className="spin" size={12} /> {t("readinessChecking")}</p>}
    </section>;
  }
  const { git, author, remote } = report;
  const rows: ReactNode[] = [];

  if (items.includes("git")) {
    rows.push(git.status === "ok"
      ? <Row key="git" item="git" state="ok" icon={TerminalSquare} title={t("readinessGit_ok", { version: git.version })}>{!compact && <span className="readiness-detail">{git.path}</span>}</Row>
      : <Row key="git" item="git" state="missing" icon={TerminalSquare} title={t(git.status === "missing" ? "readinessGit_missing" : "readinessGit_unusable")}>
        <span>{t(git.status === "missing" ? "readinessGit_missingHelp" : "readinessGit_unusableHelp")}</span>
        <Terminal command="xcode-select --install" />
        <div className="readiness-actions">{page("git_download", "readinessGetGit")}{recheckButton()}</div>
        {git.status === "unusable" && <details className="recovery-detail"><summary>{t("technicalDetails")}</summary><pre>{git.detail}</pre></details>}
      </Row>);
  }

  if (items.includes("author") && git.status === "ok") {
    const ok = author.status === "ok";
    rows.push(<Row key="author" item="author" state={ok ? "ok" : "missing"} icon={UserRound}
      title={ok ? t("readinessAuthor_ok", { name: author.name!.value, email: author.email!.value }) : t(author.status === "partial" ? "readinessAuthor_partial" : "readinessAuthor_missing")}>
      {ok && <span className="readiness-detail">{authorOrigin(author, t)}</span>}
      {ok && author.overridesGlobal && <span>{t("readinessAuthorOverrides", { repository: identityText(author.repository), global: identityText(author.global) })}</span>}
      {!ok && <span>{t("readinessAuthor_missingHelp")}</span>}
      {!ok && !actions.onSetIdentity && <span className="readiness-note">{t("readinessAuthorOpenProject")}</span>}
      {!compact && <span className="readiness-note">{t("readinessAttribution")}</span>}
      {actions.onSetIdentity && (!ok || !compact) && <div className="readiness-actions">
        <button type="button" className={ok ? "ghost-button small" : "outline-button small"} onClick={actions.onSetIdentity}><UserRound size={12} /> {t(ok ? "readinessChangeAuthor" : "readinessSetAuthor")}</button>
        {!ok && recheckButton()}
      </div>}
    </Row>);
  }

  if (items.includes("remote") && git.status === "ok" && report.repoPath) {
    if (remote.status === "none") {
      rows.push(<Row key="remote" item="remote" state="attention" icon={Cloud} title={t("readinessRemote_none")}>
        <span>{t("readinessRemote_noneHelp")}</span>
        {actions.onConnectRemote && <div className="readiness-actions"><button type="button" className="outline-button small" onClick={actions.onConnectRemote}><Cloud size={12} /> {t("readinessConnectRemote")}</button></div>}
      </Row>);
    } else {
      const host = remote.resolvedHost ?? remote.host ?? remote.url;
      const github = host === "github.com";
      const state: RowState = remote.access === "ok" ? "ok" : remote.access === "not_checked" ? "pending" : "attention";
      const account = remote.account;
      const accountList = account?.accounts.map((entry) => `${entry.login}${entry.active ? ` ${t("readinessActiveMarker")}` : ""}`).join(", ");
      rows.push(<Row key="remote" item="remote" state={state} icon={Cloud} title={t("readinessRemoteWhere", { url: remote.url })}>
        <span className="readiness-detail">{[remote.name, t(`readinessProtocol_${remote.protocol}` as MessageKey), remote.host && remote.resolvedHost ? `${remote.host} → ${remote.resolvedHost}` : remote.host].filter(Boolean).join(" · ")} · {t(`readinessRemoteSource_${remote.source}` as MessageKey, { count: remote.remotes.length })}</span>
        {remoteChoice && remote.remotes.length > 1 && <label className="readiness-remote-choice">{t("readinessRemoteChoice")}<select value={remoteChoice.value ?? remote.name} onChange={(event) => remoteChoice.onChange(event.target.value)} disabled={loading}>{remote.remotes.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
        <div className="readiness-access" data-access={remote.access}>
          <strong>{loading && remote.access === "not_checked" ? <><LoaderCircle className="spin" size={11} /> {t("readinessAccessChecking")}</> : t(`readinessAccess_${remote.access}` as MessageKey, { host })}</strong>
          {!(loading && remote.access === "not_checked") && <span>{t(accessHelpKey(remote.access, remote.protocol), { host })}</span>}
          {remote.access === "credentials" && remote.protocol === "https" && <><Terminal command={github ? "gh auth login" : `git config --global credential.helper osxkeychain`} />{remote.helper && <span className="readiness-detail">{t("readinessHelper", { helper: t(`readinessHelper_${remote.helper}` as MessageKey) })}</span>}</>}
          {remote.access === "denied" && remote.protocol === "ssh" && <Terminal command="ssh-keygen -t ed25519" />}
          {remote.access === "denied" && remote.protocol === "https" && github && <Terminal command="gh auth switch" />}
          {remote.access === "host_key" && <Terminal command={`ssh -T git@${remote.host ?? host}`} />}
          {remote.access === "ok" && remote.protocol === "https" && remote.helper && <span className="readiness-detail">{t("readinessHelper", { helper: t(`readinessHelper_${remote.helper}` as MessageKey) })}</span>}
        </div>
        {account && <div className="readiness-account">
          {account.verified && <span className="readiness-verified"><Check size={11} /> {t(account.verifiedBy === "ssh" ? "readinessAccountVerifiedSsh" : "readinessAccountVerifiedGh", { login: account.verified, path: remote.path ?? remote.url })}</span>}
          {account.gh === "signed_in" && <span>{t("readinessAccountsGh", { accounts: accountList ?? "" })}</span>}
          {account.differs && <span className="readiness-warning">{t("readinessAccountsDiffer", { ssh: account.sshLogin ?? "", active: account.accounts.find((entry) => entry.active)?.login ?? "" })}</span>}
          {!account.differs && account.accounts.length > 1 && <span>{t("readinessAccountsSeveral")}</span>}
          {account.gh === "missing" && <span>{t("readinessGh_missing")}</span>}
          {account.gh === "signed_out" && <><span>{t("readinessGh_signed_out")}</span><Terminal command="gh auth login" /></>}
        </div>}
        <div className="readiness-actions">
          {recheckButton(remote.access === "not_checked" ? "readinessCheckAccess" : "readinessRecheckAccess", true)}
          {remote.access === "denied" && remote.protocol === "ssh" && github && page("github_ssh_keys", "readinessOpenSshKeys")}
          {account?.gh === "missing" && page("gh_install", "readinessGetGh")}
        </div>
        {remote.detail && remote.access !== "ok" && <details className="recovery-detail"><summary>{t("technicalDetails")}</summary><pre>{remote.detail}</pre></details>}
      </Row>);
    }
  }

  return <section className={`readiness-checklist ${compact ? "compact" : ""}`} aria-label={title ?? t("readinessTitle")} aria-busy={loading}>
    {title && <h4>{title}</h4>}
    <ul>{rows}</ul>
    {error && <p className="readiness-error" role="alert"><AlertTriangle size={12} /> {t("readinessLoadFailed", { error })}</p>}
  </section>;
}

function accessHelpKey(access: string, protocol: string): MessageKey {
  if (access === "denied") return protocol === "ssh" ? "readinessAccessHelp_denied_ssh" : "readinessAccessHelp_denied";
  if (access === "credentials" && protocol !== "https") return "readinessAccessHelp_credentials_ssh";
  return `readinessAccessHelp_${access}` as MessageKey;
}
