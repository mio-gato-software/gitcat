import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refChips } from '../dist-electron/shared/ref-chips.js';

const root = join(import.meta.dirname, '..');

test('a release tag never covers the branch whose tip it marks', () => {
  // Git decorates a tagged tip as "tag: v1.0.64, origin/main" when the local branch is behind.
  assert.deepEqual(refChips(['tag: v1.0.64', 'origin/main', 'origin/HEAD'], ['origin']), [
    { label: 'main', kind: 'remote', ref: 'origin/main' },
    { label: 'v1.0.64', kind: 'tag' }
  ]);
});

test('the checked-out branch leads, then local, remote-only and finally tags', () => {
  const chips = refChips(['tag: v2', 'origin/feature/x', 'fix/y', 'HEAD -> main', 'origin/main'], ['origin']);
  assert.deepEqual(chips.map((chip) => `${chip.kind}:${chip.label}`), ['head:main', 'local:fix/y', 'remote:feature/x', 'tag:v2']);
});

test('a tag named like a branch keeps both labels', () => {
  assert.deepEqual(refChips(['main', 'tag: main'], ['origin']), [
    { label: 'main', kind: 'local' },
    { label: 'main', kind: 'tag' }
  ]);
});

test('remote chips retain exact identities and colocated copies keep a cloud target', () => {
  assert.deepEqual(refChips(['main', 'origin/main', 'mirror/main'], ['origin', 'mirror']), [
    { label: 'main', kind: 'local', remoteRefs: ['origin/main', 'mirror/main'] }
  ]);
  assert.deepEqual(refChips(['origin/main', 'mirror/main'], ['origin', 'mirror']), [
    { label: 'main', kind: 'remote', ref: 'origin/main' },
    { label: 'main', kind: 'remote', ref: 'mirror/main' }
  ]);
});

test('the +N badge opens every label on the commit', async () => {
  const app = await readFile(join(root, 'src/App.tsx'), 'utf8');
  assert.match(app, /className="ref-tag more"\s+aria-expanded=\{stackOpen\}/);
  assert.match(app, /\{stackOpen && <div className="ref-stack"[^>]*>\{chips\.map\(chipTag\)\}<\/div>\}/);
});
