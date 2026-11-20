import { useCallback, useEffect, useState } from "react";
import type {
  HostingConnection,
  HostingProvider,
  Locale,
  RepoSnapshot,
  ShareReviewPreview,
  ShareReviewResult
} from "../shared/types";
import { hostingLabels, hostingProviders, isNativeProvider, hostingProvider } from "../shared/hosting";
import { HostingAccounts, hostingError } from "./HostingAccounts";
import { formatDate, translate } from "./i18n";
import { useDialog } from "./useDialog";

export function ShareReview({
  snapshot,
  head,
  locale,
  onClose,
  onUpdated
}: {
  snapshot: RepoSnapshot;
  head: string;
  locale: Locale;
  onClose: () => void;
  onUpdated: (snapshot: RepoSnapshot) => void;
}) {
  const t = translate(locale);
  const ref = useDialog(onClose);
  const [remote, setRemote] = useState(snapshot.remotes[0] ?? "");
  const [branch, setBranch] = useState(head);
  const [base, setBase] = useState(snapshot.defaultBranch ?? "main");
  const [title, setTitle] = useState(head);
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<ShareReviewPreview>();
  const [result, setResult] = useState<Pick<ShareReviewResult, "pullRequest" | "warnings">>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<HostingProvider | "">("");
  const [connections, setConnections] = useState<HostingConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [manageAccounts, setManageAccounts] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      setConnections((await window.gitcat.getHostingConnections()).connections);
    } catch (reason) {
      setError(hostingError(reason));
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);
  let known: HostingProvider | undefined;
  try {
    const url = snapshot.remoteUrls[remote] ?? "";
    const host = url.includes("://") ? new URL(url).hostname : url.match(/^(?:[^@]+@)?([^:]+):/)?.[1];
    known = hostingProvider(host);
  } catch {
    /* The service validates the complete address. */
  }
  const selectedProvider = provider || known;
  const native = selectedProvider ? isNativeProvider(selectedProvider) : false;
  const existingReview = preview?.existing;
  const openExisting = existingReview?.state === "OPEN" && preview?.commits.length === 0 ? existingReview : undefined;

  const check = async () => {
    setBusy(true);
    setError("");
    setPreview(undefined);
    setResult(undefined);
    try {
      setPreview(
        await window.gitcat.previewReview(snapshot.path, {
          remote,
          head: branch,
          base,
          title,
          body,
          ...(provider ? { provider } : {}),
          ...(connectionId ? { connectionId } : {})
        })
      );
    } catch (e) {
      setError(hostingError(e));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      const { pullRequest, warnings, snapshot: updated } = await window.gitcat.publishReview(snapshot.path, preview.id);
      setResult({ pullRequest, warnings });
      if (updated) onUpdated(updated);
    } catch (e) {
      setError(hostingError(e));
    } finally {
      setBusy(false);
      setPreview(undefined);
    }
  };
  const open = async (url: string) => {
    setError("");
    try {
      await window.gitcat.openReview(url);
    } catch (reason) {
      setError(hostingError(reason));
    }
  };
  const edit = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPreview(undefined);
    setResult(undefined);
  };
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        className="commit-modal wide share-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-review-title"
      >
        <div className="modal-heading">
          <h2 id="share-review-title">{t("shareReviewTitle")}</h2>
          <button className="ghost-button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        <p>{t("shareReviewIntro")}</p>
        <fieldset disabled={busy}>
          <label>
            {t("shareReviewRemote")}
            <select value={remote} onChange={(e) => edit(setRemote, e.target.value)}>
              {snapshot.remotes.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            {t("readinessHostingService")}
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as HostingProvider | "");
                setConnectionId("");
                setPreview(undefined);
                setResult(undefined);
                setError("");
              }}
            >
              <option value="">{t("shareReviewUseRepositoryService")}</option>
              {hostingProviders.map((p) => (
                <option key={p} value={p}>
                  {hostingLabels[p]}
                </option>
              ))}
            </select>
          </label>
          <p className="readiness-note">{t("shareReviewCustomHost")}</p>
          {(native || (!selectedProvider && connections.length > 0)) && (
            <label>
              {t("shareReviewSavedAccount")}
              <select value={connectionId} onChange={(event) => edit(setConnectionId, event.target.value)}>
                <option value="">{t("shareReviewUseMatchedAccount")}</option>
                {connections
                  .filter((c) => !selectedProvider || c.provider === selectedProvider)
                  .map((c) => (
                    <option value={c.id} key={c.id}>
                      {hostingLabels[c.provider]} · {c.label} · {c.username || c.accountId} · {c.baseUrl}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            {t("shareReviewBranch")}
            <select value={branch} onChange={(e) => edit(setBranch, e.target.value)}>
              {snapshot.branches
                .filter((b) => b.presence !== "remote")
                .map((b) => (
                  <option key={b.name}>{b.name}</option>
                ))}
            </select>
          </label>
          <label>
            {t("shareReviewBaseBranch")}
            <input value={base} onChange={(e) => edit(setBase, e.target.value)} />
          </label>
          <label>
            {t("shareReviewTitleLabel")}
            <input value={title} maxLength={250} onChange={(e) => edit(setTitle, e.target.value)} />
          </label>
          <label>
            {t("shareReviewDescription")}
            <textarea value={body} maxLength={8000} onChange={(e) => edit(setBody, e.target.value)} />
          </label>
        </fieldset>
        {(native || manageAccounts) && (
          <>
            <p>{t("shareReviewAccountPublication")}</p>
            <button
              type="button"
              className="ghost-button small"
              disabled={busy}
              onClick={() => setManageAccounts(!manageAccounts)}
            >
              {t("shareReviewManageAccounts")}
            </button>
          </>
        )}
        {manageAccounts && (
          <HostingAccounts
            locale={locale}
            expanded
            onChanged={() => {
              void loadAccounts();
              setPreview(undefined);
              setResult(undefined);
            }}
          />
        )}
        {!snapshot.remotes.length && <p>{t("shareReviewNeedsRemote")}</p>}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{t("shareReviewChecking")}</p>}
        <button
          className="outline-button"
          disabled={busy || !remote || !title.trim() || !base}
          onClick={() => void check()}
        >
          {t("shareReviewCheck")}
        </button>
        {preview && (
          <div className="activity-record">
            <p>
              <strong>
                {hostingLabels[preview.provider]} · {preview.repository}
              </strong>{" "}
              · {preview.remoteUrl}
            </p>
            <p>
              {t("shareReviewVerifiedAccount")}: <strong>{preview.hosting?.label ?? preview.account}</strong>
              {preview.hosting && <> · {preview.hosting.location.gitUrl}</>}
            </p>
            <p>
              {preview.request.head} → {preview.request.base} ·{" "}
              <time dateTime={preview.checkedAt}>{formatDate(preview.checkedAt, locale)}</time>
            </p>
            <p>
              {t("shareReviewCommits")}: {preview.commits.length}
            </p>
            <ul>
              {preview.commits.map((c) => (
                <li key={c.hash}>
                  <code>{c.hash.slice(0, 7)}</code> {c.subject}
                </li>
              ))}
            </ul>
            {existingReview && (
              <p>
                {t("shareReviewLiveStatus")}: {existingReview.state}{" "}
                {!openExisting && (
                  <button className="ghost-button" onClick={() => void open(existingReview.url)}>
                    {existingReview.url}
                  </button>
                )}
              </p>
            )}
            {openExisting ? (
              <button className="primary-button" title={openExisting.url} onClick={() => void open(openExisting.url)}>
                {t("shareReviewOpen")}
              </button>
            ) : (
              <>
                <p>{t("shareReviewConfirmation")}</p>
                <button
                  className="primary-button"
                  disabled={busy || !preview.reviewable}
                  onClick={() => void publish()}
                >
                  {existingReview?.state === "OPEN" ? t("shareReviewPublishExisting") : t("shareReviewPublishNew")}
                </button>
              </>
            )}
          </div>
        )}
        {result && (
          <div role="status">
            <p>
              {result.pullRequest.state} ·{" "}
              <button className="outline-button" onClick={() => void open(result.pullRequest.url)}>
                {result.pullRequest.url}
              </button>
            </p>
            {result.warnings.map((warning) => (
              <p key={warning}>
                {t(warning === "history_write" ? "shareReviewHistoryWarning" : "shareReviewSnapshotWarning")}
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
