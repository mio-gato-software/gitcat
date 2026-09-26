import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ resolve(specifier, context, next) { return specifier === 'electron' ? { url: new URL('./helpers/electron-stub.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const service = await import('../dist-electron/electron/git-service.js');
const { gitignoreLine, resolveSelection } = await import('../dist-electron/shared/selected-changes.js');
const { getSnapshot, prepareBranchDelivery, prepareOperation, executePlan, getSelectionDiff } = service;

function fixture(t, files = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }) {
  const path = mkdtempSync(join(tmpdir(), 'gitcat-selected-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  git('add', '.'); git('commit', '-qm', 'base'); git('switch', '-qc', 'feature/work');
  return { path, git, write: (name, content) => writeFileSync(join(path, name), content) };
}
/** What the person ticked, at the versions the list showed them. */
const pick = (snapshot, ...paths) => paths.map((path) => {
  const change = snapshot.changes.find((item) => item.path === path);
  assert.ok(change, `${path} is listed`);
  return { path, version: change.version };
});
const save = async (path, paths, { message = 'save selected', merge = false } = {}) => {
  const snapshot = await getSnapshot(path);
  return prepareBranchDelivery(path, { stateId: snapshot.stateId, message, mergeToDefault: merge, selection: pick(snapshot, ...paths) }, 'en');
};
const committedFiles = (git) => git('show', '--name-status', '--format=', 'HEAD').split('\n').filter(Boolean).sort();

test('mixed staged and unstaged edits: the ticked file is saved whole, other staging decisions survive', async (t) => {
  const { path, git, write } = fixture(t);
  write('a.txt', 'a staged\n'); git('add', 'a.txt'); write('a.txt', 'a staged\nand unstaged\n');
  write('b.txt', 'b staged only\n'); git('add', 'b.txt');
  write('c.txt', 'c unstaged only\n');
  const before = await getSnapshot(path);
  assert.equal(before.changes.find((file) => file.path === 'a.txt').xy, 'MM');
  const plan = await save(path, ['a.txt']);
  assert.match(plan.command, /git commit --only -m "save selected" -- a\.txt/);
  assert.ok(plan.effects.some((effect) => /a\.txt had both staged and unstaged edits: the whole file is saved/.test(effect)));
  assert.ok(plan.effects.some((effect) => /Only the 1 ticked files will be saved/.test(effect)));
  assert.ok(plan.effects.some((effect) => /already staged in the files you left out stays staged/.test(effect)));
  assert.equal(git('status', '--porcelain'), 'MM a.txt\nM  b.txt\n M c.txt', 'preparing changes nothing');

  const result = await executePlan(path, plan, 'en');
  assert.equal(result.error, undefined);
  assert.deepEqual(committedFiles(git), ['M\ta.txt']);
  assert.equal(git('show', 'HEAD:a.txt'), 'a staged\nand unstaged');
  assert.equal(git('status', '--porcelain'), 'M  b.txt\n M c.txt', 'b stays staged, c stays unstaged, a is clean');
  assert.equal(git('diff', '--cached', '--', 'b.txt').includes('+b staged only'), true);
  assert.equal(readFileSync(join(path, 'c.txt'), 'utf8'), 'c unstaged only\n');
});

test('untracked files and deletions are saved only when ticked', async (t) => {
  const { path, git, write } = fixture(t);
  write('new-in.txt', 'in\n'); write('new-out.txt', 'out\n');
  unlinkSync(join(path, 'b.txt')); unlinkSync(join(path, 'c.txt'));
  const result = await executePlan(path, await save(path, ['new-in.txt', 'b.txt']), 'en');
  assert.equal(result.error, undefined);
  assert.deepEqual(committedFiles(git), ['A\tnew-in.txt', 'D\tb.txt']);
  assert.equal(git('status', '--porcelain'), ' D c.txt\n?? new-out.txt');
  assert.equal(readFileSync(join(path, 'new-out.txt'), 'utf8'), 'out\n');
});

test('a staged rename is saved as a whole, and cannot be split from a change on its old path', async (t) => {
  const { path, git, write } = fixture(t);
  git('mv', 'a.txt', 'renamed.txt'); write('c.txt', 'left out\n');
  const snapshot = await getSnapshot(path);
  const rename = snapshot.changes.find((file) => file.path === 'renamed.txt');
  assert.equal(rename.from, 'a.txt');
  const plan = await save(path, ['renamed.txt']);
  assert.deepEqual(plan.steps[0].paths.sort(), ['a.txt', 'renamed.txt']);
  assert.ok(plan.effects.some((effect) => /rename from a\.txt to renamed\.txt is saved as a whole/.test(effect)));
  const result = await executePlan(path, plan, 'en');
  assert.equal(result.error, undefined);
  assert.equal(git('show', '--name-status', '-M', '--format=', 'HEAD'), 'R100\ta.txt\trenamed.txt');
  assert.equal(git('status', '--porcelain'), ' M c.txt');

  // A rename whose old path holds a new file again: both are one decision.
  git('mv', 'renamed.txt', 'again.txt'); write('renamed.txt', 'recreated\n');
  const shared = await getSnapshot(path);
  assert.deepEqual(resolveSelection(shared.changes, pick(shared, 'again.txt')).problem, { kind: 'shared', path: 'renamed.txt', with: 'again.txt' });
  await assert.rejects(() => save(path, ['again.txt']), /share a path because of a rename/);
});

test('a stale review never saves: selected edits invalidate it, edits to files left out do not', async (t) => {
  const { path, git, write } = fixture(t);
  write('a.txt', 'reviewed\n'); write('b.txt', 'left out\n');
  const reviewed = await getSnapshot(path);
  const selection = pick(reviewed, 'a.txt');
  write('a.txt', 'edited after the review\n');
  await assert.rejects(() => prepareBranchDelivery(path, { stateId: reviewed.stateId, message: 'save', mergeToDefault: false, selection }, 'en'), /a\.txt changed after you reviewed it/);

  // Staging the selected file changes its version too, even with the same bytes on disk.
  const current = await getSnapshot(path);
  const staged = pick(current, 'a.txt');
  git('add', 'a.txt');
  await assert.rejects(() => prepareBranchDelivery(path, { stateId: current.stateId, message: 'save', mergeToDefault: false, selection: staged }, 'en'), /changed after you reviewed it/);

  const plan = await save(path, ['a.txt']);
  write('b.txt', 'still being edited\n'); write('unseen.txt', 'appeared later\n');
  const saved = await executePlan(path, plan, 'en');
  assert.equal(saved.error, undefined, 'files left out may keep changing');
  assert.deepEqual(committedFiles(git), ['M\ta.txt']);
  assert.equal(git('status', '--porcelain'), ' M b.txt\n?? unseen.txt');

  write('b.txt', 'ready\n');
  const next = await save(path, ['b.txt']);
  write('b.txt', 'changed between review and confirmation\n');
  await assert.rejects(() => executePlan(path, next, 'en'), /ticked file, its staged version or the target branch changed after the review/);
  assert.equal(git('log', '--format=%s', '-1'), 'save selected');
  await assert.rejects(() => prepareBranchDelivery(path, { stateId: 'x', mergeToDefault: false, message: 'save', selection: [{ path: 'nope.txt', version: 'v' }] }, 'en'), /no longer an unsaved change/);
  await assert.rejects(() => prepareBranchDelivery(path, { stateId: 'x', mergeToDefault: false, message: 'save', selection: [] }, 'en'), /Tick at least one file/);
});

test('ticked files that already match the last saved version are refused instead of making an empty save', async (t) => {
  const { path, git, write } = fixture(t);
  write('a.txt', 'staged\n'); git('add', 'a.txt'); write('a.txt', 'a\n'); write('b.txt', 'real change\n');
  await assert.rejects(() => save(path, ['a.txt']), /already match the last saved version/);
  assert.equal(git('status', '--porcelain'), 'MM a.txt\n M b.txt');
});

test('save plus integrate names the files left out that would block the switch, and saves nothing', async (t) => {
  const { path, git, write } = fixture(t);
  git('switch', '-q', 'main'); write('b.txt', 'main moved on\n'); git('commit', '-qam', 'main edit'); git('switch', '-q', 'feature/work');
  write('a.txt', 'selected\n'); write('b.txt', 'left out, would be overwritten\n');
  const head = git('rev-parse', 'HEAD');
  const refused = await save(path, ['a.txt'], { merge: true });
  assert.equal(refused.allowed, false);
  assert.match(refused.rationale, /b\.txt/);
  assert.match(refused.rationale, /GitCat does not save them on its own/);
  assert.match(refused.rationale, /untick “integrate”/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), ' M a.txt\n M b.txt');

  // Saving only is still available, and integrating with the blocker ticked works.
  const both = await executePlan(path, await save(path, ['a.txt', 'b.txt'], { merge: true }), 'en');
  assert.ok(both.error, 'the saved b.txt now conflicts with main, which the merge reports');
  assert.equal(both.outcomes[0].status, 'completed');
});

test('save plus integrate carries files left out along, unsaved and outside the integration', async (t) => {
  const { path, git, write } = fixture(t);
  write('a.txt', 'selected\n'); write('c.txt', 'left out\n'); write('scratch.txt', 'untracked, left out\n');
  const plan = await save(path, ['a.txt'], { merge: true });
  assert.deepEqual(plan.steps.map((step) => step.operation), ['commit', 'checkout', 'merge']);
  assert.ok(plan.effects.some((effect) => /2 files you left out are not integrated/.test(effect)));
  const result = await executePlan(path, plan, 'en');
  assert.equal(result.error, undefined);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('show', 'main:a.txt'), 'selected');
  assert.equal(git('show', 'main:c.txt'), 'c');
  assert.equal(git('status', '--porcelain'), ' M c.txt\n?? scratch.txt');
});

test('a save plus integrate is bound to the target branch tip it was reviewed against', async (t) => {
  const { path, git, write } = fixture(t);
  write('a.txt', 'selected\n');
  const plan = await save(path, ['a.txt'], { merge: true });
  const moved = git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'moved elsewhere');
  git('update-ref', 'refs/heads/main', moved);
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(() => executePlan(path, plan, 'en'), /or the target branch changed after the review/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), ' M a.txt');
});

test('an excluded file that starts blocking after the review stops the plan before anything is saved', async (t) => {
  const { path, git, write } = fixture(t);
  git('switch', '-q', 'main'); write('c.txt', 'main moved on\n'); git('commit', '-qam', 'main edit'); git('switch', '-q', 'feature/work');
  write('a.txt', 'selected\n');
  const plan = await save(path, ['a.txt'], { merge: true });
  assert.equal(plan.allowed, true);
  const head = git('rev-parse', 'HEAD');
  write('c.txt', 'edited after the review\n');
  await assert.rejects(() => executePlan(path, plan, 'en'), /Nothing was saved or integrated[\s\S]*c\.txt/);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('hooks run on a selected save, and a rejecting hook leaves every file and the staging area as they were', async (t) => {
  const { path, git, write } = fixture(t);
  const hook = join(path, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "hook saw: $(git diff --cached --name-only | tr "\\n" " ")" > "$(git rev-parse --git-dir)/hook-ran"\nexit ${GITCAT_TEST_REJECT:-0}\n');
  chmodSync(hook, 0o755);
  write('a.txt', 'selected\n'); write('b.txt', 'staged, left out\n'); git('add', 'b.txt');
  const ok = await executePlan(path, await save(path, ['a.txt']), 'en');
  assert.equal(ok.error, undefined);
  assert.equal(readFileSync(join(path, '.git', 'hook-ran'), 'utf8').trim(), 'hook saw: a.txt', 'the hook sees only the files being saved');

  writeFileSync(hook, '#!/bin/sh\necho "lint failed: fix a.txt" >&2\nexit 1\n');
  write('a.txt', 'second\n');
  const head = git('rev-parse', 'HEAD');
  const rejected = await executePlan(path, await save(path, ['a.txt']), 'en');
  assert.match(rejected.error, /lint failed: fix a\.txt/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), ' M a.txt\nM  b.txt');
});

test('the first save of a new repository can hold only the ticked files', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'gitcat-selected-first-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).replace(/\n$/, '');
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(path, 'keep.txt'), 'keep\n'); writeFileSync(join(path, 'later.txt'), 'later\n'); git('add', 'later.txt');
  const diff = await getSelectionDiff(path, ['keep.txt']);
  assert.match(diff.diff, /\+keep/); assert.doesNotMatch(diff.diff, /later/);
  const result = await executePlan(path, await save(path, ['keep.txt']), 'en');
  assert.equal(result.error, undefined);
  assert.equal(git('ls-tree', '--name-only', 'HEAD'), 'keep.txt');
  assert.equal(git('status', '--porcelain'), 'A  later.txt', 'the staged new file stays staged for later');
});

test('the selected diff and the generated description only read the ticked files', async (t) => {
  const { path, write } = fixture(t);
  write('a.txt', 'ticked change\n'); write('b.txt', 'secret excluded change\n'); write('new.txt', 'ticked new file\n');
  const diff = await getSelectionDiff(path, ['a.txt', 'new.txt']);
  assert.match(diff.diff, /\+ticked change/); assert.match(diff.diff, /ticked new file/);
  assert.doesNotMatch(diff.diff, /secret excluded/);
  assert.deepEqual(diff.files.map((file) => file.path).sort(), ['a.txt', 'new.txt']);

  const requests = [];
  const replies = ['ok', 'Update a and add new file'];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ status: 'completed', output_text: replies.shift() }) };
  };
  t.after(() => { globalThis.fetch = original; });
  await service.saveLlmConfig({ apiKey: 'sk-test', model: 'test-model' });
  const result = await service.generateCommitDescription(path, 'en', ['a.txt', 'new.txt']);
  assert.equal(result.description, 'Update a and add new file');
  assert.deepEqual(result.selection.map((item) => item.path).sort(), ['a.txt', 'new.txt']);
  const input = requests.at(-1).input;
  assert.match(input, /ticked change/); assert.match(input, /ticked new file/);
  assert.doesNotMatch(input, /secret excluded/);
  await service.saveLlmConfig({ apiKey: '', model: 'test-model', clearApiKey: true });
});

test('ignoring an untracked file previews the exact rule, keeps the file, and explains tracked files', async (t) => {
  const { path, git, write } = fixture(t);
  write('.env.local', 'SECRET=1\n'); write('draft [1].txt', 'odd name\n'); write('a.txt', 'tracked change\n');
  writeFileSync(join(path, '.gitignore'), 'node_modules');
  git('add', '.gitignore'); git('commit', '-qm', 'ignore file without final newline');
  const plan = await prepareOperation(path, 'ignore_path', { path: '.env.local' }, 'en');
  assert.equal(plan.allowed, true); assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.args.line, '/.env.local');
  assert.ok(plan.effects.some((effect) => effect === 'This line is added at the end of .gitignore: /.env.local'));
  assert.ok(plan.effects.some((effect) => /Files already saved in Git keep being tracked/.test(effect)));
  assert.equal(readFileSync(join(path, '.gitignore'), 'utf8'), 'node_modules', 'preparing writes nothing');

  const result = await executePlan(path, plan, 'en');
  assert.equal(result.error, undefined);
  assert.equal(readFileSync(join(path, '.gitignore'), 'utf8'), 'node_modules\n/.env.local\n');
  assert.equal(readFileSync(join(path, '.env.local'), 'utf8'), 'SECRET=1\n', 'the file stays on disk');
  assert.deepEqual(result.snapshot.changes.map((file) => file.path).sort(), ['.gitignore', 'a.txt', 'draft [1].txt']);

  const odd = await prepareOperation(path, 'ignore_path', { path: 'draft [1].txt' }, 'en');
  assert.equal(odd.args.line, '/draft \\[1\\].txt');
  assert.equal((await executePlan(path, odd, 'en')).error, undefined);
  assert.equal(git('check-ignore', '--', 'draft [1].txt'), 'draft [1].txt');

  await assert.rejects(() => prepareOperation(path, 'ignore_path', { path: 'a.txt' }, 'en'), /Git already tracks a\.txt, so a \.gitignore rule would not stop Git/);
  await assert.rejects(() => prepareOperation(path, 'ignore_path', { path: 'missing.txt' }, 'en'), /no longer listed as a new file/);
});

test('a .gitignore rule matches the one path it was written for', () => {
  assert.equal(gitignoreLine('notes.txt'), '/notes.txt');
  assert.equal(gitignoreLine('#draft'), '/\\#draft');
  assert.equal(gitignoreLine('!keep'), '/\\!keep');
  assert.equal(gitignoreLine('a*b?.txt'), '/a\\*b\\?.txt');
  assert.equal(gitignoreLine('trailing  '), '/trailing\\ \\ ');
  assert.equal(gitignoreLine('dir/file.txt'), '/dir/file.txt');
  assert.equal(gitignoreLine('bad\nname'), undefined);
});
