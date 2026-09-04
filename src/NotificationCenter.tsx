import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, Check, ChevronDown, Info, X } from "lucide-react";
import { notificationDuration, notificationSummary, type Notification } from "../shared/notifications";
import type { Translate } from "./i18n";

export function NotificationCenter({ items, onDismiss, onClear, t }: {
  items: Notification[]; onDismiss: (id: number) => void; onClear: () => void; t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number>();
  const [previewId, setPreviewId] = useState<number>();
  const [paused, setPaused] = useState(false);
  const newestSeen = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const latest = items[0];
  const preview = items.find((item) => item.id === previewId);
  const warnings = items.filter((item) => item.tone === "warning").length;

  useEffect(() => {
    if (latest && latest.id > newestSeen.current) {
      newestSeen.current = latest.id;
      setPreviewId(open ? undefined : latest.id);
    }
  }, [latest?.id, open]);
  useEffect(() => {
    if (!preview || paused || open) return;
    const timer = setTimeout(() => setPreviewId(undefined), notificationDuration(preview.tone));
    return () => clearTimeout(timer);
  }, [preview?.id, paused, open]);
  useEffect(() => {
    if (!open) return;
    setPreviewId(undefined);
    closeButton.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); bell.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    root.current?.addEventListener("keydown", escape);
    const element = root.current;
    return () => { document.removeEventListener("pointerdown", outside); element?.removeEventListener("keydown", escape); };
  }, [open]);

  const symbol = (tone: Notification["tone"]) => tone === "warning" ? <AlertTriangle size={14} /> : tone === "success" ? <Check size={14} /> : <Info size={14} />;
  return <div className="notification-root" ref={root}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setPaused(false); if (event.relatedTarget) setOpen(false); } }}>
    <div className="notification-status">
      <div className="notification-preview-space" role="status" aria-live="polite" aria-atomic="true">
        {preview && !open && <button className={`notification-preview ${preview.tone}`} onClick={() => { setExpanded(preview.id); setOpen(true); }} title={t("viewNotification")}>
          {symbol(preview.tone)}<span>{notificationSummary(preview)}</span>
        </button>}
      </div>
      <button ref={bell} className={`notification-bell ${warnings ? "has-warning" : ""}`} aria-label={t("notificationCount", { count: items.length })}
        aria-expanded={open} aria-controls="notification-panel" onClick={() => setOpen(!open)} title={t("notifications")}>
        <Bell size={14} />{items.length > 0 && <span>{items.length > 99 ? "99+" : items.length}</span>}
      </button>
    </div>
    {open && <section id="notification-panel" className="notification-panel" role="dialog" aria-label={t("notifications")}>
      <div className="notification-panel-header"><strong>{t("notifications")}</strong><button onClick={() => { onClear(); closeButton.current?.focus(); }} disabled={!items.length}>{t("clearNotifications")}</button>
        <button ref={closeButton} aria-label={t("closeNotifications")} onClick={() => { setOpen(false); bell.current?.focus(); }}><X size={16} /></button></div>
      <p className="notification-session-note">{t("notificationSession")}</p>
      <div className="notification-history">{items.length ? items.map((item) => <article className={`notification-entry ${item.tone}`} key={item.id}>
        <div className="notification-entry-heading">{symbol(item.tone)}<strong>{item.label}</strong>
          <button aria-label={t("closeNotification", { label: item.label })} onClick={() => { onDismiss(item.id); closeButton.current?.focus(); }}><X size={14} /></button></div>
        <p className={expanded === item.id ? "expanded" : ""} id={`notification-detail-${item.id}`}>{item.detail}</p>
        <button className="notification-detail-toggle" aria-expanded={expanded === item.id} aria-controls={`notification-detail-${item.id}`}
          onClick={() => setExpanded(expanded === item.id ? undefined : item.id)}><ChevronDown size={12} />{t(expanded === item.id ? "lessNotificationDetail" : "viewNotification")}</button>
      </article>) : <div className="notification-empty"><Check size={22} /><span>{t("noNotifications")}</span></div>}</div>
    </section>}
  </div>;
}
