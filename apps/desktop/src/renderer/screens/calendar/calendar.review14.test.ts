/**
 * The review14 fixes, one test each. Unlike review13's fixture runs these model the REAL engine
 * (`packages/engine` holds.ts / methods/event.ts): `Event/set` is held ONLY when `notify === true`
 * and only then records an `Operation` row — a guest-less write answers `undoable: false` and
 * `Operation/get` says notFound; a held write's receipt `appliedState` is already reached (the hold
 * commit never moves `seq`), so the overlay settles at `synced`, not at the receipt; a held create's
 * `Operation.targets` is the calendar id, never the new event's.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventChange } from '@aplos/contract';
import type { Receipt } from '../../data';
import { resetToasts } from '../../shell/store-toast';
import { draftFromEvent, update, type CalendarEffect } from './calendar.model';
import { notifiesGuests } from './model/transitions';
import { runCalendarEffect, type EffectPorts } from './effects';
import { ctxFor, NOW, ports, S, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const task = () => new Promise<void>(resolve => setImmediate(resolve));

const moveFx = (notify: boolean): CalendarEffect => ({
  kind: 'eventSet',
  change: {
    type: 'update',
    id: 'climb',
    scope: 'occurrence',
    fields: { title: 'Climbing, moved' },
  },
  optimistic: { id: 'climb', patch: { title: 'Climbing, moved' } },
  ...(notify ? { notify: true } : {}),
  toast: { kind: 'info', message: 'Moved Climbing', held: 'Moving Climbing', undoable: true },
  undoLabel: 'Moved Climbing',
  failure: 'Couldn’t move Climbing.',
});

const eventSetSpy = (out: { receipt: Receipt }) => {
  const calls: Array<{ change: EventChange; notify?: boolean }> = [];
  const port: EffectPorts['eventSet'] = args => {
    calls.push(args);
    return Promise.resolve(out);
  };
  return { calls, port };
};

test('review14: notify: true goes on Event/set exactly when guests are emailed', async () => {
  resetToasts();
  try {
    // The model flags a drag, a save and a delete of an event with guests — never a guest-less one.
    const ctx = ctxFor();
    const climb = ctx.events.get('climb')!;
    assert.ok(
      climb.attendees.some(a => !a.self),
      'climb has a guest besides the owner',
    );
    const moved = update(
      S(),
      { type: 'move', id: 'climb', start: '2026-10-29T18:30', end: '2026-10-29T20:00' },
      ctx,
    );
    const moveOut = moved.effects.find(f => f.kind === 'eventSet');
    assert.ok(moveOut?.kind === 'eventSet' && moveOut.notify === true, 'a drag on a guest event');
    const saved = update(
      S({ editor: { ...draftFromEvent(ctx.events.get('design')!), title: 'Design review v2' } }),
      { type: 'editorSave' },
      ctx,
    );
    const saveFx = saved.effects.find(f => f.kind === 'eventSet');
    assert.ok(saveFx?.kind === 'eventSet' && saveFx.notify === true, 'a save on a guest event');
    const deleted = update(S({ selectedId: 'climb' }), { type: 'delete' }, ctx);
    const deleteFx = deleted.effects.find(f => f.kind === 'eventSet');
    assert.ok(
      deleteFx?.kind === 'eventSet' && deleteFx.notify === true,
      'a delete of a guest event',
    );
    const solo = update(S({ selectedId: 'dental' }), { type: 'delete' }, ctx);
    const soloFx = solo.effects.find(f => f.kind === 'eventSet');
    assert.ok(soloFx?.kind === 'eventSet' && soloFx.notify !== true, 'guest-less stays unset');
    // A create notifies only when it carries attendees (the editor's never do).
    const withGuests = {
      type: 'create' as const,
      calendarId: 'work',
      fields: {
        title: 'Kickoff',
        start: { type: 'date' as const, date: '2026-10-30' },
        end: { type: 'date' as const, date: '2026-10-31' },
        allDay: true,
        attendees: [{ address: 'mina@example.com' }],
      },
    };
    assert.equal(notifiesGuests(withGuests), true);
    assert.equal(
      notifiesGuests({ ...withGuests, fields: { ...withGuests.fields, attendees: [] } }),
      false,
    );

    // The port gets `notify: true` — never `false` (that would tell Google NOT to email guests).
    const heldSpy = eventSetSpy({
      receipt: receipt({ undoable: true, undoUntil: NOW + 60_000 }),
    });
    const ui1 = testUi();
    runCalendarEffect(moveFx(true), { ...ports(), eventSet: heldSpy.port }, ui1);
    await task();
    assert.equal(heldSpy.calls.length, 1);
    assert.equal(heldSpy.calls[0]?.notify, true);
    const plainSpy = eventSetSpy({ receipt: receipt({ undoable: false }) });
    const ui2 = testUi();
    runCalendarEffect(moveFx(false), { ...ports(), eventSet: plainSpy.port }, ui2);
    await task();
    assert.equal(plainSpy.calls.length, 1);
    assert.equal(
      plainSpy.calls[0]?.notify,
      undefined,
      'unset, so the provider keeps its own notify default',
    );
  } finally {
    resetToasts();
  }
});
