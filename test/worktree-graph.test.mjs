import test from 'node:test';
import assert from 'node:assert/strict';
import { graphWorktrees, withWorktreeWork, worktreeWipHash } from '../dist-electron/shared/worktree-graph.js';
import { buildCommitGraph } from '../dist-electron/shared/commit-graph.js';

const commit = (hash, parents = [], refs = []) => ({ hash, shortHash: hash, subject: hash, author: '', email: '', date: '', refs, parents });
const worktree = (path, head, branch, extra = {}) => ({ path, head, branch, isCurrent: false, isMain: false, bare: false, detached: false, changes: [{ path: 'file', code: 'M', xy: ' M' }], ...extra });

test('each WIP sits just above its own HEAD; shared tips converge without losing branch labels', () => {
  const folders = [worktree('/main', 'm', 'main', { isCurrent: true }), worktree('/topic', 't', 'topic'), worktree('/shared', 't', 'other')];
  const commits = [commit('m', ['base'], ['HEAD -> main']), commit('t', ['base'], ['topic', 'other']), commit('base')];
  const listed = withWorktreeWork(commits, folders);
  assert.deepEqual(listed.map(c => c.hash), ['working-tree', 'm', 'working-tree:/topic', 'working-tree:/shared', 't', 'base']);
  assert.equal(listed.find(c => c.hash === 't'), commits[1]);
  const graph = buildCommitGraph(listed, [], 'main');
  const tip = graph.rows.find(row => row.commit.hash === 't');
  assert.equal(tip.incoming.length, 2);
  for (const folder of folders) {
    const wip = graph.rows.find(row => row.commit.hash === worktreeWipHash(folder));
    assert.deepEqual(wip.commit.parents, [folder.head]);
    assert.ok(graph.rows.find(row => row.commit.hash === folder.head).incoming.includes(wip.outgoing[0]));
  }
});

test('scope includes only its folders; clean, bare and unavailable entries do not invent work', () => {
  const folders = [worktree('/main', 'm', 'main'), worktree('/topic', 't', 'topic'), worktree('/detached', 'd', undefined, { detached: true }),
    worktree('/clean', 'c', 'clean', { changes: [] }), worktree('/bare', 'b', 'bare', { bare: true }),
    worktree('/gone', 'g', 'gone', { prunable: '' }), worktree('/failed', 'f', 'failed', { statusUnavailable: true })];
  const snapshot = { worktrees: folders };
  assert.deepEqual(graphWorktrees(snapshot, 'all'), folders.slice(0, 3));
  assert.deepEqual(graphWorktrees(snapshot, 'branch', 'topic'), [folders[1]]);
  assert.deepEqual(graphWorktrees(snapshot, 'branch-only', 'main'), [folders[0]]);
  const currentDetached = { ...folders[2], isCurrent: true };
  assert.deepEqual(graphWorktrees({ worktrees: [currentDetached] }, 'branch', 'HEAD'), [currentDetached]);
  const detached = withWorktreeWork([commit('d')], [folders[2]])[0];
  assert.deepEqual(detached.refs, []);
  assert.deepEqual(detached.parents, ['d']);
  assert.deepEqual(withWorktreeWork([commit('m')], [folders[1]]).map(c => c.hash), ['m'], 'WIP outside the loaded history waits for its parent page');
});
