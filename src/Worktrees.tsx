import { useEffect, useState } from 'react';
import { TreePine, RefreshCcw } from 'lucide-react';
import type { Locale, RepoSnapshot } from '../shared/types';
import { useDialog } from './useDialog';

export function Worktrees({ snapshot, locale, onClose, onOpen }: {
  snapshot: RepoSnapshot; locale: Locale; onClose: () => void; onOpen: (project: RepoSnapshot) => void;
}) {
  const ref = useDialog(onClose);
  const [current, setCurrent] = useState(snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = (en: string, es: string) => locale === 'es' ? es : en;
  useEffect(() => { setCurrent(snapshot); }, [snapshot]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section ref={ref} className="commit-modal worktrees-dialog" role="dialog" aria-modal="true" aria-labelledby="worktrees-title">
    <div className="modal-heading"><h2 id="worktrees-title"><TreePine size={20} /> Worktrees</h2><button className="ghost-button" onClick={onClose}>{text('Close', 'Cerrar')}</button></div>
    <p>{text('Separate working folders for the same repository. Each has its own files and active branch. Opening one keeps your edits in their current folder.', 'Carpetas de trabajo separadas del mismo repositorio. Cada una tiene sus archivos y su rama activa. Al abrir otra, tus cambios permanecen en su carpeta actual.')}</p>
    <button className="outline-button" disabled={busy} onClick={() => void run(async () => setCurrent(await window.gitcat.getSnapshot(snapshot.path)))}><RefreshCcw size={14} /> {text('Refresh list', 'Actualizar lista')}</button>
    {error && <p role="alert">{error}</p>}
    <ul className="worktree-list">
      {(current.worktrees ?? []).map(worktree => <li key={worktree.path} className={worktree.isCurrent ? 'current' : ''}>
        <TreePine size={18} aria-hidden="true" />
        <div className="worktree-info">
          <strong>{worktree.branch || (worktree.bare ? text('Bare repository', 'Repositorio sin carpeta de trabajo') : worktree.detached ? text('Detached — no active branch', 'Separado — sin rama activa') : text('No saved version yet', 'Sin versión guardada todavía'))}</strong>
          <code>{worktree.path}</code>
          <span>{worktree.isMain ? text('Main folder', 'Carpeta principal') : text('Linked worktree', 'Worktree vinculado')}{worktree.isCurrent && ` · ${text('Open here', 'Abierto aquí')}`}{worktree.head && ` · ${worktree.head.slice(0, 7)}`}</span>
          {worktree.changes && <span>{worktree.changes.length ? text(`${worktree.changes.length} files with uncommitted changes`, `${worktree.changes.length} archivos con cambios sin guardar`) : text('No uncommitted changes', 'Sin cambios sin guardar')}</span>}
          {worktree.statusUnavailable && <span>{text('Could not read this folder — check its location, then refresh', 'No se pudo leer esta carpeta — revisa su ubicación y actualiza')}</span>}
          {worktree.locked !== undefined && <span>{text('Locked against removal', 'Protegido contra eliminación')}{worktree.locked && `: ${worktree.locked}`}</span>}
          {worktree.prunable !== undefined && <span>{text('Unavailable — check the folder, then refresh', 'No disponible — revisa la carpeta y actualiza')}{worktree.prunable && `: ${worktree.prunable}`}</span>}
        </div>
        {!worktree.isCurrent && !worktree.bare && <button className="outline-button" disabled={busy || worktree.prunable !== undefined}
          aria-label={`${text('Open worktree', 'Abrir worktree')}: ${worktree.path}`}
          onClick={() => void run(async () => { const next = await window.gitcat.openWorktree(snapshot.path, worktree.path, locale); onClose(); onOpen(next); })}>{text('Open', 'Abrir')}</button>}
      </li>)}
    </ul>
  </section></div>;
}
