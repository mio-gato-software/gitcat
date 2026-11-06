import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

registerHooks({ resolve(s, c, next) { return s === 'electron' ? { url: new URL('./helpers/electron-stub.mjs', import.meta.url).href, shortCircuit: true } : next(s, c); } });
const service = await import('../dist-electron/electron/git-service.js');

test('Git commands, streaming reads and conflict previews keep Windows consoles hidden', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gitcat-processes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'Proyecto ñ & (prueba)'); mkdirSync(path);
  const git = (...args) => cp.execFileSync('git', args, { cwd: path, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'QA'); git('config', 'user.email', 'qa@example.test');
  writeFileSync(join(path, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('switch', '-qc', 'other'); writeFileSync(join(path, 'file.txt'), 'theirs\n'); git('commit', '-qam', 'theirs');
  git('switch', 'main'); writeFileSync(join(path, 'file.txt'), 'ours\n'); git('commit', '-qam', 'ours');
  assert.throws(() => git('merge', 'other'));

  const nativeSpawn = cp.spawn, calls = [];
  t.mock.method(cp, 'spawn', (exe, args, options) => { calls.push({ args, options }); return nativeSpawn(exe, args, options); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await service.runGit(path, ['--version'])).code, 0);
  const child = await service.spawnGit(path, ['status', '--porcelain', '-z']);
  child.stdout.resume(); child.stderr.resume(); assert.equal((await once(child, 'close'))[0], 0);
  const guide = await service.describeConflicts(path, 'en');
  assert.equal(guide.files[0].path, 'file.txt');
  assert.ok(calls.some(call => call.args.includes('cat-file') && call.args.includes('blob')), 'exercise the conflict preview process too');
  for (const { args, options } of calls) assert.equal(options.windowsHide, true, args.join(' '));
});

test('Git output preserves Unicode when a pipe divides UTF-8 characters between chunks', async t => {
  const nativeSpawn = cp.spawn;
  const text = 'Descripción 日本語 🐈\n';
  const script = `const bytes=Buffer.from(${JSON.stringify(text)});let i=0;const timer=setInterval(()=>{if(i===bytes.length){clearInterval(timer);return;}const byte=bytes.subarray(i,++i);process.stdout.write(byte);process.stderr.write(byte);},5);`;
  t.mock.method(cp, 'spawn', (_exe, _args, options) => nativeSpawn(process.execPath, ['-e', script], options));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await service.runGit(tmpdir(), ['--version']);
  assert.equal(result.code, 0); assert.equal(result.stdout, text); assert.equal(result.stderr, text);
});
