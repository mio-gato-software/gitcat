import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({ resolve(s, c, next) { return s === 'electron' ? { url: new URL('./helpers/electron-stub.mjs', import.meta.url).href, shortCircuit: true } : next(s, c); } });
const service = await import('../dist-electron/electron/git-service.js');
const { cloneRepository } = await import('../dist-electron/electron/project-setup.js');

test('Windows selected saves preserve CRLF files, Unicode paths and unrelated staged work', { skip: process.platform !== 'win32' }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gitcat-windows-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'Proyecto ñ & (copia)'); mkdirSync(path);
  const git = (...args) => execFileSync('git', args, { cwd: path, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@example.test'); git('config', 'core.autocrlf', 'true');
  mkdirSync(join(path, 'diseño'));
  const chosen = 'diseño/niño.txt', untouched = 'other.txt';
  writeFileSync(join(path, chosen), 'primera línea\r\n'); writeFileSync(join(path, untouched), 'base\r\n');
  git('add', '.'); git('commit', '-qm', 'base');
  writeFileSync(join(path, untouched), 'staged\r\n'); git('add', untouched); writeFileSync(join(path, untouched), 'unstaged\r\n');
  writeFileSync(join(path, chosen), 'primera línea\r\nsegunda línea 🐈\r\n');
  const snapshot = await service.getSnapshot(path);
  assert.ok(snapshot.changes.some(change => change.path === chosen));
  const change = snapshot.changes.find(change => change.path === chosen);
  const plan = await service.prepareBranchDelivery(path, { stateId: snapshot.stateId, message: 'Guardar diseño ñ 🐈', mergeToDefault: false, selection: [{ path: chosen, version: change.version }] }, 'es');
  const result = await service.executePlan(path, plan, 'es');
  assert.equal(result.error, undefined);
  assert.equal(git('log', '-1', '--format=%s'), 'Guardar diseño ñ 🐈');
  assert.equal(git('show', `HEAD:${chosen}`), 'primera línea\nsegunda línea 🐈');
  assert.equal(readFileSync(join(path, chosen), 'utf8'), 'primera línea\r\nsegunda línea 🐈\r\n');
  assert.equal(git('show', `:${untouched}`), 'staged');
  assert.equal(readFileSync(join(path, untouched), 'utf8'), 'unstaged\r\n');
  assert.deepEqual(result.snapshot.changes.map(change => [change.path, change.xy]), [[untouched, 'MM']]);
});

test('Windows long paths can be saved, inspected and cloned without rewriting Git settings', { skip: process.platform !== 'win32' }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gitcat-longpaths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'source'); mkdirSync(path);
  const git = (...args) => execFileSync('git', args, { cwd: path, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@example.test'); git('config', 'core.longpaths', 'false');
  const file = Array.from({ length: 6 }, (_, i) => `nested-${i}-${'x'.repeat(36)}`).join('/') + '/notes.txt';
  mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), 'long path content\n');
  assert.ok(join(path, file).length > 260);
  const snapshot = await service.getSnapshot(path);
  assert.equal(snapshot.changes[0].path, file);
  const plan = await service.prepareBranchDelivery(path, { stateId: snapshot.stateId, message: 'Save a long path', mergeToDefault: false }, 'en');
  const saved = await service.executePlan(path, plan, 'en');
  assert.equal(saved.error, undefined); assert.equal(saved.snapshot.isDirty, false);
  assert.equal(git('config', '--local', '--get', 'core.longpaths'), 'false');
  const detail = await service.getCommitFileDiff(path, saved.snapshot.head, file);
  assert.match(JSON.stringify(detail), /long path content/);
  const cloned = await cloneRepository({ url: path, parent: root, name: 'copy' }, { allowLocalSource: true });
  assert.equal(cloned.status, 'cloned');
  assert.equal(readFileSync(join(cloned.path, file), 'utf8').trim(), 'long path content');
});
