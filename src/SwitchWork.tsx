import { useEffect, useState } from "react";
import type { Locale, SwitchWorkPreview, SwitchWorkRequest } from "../shared/types";
import { translate } from "./i18n";
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
  const [label, setLabel] = useState("");
  const [untracked, setUntracked] = useState(false);

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
  const switching = preview && preview.snapshot.currentBranch !== target;
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
          <h2 id="switch-work-title">{t("switchWorkTitle")}</h2>
          <button className="ghost-button" onClick={onClose}>
            {t("switchWorkStay")}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!preview && !error && <p role="status">{t("switchWorkReading")}</p>}
        {preview && (
          <>
            <p>
              {t("switchWorkActiveBranch")}: <strong>{preview.snapshot.currentBranch}</strong>
              {switching && (
                <>
                  {" "}
                  → <strong>{target}</strong>
                </>
              )}
            </p>
            {preview.occupied && (
              <p role="alert">
                {t("switchWorkOccupied")} <code>{preview.occupied}</code>
              </p>
            )}
            {preview.snapshot.isDirty && (
              <>
                <p>{t("switchWorkUnsaved")}</p>
                <ul>
                  {preview.snapshot.changes.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> · {file.xy}
                    </li>
                  ))}
                </ul>
                <button className="outline-button" onClick={onSave}>
                  {t("switchWorkSaveFirst")}
                </button>
                <p className="detail-note">{t("switchWorkSaveHelp")}</p>
              </>
            )}
            {switching && !preview.occupied && (
              <>
                {preview.blockers.length > 0 && (
                  <p>
                    {t("switchWorkOverlapping")} {preview.blockers.join(", ")}
                  </p>
                )}
                <button
                  className="outline-button"
                  disabled={preview.blockers.length > 0}
                  onClick={() => onPrepare({ mode: "carry", target })}
                >
                  {t("switchWorkReviewCarry")} {target}
                </button>
                {preview.snapshot.isDirty && (
                  <fieldset>
                    <legend>{t("switchWorkSetAside")}</legend>
                    <p>{t("switchWorkSetAsideHelp")}</p>
                    <label>
                      {t("switchWorkEntryName")}{" "}
                      <input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
                    </label>
                    <label>
                      <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
                      {t("switchWorkIncludeUntracked")}
                    </label>
                    <button
                      className="outline-button"
                      disabled={!label.trim()}
                      onClick={() => onPrepare({ mode: "set_aside", target, label, includeUntracked: untracked })}
                    >
                      {t("switchWorkReviewSetAside")}
                    </button>
                  </fieldset>
                )}
              </>
            )}
            <h3>{t("switchWorkEntries")}</h3>
            <p>{t("switchWorkRestoreHelp")}</p>
            {!preview.entries.length && <p>{t("switchWorkNoEntries")}</p>}
            {preview.entries.map((entry) => (
              <div className="activity-record" key={entry.hash}>
                <p>{entry.label}</p>
                <button
                  className="outline-button"
                  disabled={preview.snapshot.isDirty}
                  onClick={() => onPrepare({ mode: "restore", stash: entry.hash })}
                >
                  {t("switchWorkReviewRestore")} {preview.snapshot.currentBranch}
                </button>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
