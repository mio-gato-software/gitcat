import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useDialog } from "./useDialog";
import { formatDate, translate, type MessageKey, type Translate } from "./i18n";
import type {
  ActivityOperation,
  ActivityRecord,
  HistoryRecovery,
  HistoryRecoverySuggestion,
  Locale
} from "../shared/types";

const operationLabels: Record<ActivityOperation, MessageKey> = {
  sync_remote: "activitySyncRemote",
  stash_push: "activitySetAside",
  stash_pop: "activityRestoreWork",
  status: "activityReadStatus",
  checkout: "activitySwitchBranch",
  create_branch: "createBranch",
  delete_branch: "activityDeleteBranch",
  rename_branch: "activityRenameBranch",
  fetch: "activityReadRemote",
  pull: "pullLatest",
  push: "pushBranch",
  merge: "mergeBranch",
  rebase: "activityRebase",
  abort_operation: "abortHalfFinished",
  continue_operation: "continueOperation",
  skip_operation: "skipCommit",
  resolve_conflict: "resolveConflictsButton",
  commit: "saveChanges",
  git_command: "activityGitOperation",
  github_create_repo: "activityCreateRemote",
  ignore_path: "activityIgnoreFile",
  set_identity: "activitySetIdentity",
  add_remote: "connectRemoteTitle",
  none: "activityGitOperation",
  pull_request: "activityCreateReview",
  set_aside_work: "activitySetAside",
  restore_set_aside_work: "activityRestoreWork",
  restore_and_remove_work: "switchWorkRestoreAndRemove",
  undo_save: "activityUndoSave",
  revert_save: "activityRevertSave",
  create_recovery_branch: "activityRecoveryBranch"
};

const operationLabel = (operation: ActivityOperation, t: Translate) =>
  t(Object.hasOwn(operationLabels, operation) ? operationLabels[operation] : "activityGitOperation");

const stateLabels = {
  completed: "activityStateCompleted",
  failed: "activityStateFailed",
  running: "activityStateUnknown"
} satisfies Record<ActivityRecord["state"], MessageKey>;

const statusLabels = {
  completed: "activityStepCompleted",
  failed: "activityStepFailed",
  skipped: "activityStepSkipped",
  pending: "activityStepPending"
} satisfies Record<ActivityRecord["steps"][number]["status"], MessageKey>;

const suggestionLabels = {
  local: "activitySuggestionLocal",
  published: "activitySuggestionPublished",
  unverified: "activitySuggestionUnverified",
  older: "activitySuggestionOlder"
} satisfies Record<HistoryRecoverySuggestion["reason"], MessageKey>;

type Recover = (id: string, mode: HistoryRecovery["mode"]) => void;

function ActivityEntry({
  entry,
  path,
  locale,
  onRecover
}: {
  entry: ActivityRecord;
  path: string;
  locale: Locale;
  onRecover: Recover;
}) {
  const t = translate(locale);
  const [suggestion, setSuggestion] = useState<HistoryRecoverySuggestion>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const hasSave = entry.steps.some(
    (step) => step.operation === "commit" && step.status === "completed" && step.afterHead
  );
  const action = operationLabel(entry.steps[0]?.operation ?? "none", t);
  const checkRecovery = async () => {
    setChecking(true);
    setSuggestion(undefined);
    setError("");
    try {
      setSuggestion(await window.gitcat.suggestHistoryRecovery(path, entry.id, locale));
    } catch (reason) {
      setError(String(reason).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally {
      setChecking(false);
    }
  };

  return (
    <details className="activity-record activity-entry" data-has-save={Boolean(hasSave)}>
      <summary>
        <span>
          <strong>{t("activityEntryTitle", { action, branch: entry.before.branch })}</strong>
          <span className="activity-entry-meta">
            <time dateTime={entry.startedAt}>{formatDate(entry.startedAt, locale)}</time>
            <span>{t(stateLabels[entry.state])}</span>
          </span>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <ol>
        {entry.steps.map((step, index) => (
          <li key={index}>
            {operationLabel(step.operation, t)} · {t(statusLabels[step.status])}
          </li>
        ))}
      </ol>
      {entry.state === "running" && <p className="detail-note">{t("activityInterrupted")}</p>}
      {hasSave && (
        <div className="activity-entry-recovery">
          {error && <p role="alert">{error}</p>}
          {checking && <p role="status">{t("activityCheckingRecovery")}</p>}
          {suggestion ? (
            <>
              <p>{t(suggestionLabels[suggestion.reason])}</p>
              <button className="primary-button" onClick={() => onRecover(entry.id, suggestion.mode)}>
                {t(suggestion.mode === "undo" ? "activityReviewUndo" : "activityReviewRevert")}
              </button>
            </>
          ) : (
            <button className="outline-button" disabled={checking} onClick={() => void checkRecovery()}>
              {t("activityCheckRecovery")}
            </button>
          )}
        </div>
      )}
      {entry.before.head && (
        <button className="ghost-button small" disabled={checking} onClick={() => onRecover(entry.id, "restore")}>
          {t("activityReviewRecoveryBranch")}
        </button>
      )}
      <details className="activity-entry-technical">
        <summary>{t("technicalDetails")}</summary>
        <p>
          {entry.before.branch} · <code>{entry.before.head || "—"}</code> → {entry.after?.branch ?? "—"} ·{" "}
          <code>{entry.after?.head ?? "—"}</code>
        </p>
        {entry.error && <p>{entry.error}</p>}
      </details>
    </details>
  );
}

export function ActivityHistory({
  path,
  locale,
  onClose,
  onRecover
}: {
  path: string;
  locale: Locale;
  onClose: () => void;
  onRecover: Recover;
}) {
  const ref = useDialog(onClose);
  const [entries, setEntries] = useState<ActivityRecord[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [backupPath, setBackupPath] = useState<string>();
  const t = translate(locale);
  const load = async () => {
    const result = await window.gitcat.getActivityHistory(path);
    setEntries(result.entries);
    setDays(result.retentionDays);
    setRecoveryRequired(result.recoveryRequired === true);
  };
  useEffect(() => {
    void load()
      .catch((reason) => setError(String(reason)))
      .finally(() => setReady(true));
  }, [path]);
  const change = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        className="commit-modal wide activity-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
      >
        <div className="modal-heading">
          <h2 id="activity-title">{t("activityTitle")}</h2>
          <button className="ghost-button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        {backupPath && <p role="status">{t("activityRepairBackup", { path: backupPath })}</p>}
        {error && <p role="alert">{error}</p>}
        {!ready && <p role="status">{t("activityLoading")}</p>}
        {recoveryRequired ? (
          <>
            <p role="alert">{t("activityHistoryUnreadable")}</p>
            {confirmRepair ? (
              <>
                <p>{t("activityRepairPrompt")}</p>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void change(async () => {
                      setBackupPath(await window.gitcat.repairActivityHistory(path));
                      setConfirmRepair(false);
                    })
                  }
                >
                  {t("activityRepairConfirm")}
                </button>
                <button className="ghost-button" disabled={busy} onClick={() => setConfirmRepair(false)}>
                  {t("cancel")}
                </button>
              </>
            ) : (
              <button className="outline-button" disabled={busy} onClick={() => setConfirmRepair(true)}>
                {t("activityRepair")}
              </button>
            )}
          </>
        ) : (
          ready && (
            <>
              {!error && !entries.length && <p>{t("activityEmpty")}</p>}
              <div className="activity-timeline">
                {entries.map((entry) => (
                  <ActivityEntry key={entry.id} entry={entry} path={path} locale={locale} onRecover={onRecover} />
                ))}
              </div>
              <details
                className="activity-settings"
                onToggle={(event) => {
                  if (!event.currentTarget.open) setClearing(false);
                }}
              >
                <summary>{t("activitySettings")}</summary>
                <label>
                  {t("activityRetention")}
                  <select
                    value={days}
                    disabled={busy}
                    onChange={(event) =>
                      void change(() => window.gitcat.setActivityRetention(Number(event.target.value)))
                    }
                  >
                    {[7, 30, 90, 0].map((value) => (
                      <option key={value} value={value}>
                        {value ? t("activityDays", { count: value }) : t("activityRetentionOff")}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="detail-note">{t("activityRetentionNote")}</p>
                <button
                  className="outline-button"
                  disabled={busy}
                  onClick={() => {
                    if (!clearing) {
                      setClearing(true);
                      return;
                    }
                    void change(async () => {
                      await window.gitcat.clearActivityHistory(path);
                      setClearing(false);
                    });
                  }}
                >
                  {t(clearing ? "activityClearConfirm" : "activityClear")}
                </button>
                {clearing && (
                  <button className="ghost-button" onClick={() => setClearing(false)}>
                    {t("cancel")}
                  </button>
                )}
              </details>
            </>
          )
        )}
      </section>
    </div>
  );
}
