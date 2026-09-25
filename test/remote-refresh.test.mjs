import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronStub = pathToFileURL(join(root, 'test/helpers/electron-stub.mjs')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron' ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, 'dist-electron/electron/git-service.js')));
const { exclusive } = await import(pathToFileURL(join(root, 'dist-electron/electron/repository-queue.js')));

const repository = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
  return { path, git };
};
const identify = (git) => { git('config', 'user.email', 'qa@example.test'); git('config', 'user.name', 'GitCat QA'); };

test('refresh brings remote news in without touching local branches or uncommitted work', async () => {
  const origin = repository('gitcat-origin-');
  origin.git('init', '--bare', '-q', '-b', 'main');
  const mine = repository('gitcat-mine-');
  mine.git('init', '-q', '-b', 'main'); identify(mine.git);
  writeFileSync(join(mine.path, 'app.txt'), 'base\n');
  mine.git('add', '.'); mine.git('commit', '-qm', 'base');
  mine.git('remote', 'add', 'origin', origin.path);
  mine.git('push', '-qu', 'origin', 'main');
  mine.git('push', '-q', 'origin', 'main:old-feature');
  mine.git('fetch', '-q', 'origin');

  const teammate = repository('gitcat-teammate-');
  execFileSync('git', ['clone', '-q', origin.path, teammate.path]);
  identify(teammate.git);
  writeFileSync(join(teammate.path, 'news.txt'), 'news\n');
  teammate.git('add', '.'); teammate.git('commit', '-qm', 'teammate work');
  teammate.git('push', '-q', 'origin', 'main');
  teammate.git('push', '-q', 'origin', '--delete', 'old-feature');

  writeFileSync(join(mine.path, 'app.txt'), 'unsaved\n');
  const head = mine.git('rev-parse', 'HEAD');
  const before = await service.getSnapshot(mine.path);
  assert.equal(before.branches.find((branch) => branch.name === 'main').behind, 0);

  const after = await service.fetchRemotes(mine.path);
  assert.equal(after.branches.find((branch) => branch.name === 'main').behind, 1, 'The new remote commit is visible');
  assert.equal(mine.git('rev-parse', 'HEAD'), head, 'The local branch did not move');
  assert.equal(mine.git('status', '--porcelain'), 'M app.txt', 'Uncommitted work is untouched');
  assert.equal(mine.git('branch', '-r', '--list', 'origin/old-feature'), '', 'Branches deleted on the remote are forgotten');
  assert.notEqual(after.stateId, before.stateId, 'A waiting plan sees that the state moved');
});

test('refresh without a remote only reads this repository', async () => {
  const alone = repository('gitcat-alone-');
  alone.git('init', '-q', '-b', 'main'); identify(alone.git);
  writeFileSync(join(alone.path, 'app.txt'), 'base\n');
  alone.git('add', '.'); alone.git('commit', '-qm', 'base');
  const snapshot = await service.fetchRemotes(alone.path);
  assert.deepEqual(snapshot.remotes, []);
  assert.equal(snapshot.currentBranch, 'main');
});

test('an unreachable remote fails the check with Git\'s explanation and changes nothing', async () => {
  const mine = repository('gitcat-offline-');
  mine.git('init', '-q', '-b', 'main'); identify(mine.git);
  writeFileSync(join(mine.path, 'app.txt'), 'base\n');
  mine.git('add', '.'); mine.git('commit', '-qm', 'base');
  mine.git('remote', 'add', 'origin', join(tmpdir(), 'gitcat-missing-remote-does-not-exist'));
  const before = await service.getSnapshot(mine.path);
  await assert.rejects(service.fetchRemotes(mine.path), /does not appear to be a git repository|Could not read/i);
  assert.equal((await service.getSnapshot(mine.path)).stateId, before.stateId);
});

test('jobs for one repository run one at a time, even after a failure, while other repositories proceed', async () => {
  const order = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = exclusive('/repo', async () => { order.push('fetch:start'); await wait(30); order.push('fetch:end'); throw new Error('offline'); });
  const second = exclusive('/repo/../repo', async () => { order.push('plan'); return 'planned'; });
  const other = exclusive('/other', async () => { order.push('other'); return 'other'; });
  await assert.rejects(first, /offline/);
  assert.equal(await second, 'planned');
  assert.equal(await other, 'other');
  assert.deepEqual(order, ['fetch:start', 'other', 'fetch:end', 'plan']);
});
