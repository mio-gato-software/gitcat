import { useEffect, useState } from "react";
import type { Locale, SwitchWorkPreview, SwitchWorkRequest } from "../shared/types";
import { formatDate, translate } from "./i18n";
import { useDialog } from "./useDialog";

export function SwitchWork({
  path,
  target,
  locale,
  onClose,
  onSave,
  onPrepare
}: {
  path: string;
  target: string;
  locale: Locale;
  onClose: () => void;
  onSave: () => void;
  onPrepare: (request: SwitchWorkRequest) => void;
}) {
  const t = translate(locale);
  const ref = useDialog(onClose);
  const [preview, setPreview] = useState<SwitchWorkPreview>();
  const [error, setError] = useState("");
  const [label, setLabel] = useState<string>();
  const [untracked, setUntracked] = useState(true);
  const switching = Boolean(target);

  useEffect(() => {
    let alive = true;
    void window.gitcat
      .getSwitchWork(path, target)
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [path, target]);

  const name = label ?? (preview?.snapshot.currentBranch ?? "").slice(0, 120);
  const pending = Boolean(preview?.snapshot.pending || preview?.snapshot.conflicts.length);
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        className="commit-modal wide switch-work"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-work-title"
      >
        <div className="modal-heading">
          <h2 id="switch-work-title">{switching ? t("switchWorkTo", { target }) : t("switchWorkLibrary")}</h2>
          <button className="ghost-button" onClick={onClose}>
            {t(switching ? "switchWorkStay" : "close")}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!preview && !error && <p role="status">{t("switchWorkReading")}</p>}
        {preview &&
          (switching ? (
            <>
              {preview.occupied ? (
                <p role="alert">
                  {t("switchWorkOccupied")} <code>{preview.occupied}</code>
                </p>
              ) : (
                <>
                  {preview.snapshot.isDirty && (
                    <details className="switch-work-files">
                      <summary>{t("switchWorkUnsaved")}</summary>
                      <ul>
                        {preview.snapshot.changes.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {!!preview.blockers.length && (
                    <p>
                      {t("switchWorkOverlapping")} {preview.blockers.join(", ")}
                    </p>
                  )}
                  <div className="modal-actions">
                    <button
                      className="outline-button"
                      disabled={pending || preview.blockers.length > 0}
                      onClick={() => onPrepare({ mode: "carry", target })}
                    >
                      {t("switchWorkReviewCarry")}
                    </button>
                    {preview.snapshot.isDirty && (
                      <button className="outline-button" disabled={pending} onClick={onSave}>
                        {t("switchWorkSaveFirst")}
                      </button>
                    )}
                  </div>
                  {preview.snapshot.isDirty && (
                    <fieldset>
                      <legend>{t("switchWorkSetAside")}</legend>
                      <button
                        className="outline-button"
                        disabled={pending || !name.trim()}
                        onClick={() =>
                          onPrepare({ mode: "set_aside", target, label: name, includeUntracked: untracked })
                        }
                      >
                        {t("switchWorkReviewSetAside")}
                      </button>
                      <details>
                        <summary>{t("switchWorkSetAsideOptions")}</summary>
                        <label>
                          {t("switchWorkEntryName")}
                          <input value={name} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
                        </label>
                        <label>
                          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
                          {t("switchWorkIncludeUntracked")}
                        </label>
                      </details>
                    </fieldset>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p>{t("switchWorkRestoringOn", { branch: preview.snapshot.currentBranch })}</p>
              {pending && <p role="status">{t("switchWorkFinishFirst")}</p>}
              {!preview.entries.length && <p>{t("switchWorkNoEntries")}</p>}
              {preview.entries.map((entry) => (
                <article className="activity-record" key={entry.ref}>
                  <strong>{entry.label}</strong>
                  <p>
                    {entry.branch && <>{entry.branch} · </>}
                    <time dateTime={entry.date}>{formatDate(entry.date, locale)}</time>
                  </p>
                  <div className="modal-actions">
                    {[false, true].map((removeAfterRestore) => (
                      <button
                        key={String(removeAfterRestore)}
                        className="outline-button"
                        disabled={pending}
                        onClick={() =>
                          onPrepare({ mode: "restore", stash: entry.hash, stashRef: entry.ref, removeAfterRestore })
                        }
                      >
                        {t(removeAfterRestore ? "switchWorkRestoreAndRemove" : "switchWorkRestore")}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </>
          ))}
      </section>
    </div>
  );
}
