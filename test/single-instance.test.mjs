import test from 'node:test';
import assert from 'node:assert/strict';
import { keepSingleInstance } from '../dist-electron/electron/single-instance.js';

test('a second instance quits before it starts a workspace or settings writer', () => {
  let quits = 0;
  const primary = keepSingleInstance({ requestSingleInstanceLock: () => false, quit: () => quits++, on: () => assert.fail('the second instance must not install listeners') }, () => assert.fail('the second instance must not create a window'));
  assert.equal(primary, false); assert.equal(quits, 1);
});

test('reopening GitCat restores and focuses the existing window, including during startup', () => {
  let reopen, window = null; const calls = [];
  const primary = keepSingleInstance({ requestSingleInstanceLock: () => true, quit: () => assert.fail('keep the original app open'), on: (event, handler) => { assert.equal(event, 'second-instance'); reopen = handler; } }, () => window);
  assert.equal(primary, true); reopen(); // A launch while the first window is being created is harmless.
  for (const minimized of [true, false]) {
    window = { isMinimized: () => minimized, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
    reopen();
  }
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'show', 'focus']);
});
