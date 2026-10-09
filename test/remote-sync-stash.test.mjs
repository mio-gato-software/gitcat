import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, n) { return s === 'electron' ? { url: new URL('./helpers/electron-stub.mjs', import.meta.url).href, shortCircuit: true } : n(s, c); } });
const service = await import('../dist-electron/electron/git-service.js');
const { planSummary } = await import('../dist-electron/shared/plan-summary.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gitcat-sync-stash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'local'), remote = join(root, 'remote.git'), writer = join(root, 'writer');
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(root, 'init', '-q', '-b', 'main', path);
  const git = (...args) => run(path, ...args);
  git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@example.test');
  writeFileSync(join(path, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  run(root, 'clone', '-q', '--bare', path, remote); git('remote', 'add', 'origin', remote); git('fetch', '-q', 'origin');
  run(root, 'clone', '-q', remote, writer);
  const writeGit = (...args) => run(writer, ...args);
  writeGit('config', 'user.name', 'QA'); writeGit('config', 'user.email', 'qa@example.test');
  const remoteCommit = (file = 'remote.txt', content = 'remote\n', destination = 'origin') => {
    writeFileSync(join(writer, file), content); writeGit('add', '.'); writeGit('commit', '-qm', 'remote work'); writeGit('push', '-q', destination, 'main');
    return writeGit('rev-parse', 'HEAD');
  };
  return { root, path, remote, writer, run, git, writeGit, remoteCommit };
}

test('remote double-click preparation fetches and updates the local counterpart without an upstream', async t => {
  const { path, git, remoteCommit } = fixture(t);
  const target = remoteCommit(); git('switch', '-qc', 'feature/work');
  const plan = await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en');
  assert.equal(git('branch', '--show-current'), 'feature/work');
  assert.deepEqual(plan.steps.map(s => s.operation), ['checkout', 'sync_remote']);
  assert.equal(plan.steps[1].args.mode, 'ff'); assert.equal(plan.requiresConfirmation, true);
  assert.ok(planSummary(plan, await service.getSnapshot(path), 'en').local.some(s => s.includes('keeping your local commits')));
  const result = await service.executePlan(path, plan, 'en');
  assert.equal(result.error, undefined); assert.equal(git('branch', '--show-current'), 'main'); assert.equal(git('rev-parse', 'HEAD'), target);
  const main = result.snapshot.branches.find(b => b.name === 'main');
  assert.equal(main.remoteAhead, 0); assert.equal(main.remoteBehind, 0); assert.equal(main.upstream, undefined);
});

test('diverged copies merge while preserving both histories and leave the server unchanged', async t => {
  const { path, git, remoteCommit } = fixture(t);
  writeFileSync(join(path, 'local.txt'), 'local\n'); git('add', '.'); git('commit', '-qm', 'local work'); const local = git('rev-parse', 'HEAD');
  const remote = remoteCommit(); git('fetch', '-q');
  const main = (await service.getSnapshot(path)).branches.find(b => b.name === 'main');
  assert.equal(main.remoteAhead, 1); assert.equal(main.remoteBehind, 1);
  const plan = await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'es');
  assert.equal(plan.steps[0].args.mode, 'merge');
  const result = await service.executePlan(path, plan, 'es'); assert.equal(result.error, undefined);
  git('merge-base', '--is-ancestor', local, 'HEAD'); git('merge-base', '--is-ancestor', remote, 'HEAD');
  assert.equal(git('rev-parse', 'origin/main'), remote); assert.equal(readFileSync(join(path, 'local.txt'), 'utf8'), 'local\n');
  assert.equal(result.snapshot.branches.find(b => b.name === 'main').remoteBehind, 0);
});

test('ahead and equal copies are honest no-ops; dirty or occupied copies are guided before mutation', async t => {
  const { path, root, git } = fixture(t);
  assert.equal((await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en')).allowed, false);
  writeFileSync(join(path, 'mine.txt'), 'mine');
  await assert.rejects(service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en'), /Stash/);
  git('add', '.'); git('commit', '-qm', 'mine');
  assert.equal((await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en')).allowed, false);
  git('switch', '-qc', 'other'); git('worktree', 'add', '-q', join(root, 'occupied'), 'main');
  await assert.rejects(service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en'), /open in/);
  assert.equal(git('branch', '--show-current'), 'other');
});

test('a conflicting remote update retains both tips and exposes an abortable merge', async t => {
  const { path, git, remoteCommit } = fixture(t);
  writeFileSync(join(path, 'file.txt'), 'local edit\n'); git('commit', '-qam', 'local'); const local = git('rev-parse', 'HEAD');
  const remote = remoteCommit('file.txt', 'remote edit\n');
  const plan = await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en');
  const result = await service.executePlan(path, plan, 'en'); assert.ok(result.error); assert.equal(result.snapshot.pending.kind, 'merge');
  assert.equal(git('rev-parse', 'HEAD'), local); assert.equal(git('rev-parse', 'origin/main'), remote);
  assert.equal(result.snapshot.conflicts.length, 1);
  await service.executePlan(path, await service.prepareOperation(path, 'abort_operation', {}, 'en'), 'en');
  assert.equal(readFileSync(join(path, 'file.txt'), 'utf8'), 'local edit\n');
});

test('the exact selected remote wins, and remote-only checkout sets tracking explicitly', async t => {
  const { path, root, run, git, writeGit, remote, remoteCommit } = fixture(t);
  const mirror = join(root, 'mirror.git'); run(root, 'clone', '-q', '--bare', remote, mirror);
  git('remote', 'add', 'mirror', mirror); writeGit('remote', 'add', 'mirror', mirror);
  const target = remoteCommit('mirror.txt', 'mirror', 'mirror');
  const plan = await service.prepareOperation(path, 'sync_remote', { ref: 'mirror/main' }, 'en').catch(async error => {
    // The displayed reference must exist before it can be chosen.
    assert.match(error.message, /no longer exists/); git('fetch', '-q', 'mirror');
    return service.prepareOperation(path, 'sync_remote', { ref: 'mirror/main' }, 'en');
  });
  await service.executePlan(path, plan, 'en'); assert.equal(git('rev-parse', 'main'), target); assert.notEqual(git('rev-parse', 'origin/main'), target);
  writeGit('push', '-q', 'mirror', 'main:feature/shared'); git('fetch', '-q', 'mirror');
  const create = await service.prepareOperation(path, 'sync_remote', { ref: 'mirror/feature/shared' }, 'en');
  await service.executePlan(path, create, 'en'); assert.equal(git('branch', '--show-current'), 'feature/shared');
  assert.equal(git('rev-parse', '--abbrev-ref', '@{upstream}'), 'mirror/feature/shared');
});

test('a changed remote after review invalidates the update before checkout', async t => {
  const { path, git, remoteCommit } = fixture(t);
  remoteCommit(); git('switch', '-qc', 'other');
  const plan = await service.prepareOperation(path, 'sync_remote', { ref: 'origin/main' }, 'en');
  remoteCommit('another.txt'); git('fetch', '-q');
  await assert.rejects(service.executePlan(path, plan, 'en'), /changes moved/); assert.equal(git('branch', '--show-current'), 'other');
});

test('toolbar stash and pop round-trip staged, unstaged and untracked files on the same branch', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'file.txt'), 'staged\n'); git('add', 'file.txt'); const index = git('write-tree');
  writeFileSync(join(path, 'file.txt'), 'unstaged\n'); writeFileSync(join(path, 'new.txt'), 'new');
  const stash = await service.prepareOperation(path, 'stash_push', {}, 'en');
  assert.equal(stash.requiresConfirmation, true); assert.equal(git('stash', 'list'), '');
  assert.equal((await service.executePlan(path, stash, 'en')).error, undefined); assert.equal(git('status', '--porcelain'), '');
  assert.equal((await service.getSnapshot(path)).stashCount, 1); assert.equal(git('branch', '--show-current'), 'main');
  const pop = await service.prepareOperation(path, 'stash_pop', {}, 'en');
  assert.match(planSummary(pop, await service.getSnapshot(path), 'en').finalState.join(' '), /remain uncommitted/);
  assert.equal((await service.executePlan(path, pop, 'en')).error, undefined);
  assert.equal(git('write-tree'), index); assert.equal(readFileSync(join(path, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(readFileSync(join(path, 'new.txt'), 'utf8'), 'new'); assert.equal(git('stash', 'list'), '');
});

test('pop finds external stashes, rejects stale entries and keeps the stash on conflict', async t => {
  const { path, git } = fixture(t);
  await assert.rejects(service.prepareOperation(path, 'stash_pop', {}, 'en'), /Use Stash/);
  writeFileSync(join(path, 'file.txt'), 'stash one'); git('stash', 'push', '-qm', 'external');
  const pop = await service.prepareOperation(path, 'stash_pop', {}, 'en');
  writeFileSync(join(path, 'file.txt'), 'stash two'); git('stash', 'push', '-qm', 'new external');
  await assert.rejects(service.executePlan(path, pop, 'en'), /changes moved/); assert.equal((await service.getSnapshot(path)).stashCount, 2);
  writeFileSync(join(path, 'file.txt'), 'conflicting commit'); git('commit', '-qam', 'change');
  const current = await service.prepareOperation(path, 'stash_pop', {}, 'en');
  const result = await service.executePlan(path, current, 'en'); assert.ok(result.error);
  assert.equal((await service.getSnapshot(path)).stashCount, 2); assert.ok(result.snapshot.conflicts.length);
});

test('pop keeps unrelated new files and unstaged edits while restoring staged stash versions', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'other.txt'), 'base other\n'); git('add', '.'); git('commit', '-qm', 'other');
  writeFileSync(join(path, 'file.txt'), 'staged\n'); git('add', 'file.txt'); const index = git('write-tree');
  writeFileSync(join(path, 'file.txt'), 'unstaged\n'); writeFileSync(join(path, 'saved-new.txt'), 'saved new');
  git('stash', 'push', '-qu');
  writeFileSync(join(path, 'other.txt'), 'keep edits\n'); writeFileSync(join(path, 'current-new.txt'), 'keep new');
  const before = git('status', '--porcelain');
  const plan = await service.prepareOperation(path, 'stash_pop', {}, 'en');
  assert.equal(plan.requiresConfirmation, true); assert.equal(git('status', '--porcelain'), before);
  assert.match(plan.effects.join(' '), /current changes in other files are kept/);
  const result = await service.executePlan(path, plan, 'en'); assert.equal(result.error, undefined, result.error);
  assert.equal(readFileSync(join(path, 'other.txt'), 'utf8'), 'keep edits\n');
  assert.equal(readFileSync(join(path, 'current-new.txt'), 'utf8'), 'keep new');
  assert.equal(readFileSync(join(path, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(readFileSync(join(path, 'saved-new.txt'), 'utf8'), 'saved new');
  assert.equal(git('write-tree'), index); assert.equal(git('stash', 'list'), '');
});

test('pop names overlapping files and preserves current work and the stash before any mutation', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'file.txt'), 'saved edits'); git('stash', 'push', '-q');
  const hash = git('rev-parse', 'refs/stash');
  writeFileSync(join(path, 'file.txt'), 'keep current edits');
  const before = git('status', '--porcelain'), index = git('write-tree');
  await assert.rejects(service.prepareOperation(path, 'stash_pop', {}, 'en'), /file.txt.*Review and save.*stash is still available/);
  assert.equal(readFileSync(join(path, 'file.txt'), 'utf8'), 'keep current edits');
  assert.equal(git('status', '--porcelain'), before); assert.equal(git('write-tree'), index);
  assert.equal(git('rev-parse', 'refs/stash'), hash);
});

test('pop refuses existing ignored files that collide with new files in the stash', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'file.txt'), 'saved edits'); writeFileSync(join(path, 'new.txt'), 'saved new');
  git('stash', 'push', '-qu'); const hash = git('rev-parse', 'refs/stash');
  writeFileSync(join(path, '.gitignore'), 'new.txt\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore');
  writeFileSync(join(path, 'new.txt'), 'keep ignored');
  assert.equal((await service.getSnapshot(path)).isDirty, false);
  await assert.rejects(service.prepareOperation(path, 'stash_pop', {}, 'en'), /new.txt.*somewhere safe/);
  assert.equal(readFileSync(join(path, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(path, 'new.txt'), 'utf8'), 'keep ignored');
  assert.equal(git('rev-parse', 'refs/stash'), hash);
});

test('pop protects a dirty index even when its files do not overlap the stash', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'file.txt'), 'saved edits'); git('stash', 'push', '-q');
  writeFileSync(join(path, 'current.txt'), 'staged current'); git('add', 'current.txt');
  const index = git('write-tree'), hash = git('rev-parse', 'refs/stash');
  await assert.rejects(service.prepareOperation(path, 'stash_pop', {}, 'en'), /staged changes in current.txt.*Review and save/);
  assert.equal(git('write-tree'), index); assert.equal(git('rev-parse', 'refs/stash'), hash);
});

test('pop protects index-only stash edits and preserves whitespace in stashed paths', async t => {
  const { path, git } = fixture(t);
  const filename = ' leading space.txt';
  writeFileSync(join(path, filename), 'base\n'); git('add', '.'); git('commit', '-qm', 'space path');
  writeFileSync(join(path, filename), 'staged\n'); git('add', filename);
  writeFileSync(join(path, filename), 'base\n'); git('stash', 'push', '-q');
  writeFileSync(join(path, filename), 'keep current\n');
  await assert.rejects(service.prepareOperation(path, 'stash_pop', {}, 'en'), / leading space.txt.*Review and save/);
  assert.equal(readFileSync(join(path, filename), 'utf8'), 'keep current\n');
  assert.equal((await service.getSnapshot(path)).stashCount, 1);
});

test('pop rechecks new-file collisions created after review even when status remains clean', async t => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, 'new.txt'), 'saved new'); git('stash', 'push', '-qu');
  writeFileSync(join(path, '.gitignore'), 'new.txt\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore');
  const plan = await service.prepareOperation(path, 'stash_pop', {}, 'en');
  writeFileSync(join(path, 'new.txt'), 'created after review');
  const result = await service.executePlan(path, plan, 'en');
  assert.match(result.error, /new.txt/); assert.equal(result.snapshot.stashCount, 1);
  assert.equal(readFileSync(join(path, 'new.txt'), 'utf8'), 'created after review');
});

test('rebase on another branch is available from main and accepts an exact remote base', async t => {
  const { path, git, remoteCommit } = fixture(t); remoteCommit(); git('fetch', '-q');
  writeFileSync(join(path, 'local.txt'), 'mine'); git('add', '.'); git('commit', '-qm', 'mine');
  const plan = await service.prepareOperation(path, 'rebase', { onto: 'refs/remotes/origin/main' }, 'en');
  assert.equal(plan.allowed, true); assert.equal(plan.requiresConfirmation, true);
  const result = await service.executePlan(path, plan, 'en'); assert.equal(result.error, undefined);
  assert.equal(git('branch', '--show-current'), 'main'); git('merge-base', '--is-ancestor', 'origin/main', 'main');
});
