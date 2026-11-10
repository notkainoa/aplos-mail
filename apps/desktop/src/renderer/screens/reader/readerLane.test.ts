/**
 * The Importance menu's rule (owner request 2026-11-10): Do now and Important updates are "Important", Low importance is
 * "Low importance"; choosing the other end gives the lane to move to, choosing the same end gives none.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/reader/readerLane.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRow } from '../../data';
import { importanceOf, laneForChoice, notificationOf } from './readerLane';

const row = (lane: string) => ({ rank: { lane } }) as unknown as ThreadRow;

test('which end a thread is at', () => {
  assert.equal(importanceOf(row('do')), 'important');
  assert.equal(importanceOf(row('update')), 'important');
  assert.equal(importanceOf(row('low')), 'low');
  assert.equal(importanceOf(row('from-a-newer-engine')), null, 'no menu for a lane we do not know');
});

test('a choice moves to the other end only; back from Low lands in Important updates', () => {
  assert.equal(laneForChoice(row('do'), 'low'), 'low');
  assert.equal(laneForChoice(row('update'), 'low'), 'low');
  assert.equal(laneForChoice(row('low'), 'important'), 'update');
  assert.equal(laneForChoice(row('do'), 'important'), null);
  assert.equal(laneForChoice(row('low'), 'low'), null);
  assert.equal(laneForChoice(row('from-a-newer-engine'), 'low'), null);
});

test('the bell: sent is a bell, suppressed and none are slashed, absent or unknown claims nothing', () => {
  assert.equal(notificationOf({ notification: 'sent' }), 'notified');
  assert.equal(notificationOf({ notification: 'suppressed' }), 'silent');
  assert.equal(notificationOf({ notification: 'none' }), 'silent');
  assert.equal(notificationOf({}), 'unknown', 'mail older than the notification log');
  assert.equal(notificationOf({ notification: 'a-newer-value' }), 'unknown');
});
