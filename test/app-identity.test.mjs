import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { profilePath, migrateProfileFiles } from '../dist-electron/electron/app-identity.js';
import { migratePreferences } from '../dist-electron/shared/storage-migration.js';

test('upgrades retain the profile and copy stored configuration without overwriting new values', () => {
  const root = mkdtempSync(join(tmpdir(), 'gitcat-profile-'));
  try {
    assert.equal(profilePath(root), join(root, 'gitcat'));
    const old = join(root, 'branchline');
    mkdirSync(old);
    assert.equal(profilePath(root), old);
    writeFileSync(join(old, 'branchline-settings.json'), '{"encryptedApiKey":"ciphertext"}', { mode: 0o600 });
    writeFileSync(join(old, 'branchline-workspace.json'), '{"paths":["/repo"]}');
    migrateProfileFiles(old);
    assert.equal(readFileSync(join(old, 'gitcat-settings.json'), 'utf8'), '{"encryptedApiKey":"ciphertext"}');
    assert.equal(readFileSync(join(old, 'gitcat-workspace.json'), 'utf8'), '{"paths":["/repo"]}');
    writeFileSync(join(old, 'gitcat-settings.json'), 'new config');
    migrateProfileFiles(old);
    assert.equal(readFileSync(join(old, 'gitcat-settings.json'), 'utf8'), 'new config');
    assert.equal(readFileSync(join(old, 'branchline-settings.json'), 'utf8'), '{"encryptedApiKey":"ciphertext"}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('language, pane layout and per-project reviews survive the rename', () => {
  const values = new Map([['branchline-locale', 'es'], ['branchline-pane-widths', '[200,300]'], ['branchline-activity:/repo', 'review'], ['gitcat-locale', 'en']]);
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) };
  migratePreferences(storage);
  assert.equal(values.get('gitcat-locale'), 'en');
  assert.equal(values.get('gitcat-pane-widths'), '[200,300]');
  assert.equal(values.get('gitcat-activity:/repo'), 'review');
  assert.equal(values.get('branchline-locale'), 'es');
  assert.doesNotThrow(() => migratePreferences({ get length() { throw new Error('Unavailable'); } }));
});
