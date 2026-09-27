import { useEffect, useState } from 'react';
import { useDialog } from './useDialog';
import type { ActivityRecord, HistoryRecovery, Locale } from '../shared/types';

export function ActivityHistory({ path, locale, onClose, onRecover }: { path: string; locale: Locale; onClose: () => void; onRecover: (id: string, mode: HistoryRecovery['mode']) => void }) {
  const ref = useDialog(onClose);
  const [entries, setEntries] = useState<ActivityRecord[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = (en: string, es: string) => locale === 'es' ? es : en;
  const load = async () => { const result=await window.gitcat.getActivityHistory(path); setEntries(result.entries); setDays(result.retentionDays); };
  useEffect(() => { void load().catch(e=>setError(String(e))); }, [path]);
  const change = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); await load(); } catch(e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section ref={ref} className="commit-modal wide activity-history" role="dialog" aria-modal="true" aria-labelledby="activity-title">
    <div className="modal-heading"><h2 id="activity-title">{text('Activity and recovery','Actividad y recuperación')}</h2><button className="ghost-button" onClick={onClose}>{text('Close','Cerrar')}</button></div>
    <p>{text('Local records of confirmed plans survive restarts. This is not a file backup: never-saved files cannot be recovered here. A pending step after a restart has an unknown outcome; inspect the project before retrying.','Los registros locales de planes confirmados sobreviven a los reinicios. Esto no es una copia de tus archivos: no recupera archivos nunca guardados. Un paso pendiente después de reiniciar tiene un resultado desconocido; revisa el proyecto antes de reintentar.')}</p>
    <label>{text('Keep local history for all projects','Conservar historial local de todos los proyectos')} <select value={days} disabled={busy} onChange={event=>void change(()=>window.gitcat.setActivityRetention(Number(event.target.value)))}>
      {[0,7,30,90].map(value=><option key={value} value={value}>{value ? `${value} ${text('days','días')}` : text('Off — clear stored history','Desactivado — borrar historial guardado')}</option>)}
    </select></label>
    <p className="detail-note">{text('Retention removes metadata, not Git commits or files. Turning it off clears all stored activity.','La retención borra metadatos, no commits ni archivos. Desactivarla borra toda la actividad guardada.')}</p>
    <button className="outline-button" disabled={busy} onClick={()=>clearing ? void change(async()=>{await window.gitcat.clearActivityHistory(path);setClearing(false);}) : setClearing(true)}>{clearing ? text('Confirm: clear this project history','Confirmar: borrar historial de este proyecto') : text('Clear this project history','Borrar historial de este proyecto')}</button>
    {clearing && <button className="ghost-button" onClick={()=>setClearing(false)}>{text('Cancel','Cancelar')}</button>}
    {error && <p role="alert">{error}</p>}
    {!entries.length && <p>{text('No retained operations for this project.','No hay operaciones conservadas de este proyecto.')}</p>}
    {entries.map(entry=><article key={entry.id} className="activity-record">
      <strong>{new Date(entry.startedAt).toLocaleString(locale)} · {text(entry.state, entry.state === 'completed' ? 'completada' : entry.state === 'failed' ? 'necesita atención' : 'resultado por comprobar')}</strong>
      <p>{entry.before.branch} · <code>{entry.before.head.slice(0,7) || '—'}</code> → {entry.after?.branch ?? '—'} · <code>{entry.after?.head.slice(0,7) ?? '—'}</code></p>
      <ol>{entry.steps.map((step,i)=><li key={i}>{step.operation} · {text(step.status, ({pending:'por comprobar',completed:'completado',failed:'fallido',skipped:'omitido'})[step.status])}{step.afterHead && <> · <code>{step.afterHead.slice(0,7)}</code></>}</li>)}</ol>
      {entry.error && <p>{entry.error}</p>}
      <div className="modal-actions">
        {entry.steps.some(s=>s.operation==='commit' && s.status==='completed') && <>
          <button className="outline-button" onClick={()=>onRecover(entry.id,'revert')}>{text('Review a revert','Revisar una reversión')}</button>
          <button className="outline-button" onClick={()=>onRecover(entry.id,'undo')}>{text('Check unpublished undo','Comprobar deshacer guardado no publicado')}</button>
        </>}
        {entry.before.head && <button className="outline-button" onClick={()=>onRecover(entry.id,'restore')}>{text('Review recovery branch','Revisar rama de recuperación')}</button>}
      </div>
    </article>)}
  </section></div>;
}
