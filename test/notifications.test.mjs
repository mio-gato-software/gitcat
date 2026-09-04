import test from 'node:test';
import assert from 'node:assert/strict';
import { addNotification, notificationDuration, notificationSummary } from '../dist-electron/shared/notifications.js';
const notice = (id, tone = 'success', detail = 'Updated main') => ({ id, label: 'State updated', detail, tone });
test('repeated notices replace the prior copy while different outcomes remain visible', () => {
  const old = notice(1);
  const error = notice(2, 'warning', 'Could not fetch');
  const next = addNotification([error, old], notice(3));
  assert.deepEqual(next.map(n => n.id), [3, 2]);
  assert.equal(notificationDuration('warning'), 10000);
  assert.equal(notificationDuration('neutral'), 6000);
  assert.equal(notificationDuration('success'), 6000);
});
test('new confirmations never silently evict unacknowledged failures', () => {
  let items = [notice(0, 'warning', 'Resolve this problem')];
  for (let i = 1; i <= 10; i++) items = addNotification(items, notice(i, 'success', `Completed ${i}`));
  assert.equal(items.length, 11);
  assert.equal(items.at(-1).tone, 'warning');
});

test('long multiline output becomes a brief preview without losing the original details', () => {
  const item = notice(1, 'warning', 'first line\n' + 'full detail '.repeat(200));
  assert.equal(notificationSummary(item).length, 140);
  assert.equal(notificationSummary(item).includes('\n'), false);
  assert.ok(item.detail.includes('\n'));
  assert.equal(notificationSummary(notice(2)), 'State updated · Updated main');
});
test('routine history is bounded but outstanding errors remain available', () => {
  let items = [notice(0, 'warning', 'Still requires review')];
  for (let i = 1; i <= 70; i++) items = addNotification(items, notice(i, 'success', `Completed ${i}`));
  assert.equal(items.length, 51);
  assert.equal(items.at(-1).tone, 'warning');
});
