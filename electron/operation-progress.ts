import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { OperationProgress } from '../shared/types.js';

export class OperationCancelled extends Error {
  constructor() { super('Operation stopped. Completed changes remain; nothing was rolled back.'); }
}
type Context = { signal: AbortSignal; mutation: boolean; inspecting: boolean; update: (patch: Partial<OperationProgress>) => void };
const context = new AsyncLocalStorage<Context>();
const running = new Map<string, { controller: AbortController; progress: OperationProgress; notify: (value: OperationProgress) => void }>();
export const operationContext = () => context.getStore();
export function operationCheckpoint() {
  if (context.getStore()?.signal.aborted) throw new OperationCancelled();
}
export function operationPhase(phase: OperationProgress['phase'], step?: number, total?: number) {
  context.getStore()?.update({ phase, step, total });
}
export async function inspectOperation<T>(task: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  return current ? context.run({ ...current, inspecting: true }, task) : task();
}
export function listOperations(): OperationProgress[] { return [...running.values()].map(item => ({ ...item.progress })); }
export function cancelOperation(repoPath: string, id: string): boolean {
  const entry = running.get(repoPath);
  if (!entry || entry.progress.id !== id) return false;
  entry.controller.abort();
  entry.progress = { ...entry.progress, stopping: true };
  entry.notify(entry.progress);
  return true;
}
export async function trackOperation<T>(repoPath: string, phase: OperationProgress['phase'], notify: (value: OperationProgress) => void, task: () => Promise<T>, mutation = false): Promise<T> {
  if (running.has(repoPath)) throw new Error('An operation is already running for this project. Wait for it or stop it first.');
  const entry = { controller: new AbortController(), progress: { id: randomUUID(), repoPath, phase, startedAt: Date.now(), state: 'running', mutation, stopping: false } as OperationProgress, notify };
  running.set(repoPath, entry);
  const update = (patch: Partial<OperationProgress>) => { entry.progress = { ...entry.progress, ...patch }; notify(entry.progress); };
  notify(entry.progress);
  try {
    const result = await context.run({ signal: entry.controller.signal, mutation, inspecting: false, update }, async () => {
      operationCheckpoint();
      const value = await task();
      // Providers may ignore abort or finish concurrently. A late plan must not become executable.
      if (!mutation) operationCheckpoint();
      return value;
    });
    const failed = Boolean(result && typeof result === 'object' && 'error' in result && result.error);
    update({ state: entry.controller.signal.aborted ? 'stopped' : failed ? 'failed' : 'completed' });
    return result;
  } catch (error) {
    update({ state: entry.controller.signal.aborted ? 'stopped' : 'failed' });
    throw error;
  } finally { running.delete(repoPath); }
}
