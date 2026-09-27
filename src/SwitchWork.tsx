import { useEffect, useState } from 'react';
import { useDialog } from './useDialog';
import type { Locale, SwitchWorkPreview, SwitchWorkRequest } from '../shared/types';

export function SwitchWork({ path, target, locale, onClose, onSave, onPrepare }: { path:string;target:string;locale:Locale;onClose:()=>void;onSave:()=>void;onPrepare:(request:SwitchWorkRequest)=>void }) {
 const ref=useDialog(onClose), [preview,setPreview]=useState<SwitchWorkPreview>(),[error,setError]=useState(''),[label,setLabel]=useState(''),[untracked,setUntracked]=useState(false);
 const text=(en:string,es:string)=>locale==='es'?es:en;
 useEffect(()=>{let alive=true;void window.gitcat.getSwitchWork(path,target).then(value=>{if(alive)setPreview(value);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[path,target]);
 const switching=preview && preview.snapshot.currentBranch!==target;
 return <div className="modal-backdrop"><section ref={ref} className="commit-modal wide switch-work" role="dialog" aria-modal="true" aria-labelledby="switch-work-title">
  <div className="modal-heading"><h2 id="switch-work-title">{text('Unfinished work','Trabajo sin terminar')}</h2><button className="ghost-button" onClick={onClose}>{text('Keep working here','Seguir aquí')}</button></div>
  {error && <p role="alert">{error}</p>}
  {!preview && !error && <p role="status">{text('Reading current work…','Leyendo el trabajo actual…')}</p>}
  {preview && <>
   <p>{text('Active branch','Rama activa')}: <strong>{preview.snapshot.currentBranch}</strong>{switching && <> → <strong>{target}</strong></>}</p>
   {preview.occupied && <p role="alert">{text('This branch is open in another folder. Open that folder as a project; no files have moved.','Esta rama está abierta en otra carpeta. Abre esa carpeta como proyecto; no se movió ningún archivo.')} <code>{preview.occupied}</code></p>}
   {preview.snapshot.isDirty && <>
    <p>{text('These files have not been saved in a commit. Choose where they should remain before switching.','Estos archivos no están guardados en un commit. Elige dónde deben quedar antes de cambiar.')}</p>
    <ul>{preview.snapshot.changes.map(file=><li key={file.path}><code>{file.path}</code> · {file.xy}</li>)}</ul>
    <button className="outline-button" onClick={onSave}>{text('Review and save selected work here first','Revisar y guardar aquí el trabajo seleccionado primero')}</button>
    <p className="detail-note">{text('Saving opens file selection. Return to switching when the save is finished; excluded work stays untouched.','Guardar abre la selección de archivos. Vuelve a cambiar cuando termines de guardar; lo excluido queda intacto.')}</p>
   </>}
   {switching && !preview.occupied && <>
    {preview.blockers.length>0 && <p>{text('Cannot carry these overlapping edits safely:','No se pueden llevar con seguridad estos cambios que coinciden:')} {preview.blockers.join(', ')}</p>}
    <button className="outline-button" disabled={preview.blockers.length>0} onClick={()=>onPrepare({mode:'carry',target})}>{text('Review carrying edits to','Revisar llevar los cambios a')} {target}</button>
    {preview.snapshot.isDirty && <fieldset><legend>{text('Set work aside before switching','Apartar el trabajo antes de cambiar')}</legend>
      <p>{text('Tracked edits and their staged state go into a named entry. Ignored files stay here. Nothing is automatically restored or deleted.','Los cambios seguidos y su estado preparado van a una entrada con nombre. Los archivos ignorados quedan aquí. Nada se restaura ni borra automáticamente.')}</p>
      <label>{text('Name','Nombre')} <input value={label} maxLength={120} onChange={e=>setLabel(e.target.value)} /></label>
      <label><input type="checkbox" checked={untracked} onChange={e=>setUntracked(e.target.checked)} />{text('Include new, untracked files','Incluir archivos nuevos, sin seguimiento')}</label>
      <button className="outline-button" disabled={!label.trim()} onClick={()=>onPrepare({mode:'set_aside',target,label,includeUntracked:untracked})}>{text('Review setting aside and switching','Revisar apartar y cambiar')}</button>
    </fieldset>}
   </>}
   <h3>{text('Set-aside entries on this computer','Entradas apartadas en este equipo')}</h3>
   <p>{text('Entries survive restarts. Restore previews the current branch and preserves staged state. Conflicts can occur; the entry stays available. Save any current edits first.','Las entradas sobreviven a los reinicios. Restaurar muestra la rama actual y conserva el estado preparado. Puede haber conflictos; la entrada queda disponible. Guarda primero los cambios actuales.')}</p>
   {!preview.entries.length && <p>{text('No GitCat set-aside entries yet.','Todavía no hay entradas apartadas por GitCat.')}</p>}
   {preview.entries.map(entry=><div className="activity-record" key={entry.hash}><p>{entry.label}</p><button className="outline-button" disabled={preview.snapshot.isDirty} onClick={()=>onPrepare({mode:'restore',stash:entry.hash})}>{text('Review restoring on','Revisar restaurar en')} {preview.snapshot.currentBranch}</button></div>)}
  </>}
 </section></div>;
}
