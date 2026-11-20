import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './readiness.js';
import { redactText } from './outbound-content.js';
import type { ActionPlan, ActivityOperation, ActivityRecord, RepoSnapshot, StepOutcome } from '../shared/types.js';

type Store = { retentionDays: number; entries: ActivityRecord[] };
type ActivityPlan = Pick<ActionPlan, 'switchWork' | 'recovery'> & { steps: { operation: ActivityOperation }[] };
const retentionDays = [0, 7, 30, 90];
const states = new Set(['running', 'completed', 'failed']);
const statuses = new Set(['pending', 'completed', 'failed', 'skipped']);

export class InvalidActivityHistoryError extends Error {
  constructor() {
    super('Activity history cannot be read. Open Activity and recovery to keep a copy and start a new history before confirming another operation.');
  }
}

function emptyStore(): Store {
  return { retentionDays: 30, entries: [] };
}

function validPoint(value: ActivityRecord['before'] | undefined) {
  return value && typeof value.head === 'string' && typeof value.branch === 'string';
}

function validEntry(entry: ActivityRecord) {
  return entry && typeof entry.id === 'string' && typeof entry.repoPath === 'string'
    && typeof entry.startedAt === 'string' && states.has(entry.state) && validPoint(entry.before)
    && (entry.after === undefined || validPoint(entry.after))
    && Array.isArray(entry.steps) && entry.steps.every(step => step && typeof step.operation === 'string'
      && statuses.has(step.status) && (step.afterHead === undefined || typeof step.afterHead === 'string'))
    && (entry.error === undefined || typeof entry.error === 'string');
}

function recordedOperation(plan: ActivityPlan, operation: ActivityOperation): ActivityOperation {
  if (operation !== 'git_command') return operation;
  // The journal keeps the confirmed intent without copying arguments or command text.
  if (plan.switchWork?.mode === 'set_aside') return 'set_aside_work';
  if (plan.switchWork?.mode === 'restore') return 'restore_set_aside_work';
  switch (plan.recovery?.mode) {
    case 'undo': return 'undo_save';
    case 'revert': return 'revert_save';
    case 'restore': return 'create_recovery_branch';
    default: return operation;
  }
}

export class ActivityHistory {
  constructor(private path: string) {}
  private read(): Store {
    let contents: string;
    try { contents = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      throw error;
    }
    let value: Store;
    try { value = JSON.parse(contents); }
    catch { throw new InvalidActivityHistoryError(); }
    if (!value || !retentionDays.includes(value.retentionDays) || !Array.isArray(value.entries) || !value.entries.every(validEntry)) {
      throw new InvalidActivityHistoryError();
    }
    return value;
  }
  private write(store: Store) {
    const cutoff = Date.now() - store.retentionDays * 86400000;
    store.entries = store.retentionDays ? store.entries.filter(e => Date.parse(e.startedAt) >= cutoff).slice(-2000) : [];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Report the write failure. */ }
      throw error;
    }
  }
  repair(): string | undefined {
    try {
      this.read();
      return undefined;
    } catch (error) {
      if (!(error instanceof InvalidActivityHistoryError)) throw error;
    }
    const backup = `${this.path}.unreadable-${randomUUID()}`;
    // Preserve the original bytes in a private copy before replacing anything.
    writeFileSync(backup, readFileSync(this.path), { flag: 'wx', mode: 0o600 });
    this.write(emptyStore());
    return backup;
  }
  list(repoPath: string) {
    const store = this.read();
    return { retentionDays: store.retentionDays, entries: store.entries.filter(e => e.repoPath === repoPath && Date.parse(e.startedAt) >= Date.now()-store.retentionDays*86400000).reverse() };
  }
  retention(days: number) { if (!retentionDays.includes(days)) throw new Error('Invalid retention.'); const s=this.read(); s.retentionDays=days; this.write(s); }
  clear(repoPath: string) { const s=this.read(); s.entries=s.entries.filter(e=>e.repoPath!==repoPath); this.write(s); }
  begin(plan: ActivityPlan, before: RepoSnapshot): string | undefined {
    const s=this.read(); if (!s.retentionDays) return;
    const id=randomUUID();
    s.entries.push({ id, repoPath:before.path, startedAt:new Date().toISOString(), state:'running', before:{ head:before.head, branch:before.currentBranch },
      steps:plan.steps.map(step=>({ operation:recordedOperation(plan, step.operation), status:'pending' })) });
    this.write(s); return id;
  }
  step(id: string | undefined, index: number, outcome: StepOutcome, before: RepoSnapshot, after?: RepoSnapshot, afterHead?: string) {
    if (!id) return;
    const s=this.read(), entry=s.entries.find(e=>e.id===id); if (!entry) return;
    const recordedAfterHead = afterHead ?? outcome.commitHash ?? after?.head;
    entry.steps[index]={
      ...entry.steps[index],
      status:outcome.status,
      beforeHead:before.head,
      ...(recordedAfterHead !== undefined ? { afterHead: recordedAfterHead } : {}),
      at:new Date().toISOString()
    };
    this.write(s);
  }
  finish(id: string | undefined, snapshot: RepoSnapshot | undefined, outcomes: StepOutcome[], error?: string) {
    if (!id) return;
    const s=this.read(), entry=s.entries.find(e=>e.id===id); if (!entry) return;
    entry.state=error ? 'failed':'completed'; entry.finishedAt=new Date().toISOString();
    if (snapshot) entry.after={head:snapshot.head,branch:snapshot.currentBranch};
    entry.steps=entry.steps.map((step,i)=>({
      ...step,
      status:outcomes[i]?.status ?? step.status,
      ...(outcomes[i]?.commitHash && !step.afterHead ? { afterHead: outcomes[i].commitHash } : {})
    }));
    if (error) entry.error=redactSecrets(redactText(error).text).slice(0,1000);
    this.write(s);
  }
}
