import { useEffect, useState } from 'react';
import type { OperationProgress } from '../shared/types';
import type { Translate } from './i18n';

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <span aria-live="off">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

export function OperationStatus({ path, t }: { path?: string; t: Translate }) {
  const [operations, setOperations] = useState<Record<string, OperationProgress>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const seen = new Set<string>();
    const receive = (value: OperationProgress) => {
      seen.add(value.id);
      if (alive) setOperations(previous => ({ ...previous, [value.repoPath]: value }));
    };
    const stop = window.gitcat.onOperationProgress(receive);
    void window.gitcat.listOperations().then(values => values.forEach(value => { if (!seen.has(value.id)) receive(value); })).catch(() => undefined);
    return () => { alive = false; stop(); };
  }, []);
  const progress = path ? operations[path] : undefined;
  if (!progress) return null;
  const running = progress.state === 'running';
  return <div className="operation-status">
    <span role="status">{t(`operation_${progress.state === 'running' ? progress.stopping ? 'stopping' : progress.phase : progress.state}`)}
      {progress.step && <> · {t('operationStep', { step: progress.step, total: progress.total ?? progress.step })}</>}
    </span>
    {running && <Elapsed since={progress.startedAt} />}
    {running && <><small>{t(progress.mutation ? 'operationMutationNote' : 'operationReadNote')}</small>
      <button className="outline-button small" disabled={progress.stopping} onClick={() => {
        setError('');
        void window.gitcat.cancelOperation(progress.repoPath, progress.id).catch(() => setError(t('operationCancelFailed')));
      }}>{t(progress.mutation ? 'operationStopNext' : 'cancel')}</button></>}
    {!running && <button className="ghost-button small" onClick={() => setOperations(previous => { const next = { ...previous }; delete next[progress.repoPath]; return next; })}>{t('close')}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
