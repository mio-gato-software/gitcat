import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './readiness.js';
import { redactText } from './outbound-content.js';
import type { ActivityRecord, ActionPlan, RepoSnapshot, StepOutcome } from '../shared/types.js';

type Store = { retentionDays: number; entries: ActivityRecord[] };
export class ActivityHistory {
  constructor(private path: string) {}
  private read(): Store {
    if (!existsSync(this.path)) return { retentionDays: 30, entries: [] };
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as Store;
    if (![0,7,30,90].includes(value.retentionDays) || !Array.isArray(value.entries)) throw new Error('Activity history could not be read. No operation has been started.');
    return value;
  }
  private write(store: Store) {
    const cutoff = Date.now() - store.retentionDays * 86400000;
    store.entries = store.retentionDays ? store.entries.filter(e => Date.parse(e.startedAt) >= cutoff).slice(-2000) : [];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 }); renameSync(temporary, this.path);
  }
  list(repoPath: string) {
    const store = this.read();
    return { retentionDays: store.retentionDays, entries: store.entries.filter(e => e.repoPath === repoPath && Date.parse(e.startedAt) >= Date.now()-store.retentionDays*86400000).reverse() };
  }
  retention(days: number) { if (![0,7,30,90].includes(days)) throw new Error('Invalid retention.'); const s=this.read(); s.retentionDays=days; this.write(s); }
  clear(repoPath: string) { const s=this.read(); s.entries=s.entries.filter(e=>e.repoPath!==repoPath); this.write(s); }
  begin(plan: ActionPlan, before: RepoSnapshot): string | undefined {
    const s=this.read(); if (!s.retentionDays) return;
    const id=randomUUID();
    s.entries.push({ id, repoPath:before.path, startedAt:new Date().toISOString(), state:'running', before:{ head:before.head, branch:before.currentBranch },
      steps:plan.steps.map(step=>({ operation:step.operation, status:'pending' })) });
    this.write(s); return id;
  }
  step(id: string | undefined, index: number, outcome: StepOutcome, before: RepoSnapshot, after: RepoSnapshot) {
    if (!id) return;
    const s=this.read(), entry=s.entries.find(e=>e.id===id); if (!entry) return;
    entry.steps[index]={ ...entry.steps[index], status:outcome.status, beforeHead:before.head, afterHead:after.head, at:new Date().toISOString() };
    this.write(s);
  }
  finish(id: string | undefined, snapshot: RepoSnapshot | undefined, outcomes: StepOutcome[], error?: string) {
    if (!id) return;
    const s=this.read(), entry=s.entries.find(e=>e.id===id); if (!entry) return;
    entry.state=error ? 'failed':'completed'; entry.finishedAt=new Date().toISOString();
    if (snapshot) entry.after={head:snapshot.head,branch:snapshot.currentBranch};
    entry.steps=entry.steps.map((step,i)=>({...step,status:outcomes[i]?.status ?? step.status}));
    if (error) entry.error=redactSecrets(redactText(error).text).slice(0,1000);
    this.write(s);
  }
}
