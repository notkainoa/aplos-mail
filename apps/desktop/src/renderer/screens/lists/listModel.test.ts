/**
 * The lists' pure logic: the cursor over ids, its survival under rows leaving and arriving (a seeded fuzz of a triage
 * burst with mail arriving), the window around the cursor, date groups, and the row mapping for worst-case data (long
 * names, empty subjects, emoji, 500 rows). Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*'`.
 */
import test from 'node:test';
import { emptyText } from '../../shell/states';
import { handledLine } from '../../App';
import { ZERO_ACCOUNTS } from '../../onboarding/demo';
import { GONE_COPY } from '../reader/ReaderLetter';
import { NO_THREAD_COPY } from '../reader/ReaderScreen';
import assert from 'node:assert/strict';
import type { Draft, Submission, ThreadRow } from '../../data';
import {
  ALL_CONFIG,
  BOOKMARKS_CONFIG,
  DONE_CONFIG,
  DRAFTS_CONFIG,
  SENT_CONFIG,
  SPAM_CONFIG,
  TRASH_CONFIG,
  configFor,
  labelConfig,
  viewSpecOf,
} from './listKinds';
import { formatListDate, setFormatClock } from '../../ui/list/internal/format';
import {
  LIST_WINDOW,
  confirmationIsStale,
  dateGroupLabel,
  groupByDate,
  neighbourKeys,
  rangeAround,
  settleKey,
  stepKey,
} from './listModel';
import {
  dateMsOf,
  doneMsOf,
  draftLine,
  listRowPropsFor,
  plainText,
  recipientsLine,
  recipientsOfDraft,
  recipientsOfThread,
  shortWho,
  targetOf,
} from './listRows';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test('stepKey moves one row, stops at the ends, never wraps, and starts at the top', () => {
  const list = ids(3);
  assert.equal(stepKey(list, null, 1), 't0');
  assert.equal(stepKey(list, 't0', 1), 't1');
  assert.equal(stepKey(list, 't2', 1), 't2');
  assert.equal(stepKey(list, 't0', -1), 't0');
  assert.equal(stepKey(list, 'gone', -1), 't0');
  assert.equal(stepKey([], 't0', 1), null);
});

test('settleKey keeps a row that is still there, and hands a leaving row to the one that took its place', () => {
  const before = ids(5);
  assert.equal(
    settleKey(before, ['t9', ...before], 't2'),
    't2',
    'mail arriving above does not move it',
  );
  assert.equal(settleKey(before, ['t0', 't1', 't3', 't4'], 't2'), 't3', 'the next row');
  assert.equal(
    settleKey(before, ['t0', 't1', 't2', 't3'], 't4'),
    't3',
    'the one above when it was last',
  );
  assert.equal(settleKey(before, [], 't2'), null);
  assert.equal(settleKey([], ids(2), null), 't0');
});

test('neighbourKeys pins the rows around the cursor and nothing for an unknown key', () => {
  assert.deepEqual(neighbourKeys(ids(10), 't5', 2), ['t3', 't4', 't5', 't6', 't7']);
  assert.deepEqual(neighbourKeys(ids(10), 't0', 3), ['t0', 't1', 't2', 't3']);
  assert.deepEqual(neighbourKeys(ids(10), 'nope'), []);
});

test('rangeAround keeps one window of at most 200 rows around the cursor, inside the view', () => {
  assert.deepEqual(rangeAround(0, 10_000), { start: 0, end: LIST_WINDOW });
  assert.deepEqual(rangeAround(5_000, 10_000), { start: 4_900, end: 5_100 });
  assert.deepEqual(rangeAround(9_999, 10_000), { start: 9_800, end: 10_000 });
  assert.deepEqual(rangeAround(3, 40), { start: 0, end: 40 });
  assert.deepEqual(rangeAround(0, 0), { start: 0, end: 1 });
  for (const at of [0, 1, 250, 499]) {
    const range = rangeAround(at, 500);
    assert.ok(range.start <= at && at < range.end, `the cursor row ${at} is inside its window`);
    assert.equal(range.end - range.start, LIST_WINDOW);
  }
});

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('fuzz: mail arriving during a triage burst never moves the row under the cursor', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = rng(seed);
    let list = ids(30);
    let nextId = 1000;
    let key = settleKey([], list, null);
    for (let step = 0; step < 60; step++) {
      const roll = next();
      const before = list;
      if (roll < 0.4) {
        const at = Math.floor(next() * (list.length + 1));
        list = [...list.slice(0, at), `n${nextId++}`, ...list.slice(at)];
        const settled = settleKey(before, list, key);
        assert.equal(settled, key, `seed ${seed}: an arrival at ${at} moved the cursor`);
      } else if (roll < 0.7) {
        key = stepKey(list, key, next() < 0.5 ? 1 : -1);
      } else if (key !== null && list.length > 1) {
        list = list.filter(id => id !== key);
        const settled = settleKey(before, list, key);
        assert.ok(
          settled !== null && list.includes(settled),
          `seed ${seed}: the cursor left the list`,
        );
        key = settled;
      }
    }
  }
});

const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const day = (daysAgo: number, hour = 9) => new Date(2026, 9, 29 - daysAgo, hour).getTime();

test('date groups: Today, Yesterday, Earlier this week, Last week, then months', () => {
  assert.equal(dateGroupLabel(day(0, 8), NOW), 'Today');
  assert.equal(
    dateGroupLabel(NOW + 3_600_000, NOW),
    'Today',
    'a clock a little ahead is still today',
  );
  assert.equal(dateGroupLabel(day(1), NOW), 'Yesterday');
  assert.equal(
    dateGroupLabel(day(2), NOW),
    'Earlier this week',
    'Tuesday, in the week of Thursday Oct 29',
  );
  assert.equal(dateGroupLabel(day(5), NOW), 'Last week');
  assert.equal(dateGroupLabel(day(20), NOW), 'Earlier in October');
  assert.equal(dateGroupLabel(new Date(2026, 7, 3).getTime(), NOW), 'August');
  assert.equal(dateGroupLabel(new Date(2025, 11, 31).getTime(), NOW), 'December 2025');
});

test('groupByDate keeps the engine order in runs and gives an unfetched row the run before it', () => {
  const dates = new Map<string, number | undefined>([
    ['a', day(0)],
    ['b', day(0)],
    ['c', undefined],
    ['d', day(1)],
    ['e', day(0)],
  ]);
  const groups = groupByDate(['a', 'b', 'c', 'd', 'e'], id => dates.get(id), NOW);
  assert.deepEqual(
    groups.map(group => [group.label, group.ids]),
    [
      ['Today', ['a', 'b', 'c']],
      ['Yesterday', ['d']],
      ['Today', ['e']],
    ],
  );
  assert.equal(new Set(groups.map(group => group.key)).size, groups.length, 'keys are unique');
  assert.deepEqual(
    groupByDate(['x'], () => undefined, NOW).map(group => group.label),
    ['Today'],
  );
});

test('configFor and viewSpecOf name the right views', () => {
  assert.deepEqual(viewSpecOf(configFor('all')), {
    kind: 'mailbox',
    role: 'all',
    accountId: undefined,
  });
  assert.deepEqual(viewSpecOf(configFor('sent'), 'a1'), {
    kind: 'mailbox',
    role: 'sent',
    accountId: 'a1',
  });
  assert.equal(viewSpecOf(configFor('drafts')).kind, 'drafts');
  assert.equal(viewSpecOf(configFor('trash')).kind, 'mailbox');
  assert.deepEqual(viewSpecOf(configFor({ label: 'f9' })), { kind: 'label', folderId: 'f9' });
  assert.equal(viewSpecOf(DONE_CONFIG).kind, 'done');
  assert.notEqual(labelConfig('a').scope, labelConfig('b').scope, 'one hold gate per label');
  assert.deepEqual(
    [
      ALL_CONFIG,
      configFor('drafts'),
      configFor('sent'),
      configFor('trash'),
      configFor('spam'),
      DONE_CONFIG,
    ].map(config => config.empty),
    [
      'No mail here yet',
      'No drafts',
      'Nothing sent yet',
      'Trash is empty',
      'Spam is empty',
      'Nothing done yet',
    ],
  );
  assert.deepEqual(
    configFor('trash').hoverActions.map(a => a.label),
    ['Restore'],
  );
  assert.deepEqual(
    configFor('spam').hoverActions.map(a => a.label),
    ['Not spam'],
  );
  assert.deepEqual(
    DONE_CONFIG.hoverActions.map(a => a.label),
    ['Move to Home'],
  );
  assert.equal(DONE_CONFIG.layout, 'done');
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function thread(init: Partial<ThreadRow> & { id: string }): ThreadRow {
  return {
    accountId: 'a1',
    subject: 'Hello',
    snippet: '',
    fromName: 'Sender',
    participants: [
      { name: 'Sender', address: 's@x.example' },
      { name: 'Me', me: true },
    ],
    lastDate: NOW,
    unread: false,
    hasAttachments: false,
    workflow: { bookmarked: false, status: 'new', hiddenFromHome: false },
    rank: { lane: 'do', importance: 'normal', dueBand: 3, source: 'heuristic' },
    summary: { state: 'none' },
    ...init,
  } as unknown as ThreadRow;
}

const handlers = { onSelect: () => undefined, onOpen: () => undefined, onAction: () => undefined };
const context = (config: typeof ALL_CONFIG) => ({
  config,
  domId: 'x',
  density: 'comfortable' as const,
  cursor: false,
  accounts: [],
  handlers,
});

test('a Sent thread shows the recipients, not the owner', () => {
  const row = thread({
    id: 's',
    fromName: 'Alex Morgan',
    participants: [
      { name: 'Alex Morgan', me: true },
      { name: 'Studio team', address: 'team@x.example' },
      { address: 'jo@x.example' },
    ],
  });
  assert.equal(recipientsOfThread(row).text, 'To: Studio team, jo');
  assert.equal(
    recipientsOfThread(row).title,
    'To: Studio team <team@x.example>, jo@x.example',
    'the tooltip keeps the full addresses',
  );
  const props = listRowPropsFor(row, context(SENT_CONFIG));
  assert.equal(props.sender, 'To: Studio team, jo');
  assert.equal(props.senderTitle, 'To: Studio team <team@x.example>, jo@x.example');
});

test('a Sent thread prefers who the owner sent it to over who else wrote in it', () => {
  const row = thread({
    id: 's2',
    fromName: 'Leah Okafor',
    participants: [{ name: 'Leah Okafor' }, { name: 'Alex Morgan', me: true }],
  });
  const sent = {
    ...row,
    recipients: [
      { name: 'Priya Raman' },
      { name: 'Alex Morgan', me: true },
      { address: 'jo@x.example' },
    ],
  } as ThreadRow;
  assert.equal(recipientsOfThread(sent).text, 'To: Priya Raman, jo');
  assert.equal(listRowPropsFor(sent, context(SENT_CONFIG)).sender, 'To: Priya Raman, jo');
});

test('a Draft row shows recipients, subject and the edited time; an empty draft says so', () => {
  const draft = {
    id: 'd1',
    revision: 1,
    html: '<p>Hi <b>Jordan</b>,</p><p>Thoughts to follow.</p>',
    subject: '',
    to: [{ address: 'jordan@x.example', name: 'Jordan Park' }],
    cc: [],
    bcc: [],
    attachments: [],
    updatedAt: NOW,
  } as unknown as Draft;
  const props = listRowPropsFor(draft, context(DRAFTS_CONFIG));
  assert.equal(props.sender, 'To: Jordan Park');
  assert.equal(props.senderTitle, 'To: Jordan Park <jordan@x.example>');
  assert.equal(props.primary, 'Hi Jordan , Thoughts to follow.');
  assert.match(props.date, /^2026-10-29T10:00:00/);
  assert.equal(props.hoverActions.length, 0, 'Drafts has no quick action');
  const empty = { ...draft, to: [], subject: '  ', html: '<p></p>' } as unknown as Draft;
  assert.equal(recipientsOfDraft(empty).text, 'No recipient');
  assert.equal(draftLine(empty), 'No subject');
  assert.equal(plainText('<script>x</script>a<br>b'), 'x a b');
});

test('a Sent submission shows its recipients, subject and send time', () => {
  const submission = {
    id: 'sub1',
    toNames: ['Jordan Park', ' '],
    subject: '',
    notBefore: NOW,
    sentAt: NOW - 60_000,
    state: 'sent',
  } as unknown as Submission;
  const props = listRowPropsFor(submission, context(SENT_CONFIG));
  assert.equal(props.sender, 'To: Jordan Park');
  assert.equal(props.primary, 'No subject');
  assert.match(props.date, /^2026-10-29T09:59:00/);
});

test('a Done row carries the stamp time and the Move to Home action only', () => {
  const doneAt = new Date(2026, 9, 29, 9, 41).getTime();
  const props = listRowPropsFor(
    thread({ id: 'd', workflow: { bookmarked: false, status: 'done', doneAt } as never }),
    context(DONE_CONFIG),
  );
  assert.equal(props.layout, 'done');
  assert.match(props.doneAt ?? '', /^2026-10-29T09:41:00/);
  assert.deepEqual(
    props.hoverActions.map(a => a.commandId),
    ['done.moveToHome'],
  );
});

test('a recipients column leads with the display name or the local part and keeps full addresses in the tooltip', () => {
  const long =
    'alexandra.montgomery-featherstonehaugh@a-rather-long-subdomain.example-company.co.uk';
  const expected = {
    text: 'To: alexandra.montgomery-featherstonehaugh',
    title: `To: ${long}`,
    names: 'alexandra.montgomery-featherstonehaugh',
  };
  assert.deepEqual(recipientsLine([{ address: long }]), expected);
  assert.deepEqual(recipientsLine([{ name: long, address: long }]), expected);
  const line = recipientsLine([
    { name: 'Jordan Park', address: 'jordan@x.example' },
    { address: 'mina@x.example' },
    { name: '  ' },
    { name: 'Dev Rao', address: 'dev@x.example' },
    { name: 'Sam Lee', address: 'sam@x.example' },
  ]);
  assert.equal(line?.text, 'To: Jordan Park, mina, Dev Rao and 1 more');
  assert.equal(
    line?.title,
    'To: Jordan Park <jordan@x.example>, mina@x.example, Dev Rao <dev@x.example>, Sam Lee <sam@x.example>',
  );
  assert.equal(recipientsLine([]), undefined);
  assert.equal(shortWho('  Mina   Cho '), 'Mina Cho');
});

test('the recipients line: three names fit, more are counted, the tooltip is capped, an embedded address shows once', () => {
  const three = ['Ann', 'Bo', 'Cy'].map(name => ({ name }));
  assert.equal(recipientsLine(three)?.text, 'To: Ann, Bo, Cy');
  assert.equal(recipientsLine([...three, { name: 'Di' }])?.text, 'To: Ann, Bo, Cy and 1 more');
  const crowd = Array.from({ length: 12 }, (_, i) => ({ address: `p${i}@x.example` }));
  const title = recipientsLine(crowd)?.title ?? '';
  assert.equal(
    title,
    'To: p0@x.example, p1@x.example, p2@x.example, p3@x.example, p4@x.example and 7 more',
  );
  assert.equal(
    recipientsLine([{ name: 'Jo <jo@x.example>', address: 'jo@x.example' }])?.title,
    'To: Jo <jo@x.example>',
  );
  assert.equal(
    recipientsLine(crowd)?.names,
    'p0, p1, p2 and 9 more',
    'plain names for the palette',
  );
});

test('recipient names: an angle address, quotes and "Last, First" read cleanly; an address-like name is kept whole', () => {
  assert.equal(
    recipientsLine([{ name: 'Jo <jo@x.example>', address: 'jo@x.example' }])?.text,
    'To: Jo',
  );
  assert.equal(recipientsLine([{ name: 'Jo <jo@x.example>' }])?.title, 'To: Jo <jo@x.example>');
  const park = recipientsLine([{ name: '"Park, Jordan"', address: 'jordan@x.example' }]);
  assert.equal(park?.text, 'To: Park, Jordan');
  assert.equal(park?.title, 'To: Park, Jordan <jordan@x.example>');
  const odd = recipientsLine([{ name: 'a@x.example', address: 'real.person@y.example' }]);
  assert.equal(odd?.text, 'To: a@x.example', 'not cut to "a"');
  assert.equal(shortWho('"Park, Jordan" <jordan@x.example>'), 'Park, Jordan');
});

test('a Sent thread leaves the owner out of both the recipients and the fallback people', () => {
  const row = thread({
    id: 'me',
    participants: [
      { name: 'Alex Morgan', address: 'alex@x.example', me: true },
      { name: 'Priya Raman', address: 'priya@x.example' },
    ],
  });
  const sent = { ...row, recipients: [{ name: 'Alex Morgan', me: true }, { name: 'Dev Rao' }] };
  assert.equal(recipientsOfThread(sent as ThreadRow).text, 'To: Dev Rao');
  assert.equal(
    recipientsOfThread(row).text,
    'To: Priya Raman',
    'no recipients: the other participants',
  );
});

test('a draft in the palette reads plain names, and a future date groups the way its row reads', () => {
  const draft = {
    id: 'd9',
    revision: 1,
    html: '<p>Hi</p>',
    subject: '',
    to: [{ name: 'Jordan Park', address: 'jordan@x.example' }],
    attachments: [],
    updatedAt: NOW,
  } as unknown as Draft;
  assert.equal(targetOf(draft).title, 'Jordan Park');
  const tomorrow = new Date(2026, 9, 30, 9).getTime();
  assert.equal(dateGroupLabel(tomorrow, NOW), 'Tomorrow');
  assert.equal(dateGroupLabel(new Date(2026, 10, 4, 9).getTime(), NOW), 'Upcoming');
  const row = thread({ id: 'f', lastDate: tomorrow });
  const props = listRowPropsFor(row, context(ALL_CONFIG));
  setFormatClock(() => NOW);
  const text = formatListDate(props.date);
  setFormatClock(null);
  assert.equal(text, 'Tomorrow', 'the row text and its group header agree');
});

test('Drafts and Sent group by date like All mail; Done groups by when it was finished', () => {
  assert.deepEqual(
    [ALL_CONFIG, DRAFTS_CONFIG, SENT_CONFIG, DONE_CONFIG, TRASH_CONFIG, SPAM_CONFIG].map(
      c => c.dateGroups,
    ),
    [true, true, true, true, true, true],
  );
  const draft = (id: string, updatedAt: number) =>
    ({ id, revision: 1, html: '', subject: id, to: [], updatedAt }) as unknown as Draft;
  const drafts = [
    draft('a', day(0, 8)),
    draft('b', day(1)),
    draft('c', day(1, 8)),
    draft('d', day(20)),
  ];
  const groups = groupByDate(
    drafts.map(d => d.id),
    id =>
      dateMsOf(
        drafts.find(d => d.id === id)!,
        DRAFTS_CONFIG.dateField,
      ),
    NOW,
  );
  assert.deepEqual(
    groups.map(g => [g.label, g.ids]),
    [
      ['Today', ['a']],
      ['Yesterday', ['b', 'c']],
      ['Earlier in October', ['d']],
    ].map(([label, ids]) => [label, ids]),
  );
});

test('Done rows group and stamp by the finish time, else by the last message, never all under Today', () => {
  const finished = thread({
    id: 'f',
    lastDate: day(9),
    workflow: {
      bookmarked: false,
      status: 'done',
      hiddenFromHome: false,
      doneAt: day(0, 8),
    } as never,
  });
  const unstamped = thread({
    id: 'u',
    lastDate: day(1, 14),
    workflow: { bookmarked: false, status: 'done', hiddenFromHome: false } as never,
  });
  const older = thread({
    id: 'o',
    lastDate: day(40),
    workflow: { bookmarked: false, status: 'done', hiddenFromHome: false } as never,
  });
  assert.equal(doneMsOf(finished), day(0, 8));
  assert.equal(doneMsOf(unstamped), day(1, 14), 'the real engine does not stamp doneAt yet');
  const rows = [finished, unstamped, older];
  const groups = groupByDate(
    rows.map(r => r.id),
    id =>
      dateMsOf(
        rows.find(r => r.id === id)!,
        DONE_CONFIG.dateField,
      ),
    NOW,
  );
  assert.deepEqual(
    groups.map(g => g.label),
    ['Today', 'Yesterday', 'September'],
  );
  assert.match(
    listRowPropsFor(unstamped, context(DONE_CONFIG)).doneAt ?? '',
    /^2026-10-28T14:00:00/,
  );
  assert.match(
    listRowPropsFor(finished, context(DONE_CONFIG)).doneAt ?? '',
    /^2026-10-29T08:00:00/,
  );
});

test('worst-case rows: long names, empty subjects, emoji, 500 rows', () => {
  const names = [
    'A'.repeat(300),
    '',
    '👩🏽‍💻 Ünïcödé Ñame',
    'x@' + 'y'.repeat(200) + '.example',
    '日本語の名前',
  ];
  const rows = Array.from({ length: 500 }, (_, i) =>
    thread({
      id: `w${i}`,
      subject: i % 3 === 0 ? '' : '🙂'.repeat(i % 40),
      fromName: names[i % names.length] ?? '',
      participants: i % 7 === 0 ? [] : [{ name: names[i % names.length] }],
      lastDate: NOW - i * 3_600_000,
    }),
  );
  const byId = new Map(rows.map(row => [row.id, row]));
  const all = rows.map(row => row.id);
  for (const config of [ALL_CONFIG, SENT_CONFIG, DONE_CONFIG]) {
    for (const row of rows) {
      const props = listRowPropsFor(row, context(config));
      assert.ok(props.sender.length > 0, 'a sender is always drawn');
      assert.ok(props.primary.length > 0, 'a main line is always drawn');
    }
  }
  const groups = groupByDate(all, id => byId.get(id)?.lastDate, NOW);
  assert.deepEqual(
    groups.flatMap(group => [...group.ids]),
    all,
    'grouping keeps all 500 in order',
  );
  let key = settleKey([], all, null);
  for (let i = 0; i < 499; i++) key = stepKey(all, key, 1);
  assert.equal(key, 'w499');
  assert.equal(stepKey(all, key, 1), 'w499');
  const range = rangeAround(499, 10_000);
  assert.ok(range.end - range.start <= LIST_WINDOW);
});

test('a confirmation is stale once none of its threads is in the list', () => {
  assert.equal(confirmationIsStale({ ids: ['a'] }, []), true, 'the list emptied');
  assert.equal(confirmationIsStale({ ids: ['a', 'b'] }, ['b', 'c']), false);
  assert.equal(confirmationIsStale({ ids: ['a'] }, ['b']), true);
});

test('no empty-state string ends with a period (owner override 2026-11-05)', () => {
  const copies: readonly (string | undefined)[] = [
    ...[ALL_CONFIG, DRAFTS_CONFIG, SENT_CONFIG, TRASH_CONFIG, SPAM_CONFIG, DONE_CONFIG].flatMap(
      c => [c.empty, c.emptyDetail],
    ),
    BOOKMARKS_CONFIG.empty,
    BOOKMARKS_CONFIG.emptyDetail,
    ...(['later', 'all', 'done', 'drafts', 'sent', 'trash', 'spam'] as const).map(emptyText),
    handledLine(1),
    handledLine(12),
    ZERO_ACCOUNTS.text,
    ZERO_ACCOUNTS.firstSync,
    GONE_COPY,
    NO_THREAD_COPY,
  ];
  for (const copy of copies)
    if (copy !== undefined) assert.doesNotMatch(copy, /\.\s*$/, `trailing period: ${copy}`);
});
