import test from 'node:test';
import assert from 'node:assert/strict';
import { addNotification, notificationDuration } from '../dist-electron/shared/notifications.js';
const notice = (id, tone = 'success', detail = 'Updated main') => ({ id, label: 'State updated', detail, tone });
test('repeated notices replace the prior copy while different outcomes remain visible', () => {
  const old = notice(1);
  const error = notice(2, 'warning', 'Could not fetch');
  const next = addNotification([error, old], notice(3));
  assert.deepEqual(next.map(n => n.id), [3, 2]);
  assert.equal(notificationDuration('warning'), undefined);
  assert.equal(notificationDuration('neutral'), 6000);
  assert.equal(notificationDuration('success'), 6000);
});
test('new confirmations never silently evict unacknowledged failures', () => {
  let items = [notice(0, 'warning', 'Resolve this problem')];
  for (let i = 1; i <= 10; i++) items = addNotification(items, notice(i, 'success', `Completed ${i}`));
  assert.equal(items.length, 11);
  assert.equal(items.at(-1).tone, 'warning');
});
