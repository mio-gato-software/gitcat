import test from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestReference } from '../dist-electron/shared/repository-activity.js';
test('PR references recognize merge and squash conventions, not arbitrary issue numbers', () => {
  assert.equal(pullRequestReference('Merge pull request #42 from feature/menu'), '42');
  assert.equal(pullRequestReference('Add menu (#57)'), '57');
  assert.equal(pullRequestReference('Fix issue #42'), undefined);
});
