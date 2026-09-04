import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBaseline, changedBranches, parseActivityBaseline, pullRequestReference } from '../dist-electron/shared/repository-activity.js';
const branch = (name, hash, extra = {}) => ({ name, lastCommit: { shortHash: hash }, presence: 'local', ahead: 0, behind: 0, ...extra });
const snapshot = (...branches) => ({ branches });
test('review tracks additions, movement and removal, without treating checkout as activity', () => {
  const before = activityBaseline(snapshot(branch('main', 'aaa'), branch('removed', 'bbb')));
  const after = activityBaseline(snapshot(branch('main', 'ccc'), branch('new', 'ddd')));
  assert.deepEqual(changedBranches(before, after), ['main', 'removed', 'new']);
  assert.deepEqual(changedBranches(after, after), []);
  assert.deepEqual(changedBranches(activityBaseline(snapshot(branch('main', 'aaa'))), activityBaseline(snapshot(branch('main', 'aaa', { isCurrent: true })))), []);
});
test('remote divergence changes are visible even when local tip does not move', () => {
  assert.deepEqual(changedBranches(activityBaseline(snapshot(branch('main', 'aaa'))), activityBaseline(snapshot(branch('main', 'aaa', { behind: 2 })))), ['main']);
});
test('review survives storage and rejects corrupt entries', () => {
  const baseline = activityBaseline(snapshot(branch('__proto__', 'aaa')));
  assert.deepEqual(parseActivityBaseline(JSON.stringify(baseline)), baseline);
  for (const value of [null, 'invalid', '[]', '{"branches":[]}', '{"branches":{"main":7}}']) assert.equal(parseActivityBaseline(value), undefined);
});
test('PR references recognize merge and squash conventions, not arbitrary issue numbers', () => {
  assert.equal(pullRequestReference('Merge pull request #42 from feature/menu'), '42');
  assert.equal(pullRequestReference('Add menu (#57)'), '57');
  assert.equal(pullRequestReference('Fix issue #42'), undefined);
});
