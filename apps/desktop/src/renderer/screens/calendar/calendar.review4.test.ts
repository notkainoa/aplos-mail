/**
 * The review4 tests: meeting links leave through `api.shell.open` (PR #266's port; main's `external()` gate serves
 * it) and the reducer hands on an https conference url only. Node, no DOM:
 * `cd apps/desktop && TZ=America/Los_Angeles npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { update } from './calendar.model';
import { livePorts } from './effects';
import { demoWorld } from './CalendarStates';
import { boot, ctxFor, nextTask, S } from './calendar.testkit';
import type { DataApi } from '../../data';

test('review4: openVideo on an https meeting link plans exactly one openUrl with that url', () => {
  const ctx = ctxFor();
  assert.equal(
    ctx.events.get('design')?.conference?.url,
    'https://meet.example.com/design-review',
    'the demo event carries a meet link',
  );
  const t = update(S({ selectedId: 'design', detailId: 'design' }), { type: 'openVideo' }, ctx);
  assert.equal(t.handled, true);
  assert.deepEqual(t.effects, [{ kind: 'openUrl', url: 'https://meet.example.com/design-review' }]);
});

test('review4: a meeting link that is not https is never handed on', () => {
  const refused = [
    'http://meet.example.com/design-review',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mailto:alex.moreno@example.com',
    'not a url',
  ];
  for (const url of refused) {
    const events = demoWorld.events.map(e =>
      e.id === 'design' ? { ...e, conference: { url } } : e,
    );
    const ctx = ctxFor(events);
    const t = update(S({ detailId: 'design' }), { type: 'openVideo' }, ctx);
    assert.equal(t.handled, false, `${url} is unhandled`);
    assert.deepEqual(t.effects, [], `${url} plans no effect`);
  }
});

test('review4: an event without a conference plans nothing', () => {
  const ctx = ctxFor();
  assert.equal(ctx.events.get('dental')?.conference, undefined);
  const t = update(S({ selectedId: 'dental', detailId: 'dental' }), { type: 'openVideo' }, ctx);
  assert.equal(t.handled, false);
  assert.deepEqual(t.effects, []);
});

test('review4: openUrl goes to api.shell.open once, never window.open, and a refusal is swallowed', async () => {
  const { connection } = await boot();
  const sent: Array<Parameters<DataApi['shell']['open']>[0]> = [];
  // What livePorts binds: the connected layer's `api.shell.open`, spied on for the assertion (the stand-in's
  // native stub answers `{ok:true}`; here the spy stands in for it so no call reaches the engine).
  const shell = connection.layer.api.shell as { open: DataApi['shell']['open'] };
  const original = shell.open;
  try {
    shell.open = args => {
      sent.push(args);
      return Promise.resolve({ ok: true as const });
    };
    livePorts().openUrl('https://meet.example.com/design-review');
    assert.deepEqual(sent, [{ url: 'https://meet.example.com/design-review' }]);

    shell.open = () => Promise.reject(new Error('refused'));
    livePorts().openUrl('https://meet.example.com/design-review');
    await nextTask();
  } finally {
    shell.open = original;
  }

  // No DOM in node, so `window.open` cannot be spied on; the port never falls back to it (review3's source grep).
  const src = readFileSync(new URL('./effects.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('window.open'), false, 'the window.open fallback is gone');
});
