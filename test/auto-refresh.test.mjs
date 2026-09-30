import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRefreshIntervalMs, backgroundFetchDue, refreshedProject, remoteRefreshIntervalMs } from '../dist-electron/shared/auto-refresh.js';
const snapshot = (stateId, extra = {}) => ({ path: '/repo', stateId, currentBranch: 'main', ...extra });
const project = (value) => ({ id: 'tab', snapshot: value, loadedAt: '2026-09-25T10:00:00.000Z' });

test('sibling folder edits refresh the graph without changing the current operation binding', () => {
  const current = project(snapshot('same', { worktrees: [{ path: '/topic', changes: [] }] }));
  const latest = snapshot('same', { worktrees: [{ path: '/topic', changes: [{ path: 'new', status: 'A' }] }] });
  const next = refreshedProject(current, latest, 'now');
  assert.equal(next.snapshot, latest);
  assert.equal(next.snapshot.stateId, current.snapshot.stateId);
  assert.equal(refreshedProject(next, structuredClone(latest), 'later').snapshot, latest);
});

test('an unchanged repository keeps its snapshot and only records the new read time', () => {
  const current = project(snapshot('same'));
  const next = refreshedProject(current, snapshot('same', { currentBranch: 'stale-copy' }), '2026-09-25T10:00:30.000Z');
  assert.equal(next.snapshot, current.snapshot);
  assert.equal(next.loadedAt, '2026-09-25T10:00:30.000Z');
  assert.equal(next.fetchedAt, undefined);
  assert.equal(next.id, 'tab');
});

test('changes made outside GitCat replace the snapshot, and a remote check records when it happened', () => {
  const current = project(snapshot('before'));
  const latest = snapshot('after', { currentBranch: 'feature' });
  const next = refreshedProject(current, latest, '2026-09-25T10:00:30.000Z', '2026-09-25T10:00:30.000Z');
  assert.equal(next.snapshot, latest);
  assert.equal(next.fetchedAt, '2026-09-25T10:00:30.000Z');
  assert.equal(refreshedProject(next, latest, '2026-09-25T10:01:00.000Z').fetchedAt, '2026-09-25T10:00:30.000Z', 'A local read keeps the last remote check');
});

test('the remote is asked on first sight, then at a calm pace, and only when nothing waits on the user', () => {
  const now = 1_000_000_000;
  assert.equal(backgroundFetchDue({ hasRemote: true, awaitingDecision: false, now }), true);
  assert.equal(backgroundFetchDue({ hasRemote: true, awaitingDecision: false, lastAttempt: now - autoRefreshIntervalMs, now }), false);
  assert.equal(backgroundFetchDue({ hasRemote: true, awaitingDecision: false, lastAttempt: now - remoteRefreshIntervalMs, now }), true);
  assert.equal(backgroundFetchDue({ hasRemote: false, awaitingDecision: false, now }), false, 'No remote, nothing to ask');
  assert.equal(backgroundFetchDue({ hasRemote: true, awaitingDecision: true, now }), false, 'A waiting plan keeps the state it was prepared against');
});

test('local reads stay frequent and remote checks stay rare', () => {
  assert.ok(autoRefreshIntervalMs >= 10_000 && autoRefreshIntervalMs <= 120_000);
  assert.ok(remoteRefreshIntervalMs >= 2 * 60_000 && remoteRefreshIntervalMs <= 15 * 60_000);
});
