import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRefreshIntervalMs, refreshedProject } from '../dist-electron/shared/auto-refresh.js';
const snapshot = (stateId, extra = {}) => ({ path: '/repo', stateId, currentBranch: 'main', ...extra });
const project = (value) => ({ id: 'tab', snapshot: value, loadedAt: '2026-09-25T10:00:00.000Z' });

test('an unchanged repository keeps its snapshot and only records the new read time', () => {
  const current = project(snapshot('same'));
  const next = refreshedProject(current, snapshot('same', { currentBranch: 'stale-copy' }), '2026-09-25T10:00:30.000Z');
  assert.equal(next.snapshot, current.snapshot);
  assert.equal(next.loadedAt, '2026-09-25T10:00:30.000Z');
  assert.equal(next.id, 'tab');
});

test('changes made outside GitCat replace the snapshot', () => {
  const current = project(snapshot('before'));
  const latest = snapshot('after', { currentBranch: 'feature' });
  assert.equal(refreshedProject(current, latest, '2026-09-25T10:00:30.000Z').snapshot, latest);
});

test('the background read interval stays between ten seconds and two minutes', () => {
  assert.ok(autoRefreshIntervalMs >= 10_000 && autoRefreshIntervalMs <= 120_000);
});
