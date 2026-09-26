import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorAvatarUrl, avatarKey } from '../dist-electron/shared/avatar.js';
import { clampGraphColumn, parseGraphColumns } from '../dist-electron/shared/graph-columns.js';

const root = join(import.meta.dirname, '..');

test('saved column widths come back inside their range and ignore anything unreadable', () => {
  assert.deepEqual(parseGraphColumns({ refs: 260.4, graph: 5, changes: 9999, when: 'wide', message: 300 }), { refs: 260, graph: 34, changes: 240 });
  assert.deepEqual(parseGraphColumns(null), {});
  assert.deepEqual(parseGraphColumns('refs'), {});
  assert.deepEqual(parseGraphColumns({ refs: Number.NaN }), {});
  assert.equal(clampGraphColumn('when', 10), 64);
});

test('an author photo is looked up by a hash of the address, never the address itself', async () => {
  const email = 'Someone@Example.com';
  const hash = createHash('sha256').update('someone@example.com').digest('hex');
  const url = await authorAvatarUrl(`<${email}>`);
  assert.equal(url, `https://www.gravatar.com/avatar/${hash}?s=80&d=404`);
  assert.doesNotMatch(url, /someone|example/i);
  assert.equal(avatarKey(' <A@B.C> '), 'a@b.c');
});

test('a GitHub no-reply address goes straight to its account photo', async () => {
  assert.equal(await authorAvatarUrl('1024025+torvalds@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/1024025?s=80');
  assert.equal(await authorAvatarUrl('torvalds@users.noreply.github.com'), 'https://avatars.githubusercontent.com/torvalds?s=80');
  assert.equal(await authorAvatarUrl('not an address'), undefined);
});

test('the renderer may load author photos only from the two photo hosts', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /img-src 'self' data: https:\/\/www\.gravatar\.com https:\/\/avatars\.githubusercontent\.com;/);
  assert.match(html, /connect-src 'self' ws:\/\/127\.0\.0\.1:5173;/);
});

test('Fetch sits beside Refresh and fetches directly, without a plan to confirm', async () => {
  const app = await readFile(join(root, 'src/App.tsx'), 'utf8');
  assert.match(app, /tool\(CloudDownload, t\("fetch"\), onFetch/);
  assert.match(app, /onFetch=\{\(\) => void refreshEverything\("fetch"\)\}/);
  assert.doesNotMatch(app, /prepare\("fetch"\)/);
});
