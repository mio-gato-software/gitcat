import { useState } from 'react';
import { useDialog } from './useDialog';
import type { Locale,RepoSnapshot,ShareReviewPreview,ReviewPullRequest } from '../shared/types';

export function ShareReview({snapshot,head,locale,onClose,onUpdated}:{snapshot:RepoSnapshot;head:string;locale:Locale;onClose:()=>void;onUpdated:(snapshot:RepoSnapshot)=>void}) {
 const ref=useDialog(onClose),[remote,setRemote]=useState(snapshot.remotes[0]??''),[branch,setBranch]=useState(head),[base,setBase]=useState(snapshot.defaultBranch??'main'),[title,setTitle]=useState(head),[body,setBody]=useState('');
 const [preview,setPreview]=useState<ShareReviewPreview>(),[result,setResult]=useState<ReviewPullRequest>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const text=(en:string,es:string)=>locale==='es'?es:en;
 const check=async()=>{setBusy(true);setError('');setPreview(undefined);setResult(undefined);try{setPreview(await window.gitcat.previewReview(snapshot.path,{remote,head:branch,base,title,body}));}catch(e){setError(String(e));}finally{setBusy(false);}};
 const publish=async()=>{if(!preview||busy)return;setBusy(true);setError('');try{const answer=await window.gitcat.publishReview(snapshot.path,preview.id);setResult(answer.pullRequest);onUpdated(answer.snapshot);}catch(e){setError(String(e));}finally{setBusy(false);setPreview(undefined);}};
 const edit=(setter:(value:string)=>void,value:string)=>{setter(value);setPreview(undefined);setResult(undefined);};
 return <div className="modal-backdrop"><section ref={ref} className="commit-modal wide share-review" role="dialog" aria-modal="true" aria-labelledby="share-review-title">
  <div className="modal-heading"><h2 id="share-review-title">{text('Share for review','Compartir para revisión')}</h2><button className="ghost-button" onClick={onClose}>{text('Close','Cerrar')}</button></div>
  <p>{text('Publish saved commits from a chosen branch and request review on GitHub. Unsaved files stay on this computer. Local integration remains available separately.','Publica commits guardados de una rama y solicita revisión en GitHub. Los archivos sin guardar quedan en este equipo. La integración local sigue disponible por separado.')}</p>
  <fieldset disabled={busy}>
   <label>{text('Remote','Remoto')}<select value={remote} onChange={e=>edit(setRemote,e.target.value)}>{snapshot.remotes.map(r=><option key={r}>{r}</option>)}</select></label>
   <label>{text('Your branch','Tu rama')}<select value={branch} onChange={e=>edit(setBranch,e.target.value)}>{snapshot.branches.filter(b=>b.presence!=='remote').map(b=><option key={b.name}>{b.name}</option>)}</select></label>
   <label>{text('Remote base branch','Rama base remota')}<input value={base} onChange={e=>edit(setBase,e.target.value)} /></label>
   <label>{text('Review title','Título de la revisión')}<input value={title} maxLength={250} onChange={e=>edit(setTitle,e.target.value)} /></label>
   <label>{text('Description','Descripción')}<textarea value={body} maxLength={8000} onChange={e=>edit(setBody,e.target.value)} /></label>
  </fieldset>
  {!snapshot.remotes.length && <p>{text('Connect a remote in Settings first.','Conecta primero un remoto en Ajustes.')}</p>}
  {error && <p role="alert">{error}</p>}
  {busy && <p role="status">{text('Checking GitHub and the repository…','Consultando GitHub y el repositorio…')}</p>}
  <button className="outline-button" disabled={busy||!remote||!title.trim()||!base} onClick={()=>void check()}>{text('Check account, commits and live review status','Comprobar cuenta, commits y estado real de revisión')}</button>
  {preview && <div className="activity-record">
   <p><strong>{preview.repository}</strong> · {preview.remoteUrl}</p>
   <p>{text('Verified account','Cuenta verificada')}: <strong>{preview.account}</strong></p>
   <p>{preview.request.head} → {preview.request.base} · {preview.checkedAt}</p>
   <p>{text('Commits to publish','Commits que se publicarán')}: {preview.commits.length}</p>
   <ul>{preview.commits.map(c=><li key={c.hash}><code>{c.hash.slice(0,7)}</code> {c.subject}</li>)}</ul>
   {preview.existing && <p>{text('Live GitHub status','Estado real en GitHub')}: {preview.existing.state} <button className="ghost-button" onClick={()=>void window.gitcat.openReview(preview.existing!.url)}>{preview.existing.url}</button></p>}
   <p>{text('Confirmation publishes only these saved commits, then creates or updates an open review. It does not merge, force-push, or bypass branch protections.','La confirmación publica solo estos commits guardados y luego crea o actualiza una revisión abierta. No integra, fuerza la publicación ni evita protecciones de ramas.')}</p>
   <button className="primary-button" disabled={busy||!preview.reviewable} onClick={()=>void publish()}>{preview.existing?.state==='OPEN'?text('Publish to this review','Publicar en esta revisión'):text('Publish and create a new review','Publicar y crear una revisión nueva')}</button>
  </div>}
  {result && <p role="status">{result.state} · <button className="outline-button" onClick={()=>void window.gitcat.openReview(result.url)}>{result.url}</button></p>}
 </section></div>;
}
