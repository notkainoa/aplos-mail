/**
 * The composer's small pure parts: the body's HTML round trip, recipients with plain rules, reply seeding, schedule
 * presets, the dictation machine, finding a thread's reply after a reload, and the one-tray-per-send hand-off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, Message, Submission } from '../../../data';
import { claim, release, settle, shownByToast, type HandoffState } from '../runtime/sendHandoff';
import {
  dictationReducer,
  dictationShown,
  IDLE,
  keepsOnRelease,
  listeningLine,
} from './dictationModel';
import { htmlToText, textToHtml } from './fields';
import {
  addRecipients,
  blockedSend,
  isValidAddress,
  parseRecipient,
  recipientPhrase,
} from './recipients';
import { replyDraftFor, rowsResolved } from './reopen';
import { replySeed, replySubject } from './replySeed';
import { scheduledLabel, schedulePresets } from './schedule';

test('the body survives the trip to the engine and back exactly, including blank lines and markup characters', () => {
  const samples = [
    '',
    'a',
    'a\n',
    '\n',
    'a\n\nb',
    '  indented',
    '<b>not bold</b> & co',
    '&lt; stays',
    'x\n\n\n',
  ];
  for (const text of samples)
    assert.equal(htmlToText(textToHtml(text)), text, JSON.stringify(text));
  assert.equal(htmlToText('<p>Hi Jordan,</p><p>Warmly,<br>Alex</p>'), 'Hi Jordan,\nWarmly,\nAlex');
});

test('recipients: parsed from "Name <address>", deduplicated, and checked with plain rules', () => {
  assert.deepEqual(parseRecipient('Jordan Lee <Jordan@Example.com>'), {
    id: 'jordan@example.com',
    name: 'Jordan Lee',
    address: 'Jordan@Example.com',
  });
  const two = addRecipients([], 'a@example.com, b@example.org; a@example.com');
  assert.deepEqual(
    two.map(r => r.id),
    ['a@example.com', 'b@example.org'],
  );
  assert.equal(isValidAddress('jordan@example.com'), true);
  for (const bad of ['jordan@', 'jordan', 'jordan@example', 'jo rdan@example.com'])
    assert.equal(isValidAddress(bad), false, bad);
  assert.equal(blockedSend({ to: two, cc: [], bcc: [], subject: '', body: '' }), null);
  assert.equal(recipientPhrase(['Jordan Lee', 'Mina Cho', 'Sam']), 'Jordan and 2 others');
  assert.equal(recipientPhrase([]), 'No recipient');
});

test('a reply goes to the sender, reply all adds everyone but you, and the subject gains one "Re: "', () => {
  const message = {
    id: 'm1',
    threadId: 't1',
    accountId: 'a1',
    from: { address: 'jordan@example.com', name: 'Jordan' },
    to: [{ address: 'me@example.com' }, { address: 'mina@example.com', name: 'Mina' }],
    cc: [{ address: 'sam@example.com' }],
    subject: 'Plans',
    fromMe: false,
  } as unknown as Message;
  const me = new Set(['me@example.com']);
  const one = replySeed(message, me, false);
  assert.deepEqual(
    one.fields.to.map(r => r.address),
    ['jordan@example.com'],
  );
  assert.deepEqual(one.fields.cc, []);
  assert.equal(one.fields.subject, 'Re: Plans');
  const all = replySeed(message, me, true);
  assert.deepEqual(
    all.fields.cc.map(r => r.address),
    ['mina@example.com', 'sam@example.com'],
  );
  assert.equal(all.context.mode, 'replyAll');
  assert.equal(replySubject('RE: Plans'), 'RE: Plans');
});

test('schedule presets resolve in local time and read like Later does', () => {
  const now = new Date(2026, 9, 27, 9, 20).getTime();
  const presets = schedulePresets(now);
  assert.deepEqual(
    presets.map(p => p.id),
    ['inAnHour', 'tomorrowMorning', 'tomorrowAfternoon', 'nextWeek'],
  );
  assert.equal(presets[0]!.at, new Date(2026, 9, 27, 11, 0).getTime());
  assert.equal(presets[1]!.label, 'Tomorrow, 8:00 AM');
  assert.equal(new Date(presets[3]!.at).getDay(), 1, 'Monday');
  assert.equal(scheduledLabel(presets[1]!.at, now), 'tomorrow, 8:00 AM');
});

test('dictation: hold shows the meter and "Listening. Release R to keep, Esc to cancel."; release keeps, Esc drops', () => {
  const listening = dictationReducer(IDLE, { type: 'start', holdKey: 'R' });
  assert.deepEqual(dictationShown(listening), { holdKey: 'R', level: 0 });
  assert.equal(listeningLine('R'), 'Listening. Release R to keep, Esc to cancel.');
  const loud = dictationReducer(listening, { type: 'level', level: 7 });
  assert.equal(dictationShown(loud)?.level, 1, 'clamped');
  assert.equal(dictationReducer(loud, { type: 'release', keep: true }).kind, 'transcribing');
  assert.equal(dictationReducer(loud, { type: 'cancel' }).kind, 'idle');
  assert.equal(keepsOnRelease({ upgraded: true, ended: 'up' }), true);
  for (const ended of ['cancel', 'interrupt', 'down'] as const)
    assert.equal(keepsOnRelease({ upgraded: true, ended }), false);
  assert.equal(keepsOnRelease({ upgraded: false, ended: 'up' }), false, 'a tap is not a hold');
});

test("after a reload the thread's send comes first, then its newest local reply draft", () => {
  const draft = (id: string, updatedAt: number, extra: Partial<Draft> = {}) =>
    ({ id, threadId: 't1', mode: 'reply', origin: 'local', updatedAt, ...extra }) as Draft;
  const drafts = [
    draft('old', 1),
    draft('new', 2),
    draft('remote', 3, { origin: 'remote' }),
    draft('fwd', 4, { mode: 'forward' }),
  ];
  assert.equal(replyDraftFor('t1', drafts, []), 'new');
  const live = { id: 's1', threadId: 't1', draftId: 'sending', state: 'queued' } as Submission;
  assert.equal(replyDraftFor('t1', drafts, [live]), 'sending');
  assert.equal(replyDraftFor('t1', drafts, [{ ...live, state: 'sent' }]), 'new');
  assert.equal(replyDraftFor('t2', drafts, []), null);
});

test('one tray per send: a submission is claimed by a composer or shown by the toast stack, never both', () => {
  let state: HandoffState = { handedOff: [], claims: new Map(), rows: new Map() };
  state = claim(state, 's1');
  assert.equal(shownByToast(state), null);
  state = release(state, 's1', true);
  assert.equal(shownByToast(state), 's1', 'the composer went away mid-send');
  state = release(state, 's1', true);
  assert.deepEqual(state.handedOff, ['s1'], 'never twice');
  state = claim(state, 's1');
  assert.equal(shownByToast(state), null, 'back on the thread: the toast goes');
  state = release(state, 's1', false);
  assert.equal(shownByToast(state), null, 'a settled send is not handed off');
  state = settle(release(claim(state, 's2'), 's2', true), 's2');
  assert.equal(shownByToast(state), null);
});

test('a window is resolved only when it is live and every listed id has its row', () => {
  const rows = new Map([['a', 1]]);
  assert.equal(rowsResolved({ status: 'opening', ids: [], rows }), false);
  assert.equal(
    rowsResolved({ status: 'live', ids: ['a', 'b'], rows }),
    false,
    'b is listed, not yet fetched',
  );
  assert.equal(rowsResolved({ status: 'live', ids: ['a'], rows }), true);
  assert.equal(
    rowsResolved({ status: 'live', ids: [], rows: new Map() }),
    true,
    'a really empty window',
  );
  assert.equal(
    rowsResolved({ status: 'failed', ids: ['a', 'b'], rows }),
    true,
    'a failed window reads as empty',
  );
});
