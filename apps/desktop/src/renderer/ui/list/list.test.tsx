// List family: structure, copy, aria and data-state for each component, with demo and worst-case data.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/list.test.tsx

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { DueInfo, FocusLetterProps, ListRowProps, LowSheetGroup, TriageCommands } from '../props';
import { Chip, CommitChip, CommitEdge, EmptyLine, ErrorLine, FocusLetter, FocusSlot, ListBox, ListGroup, ListRow, LowBand, LowSheet, SectionHeader } from './index';
import { ListKeyHintsContext } from './internal/keyHints';
import { lowBandNames } from './LowBand';
import { bannedIn, freezeClock, html, text, WORST } from './testkit.test';

const noop = () => {};
const TODAY_10 = '2026-10-29T10:00:00-07:00';
const TOMORROW: DueInfo = { at: '2026-10-30T00:00:00-07:00', overdue: false, source: 'user' };
const DUE_TODAY: DueInfo = { at: '2026-10-29T00:00:00-07:00', overdue: true, source: 'structured' };
const FOUND: DueInfo = { at: '2026-10-31T00:00:00-07:00', overdue: false, source: 'ai' };
const COMMANDS: TriageCommands = { suggest: 'mail.suggested', later: 'mail.later', done: 'mail.done', more: 'list.more' };

function row(over: Partial<ListRowProps> = {}): ListRowProps {
  return {
    id: 'row-leah',
    layout: 'home',
    density: 'comfortable',
    sender: 'Leah Okafor',
    primary: 'Lunch for six tomorrow. Leah asks you to pick somewhere quiet with vegetarian options.',
    unread: false,
    date: '2026-10-27T09:30:00-07:00',
    showAccountDot: false,
    cursor: false,
    picked: false,
    picking: false,
    hoverActions: [
      { commandId: 'mail.later', icon: 'clock', label: 'Later' },
      { commandId: 'mail.done', icon: 'check', label: 'Done' },
    ],
    onSelect: noop,
    onOpen: noop,
    onAction: noop,
    ...over,
  };
}

function letter(over: Partial<FocusLetterProps> = {}): FocusLetterProps {
  return {
    id: 'focus-jordan',
    sender: 'Jordan Park',
    due: TOMORROW,
    date: TODAY_10,
    summary: {
      state: 'ready',
      text: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.',
      subject: 'A quieter home for the Hollow Creek site',
      provenance: { provider: 'Groq', local: false },
    },
    suggestion: { verb: 'Reply', icon: 'reply', isDone: false },
    commands: COMMANDS,
    demoted: false,
    onSuggestion: noop,
    onLater: noop,
    onDone: noop,
    onMore: noop,
    ...over,
  };
}

const collected: string[] = [];
function render(element: Parameters<typeof html>[0]): string {
  const markup = html(element);
  collected.push(markup);
  return markup;
}

before(() => freezeClock());

describe('ListRow', () => {
  test('read row: option, no dot fill, dim line, date column, hover actions as pointer duplicates', () => {
    const m = render(<ListRow {...row()} />);
    assert.match(m, /^<div id="row-leah" role="option" aria-selected="false" class="ui-list-row" data-layout="home" data-density="comfortable"/);
    assert.doesNotMatch(m, /data-unread/);
    assert.match(m, /Tuesday<\/time>/);
    assert.match(m, /class="ui-list-row__actions"/);
    assert.match(m, /aria-label="Later" title="Later · L" tabindex="-1" aria-hidden="true"/);
    assert.match(m, /aria-label="Done" title="Done · E" tabindex="-1" aria-hidden="true"/);
    assert.doesNotMatch(m, /ui-list-row__account/, 'one account: no dot');
  });

  test('unread, cursor, due chip and the account dot only with two or more accounts', () => {
    const m = render(
      <ListRow {...row({ unread: true, cursor: true, due: TOMORROW, account: { label: 'alex@fernworks.studio', color: 'hill' }, showAccountDot: true })} />,
    );
    assert.match(m, /aria-selected="true"/);
    assert.match(m, /data-unread="true" data-cursor="true"/);
    assert.match(m, /Unread\./);
    assert.match(m, /data-kind="due"[^>]*>.*Tomorrow/);
    assert.match(m, /class="ui-list-row__account" style="--swatch:var\(--tag-hill\)"/);
    assert.match(m, /title="alex@fernworks.studio"/, 'account always in the row tooltip');
    const hidden = render(<ListRow {...row({ account: { label: 'alex@fernworks.studio', color: 'hill' }, showAccountDot: false })} />);
    assert.doesNotMatch(hidden, /ui-list-row__account/);
    assert.match(hidden, /title="alex@fernworks.studio"/);
  });

  test('bulk picking: pick box replaces the dot and aria-selected follows the pick', () => {
    const m = render(<ListRow {...row({ layout: 'list', picking: true, picked: true, cursor: false })} />);
    assert.match(m, /aria-selected="true"/);
    assert.match(m, /data-picked="true" data-picking="true"/);
    assert.match(m, /ui-list-row__pick/);
    assert.doesNotMatch(m, /ui-list-row__dot/);
  });

  test('done layout: fixed stamp column, "Move to Home" is the only action', () => {
    const m = render(
      <ListRow {...row({ layout: 'done', doneAt: '2026-10-29T09:41:00-07:00', hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }] })} />,
    );
    assert.match(m, /data-layout="done"/);
    assert.match(m, /class="ui-list-row__stamp"[^>]*>.*Done 9:41 AM<\/span>/);
    assert.match(m, /aria-label="Move to Home" title="Move to Home · H"/);
    const older = render(<ListRow {...row({ layout: 'done', doneAt: '2026-10-28T08:52:00-07:00' })} />);
    assert.match(older, /Done Wed 8:52 AM/);
  });

  test('later layout: the laterUntil chip takes the date column', () => {
    const m = render(<ListRow {...row({ layout: 'later', laterUntil: { kind: 'at', at: '2026-10-27T00:00:00-07:00', overdue: true } })} />);
    assert.match(m, /data-kind="laterUntil" data-overdue="true"/);
    assert.match(m, /Tue, Oct 27/);
    assert.doesNotMatch(m, /ui-list-row__date/);
    const someday = render(<ListRow {...row({ layout: 'later', laterUntil: { kind: 'someday' } })} />);
    assert.match(someday, /Someday/);
  });

  test('rejected write: back in place with "Couldn’t move to Later." and Retry', () => {
    const m = render(<ListRow {...row({ rejected: { op: 'move to Later', onRetry: noop } })} />);
    assert.match(m, /data-state="rejected"/);
    assert.match(text(m), /Couldn’t move to Later\. Retry/);
    assert.doesNotMatch(m, /role="alert"/, 'inside an option the error is read with the row');
  });

  test('inside a listbox Retry stays reachable (no key retries yet); hover actions stay pointer duplicates', () => {
    const m = render(
      <ListBox binding={{ id: 'home', label: 'Home', activeDescendantId: 'row-leah' }}>
        <ListRow {...row({ cursor: true, rejected: { op: 'move to Later', onRetry: noop } })} />
      </ListBox>,
    );
    const retry = m.match(/<button[^>]*title="Retry"[^>]*>/)?.[0] ?? '';
    assert.ok(retry, 'Retry renders');
    assert.doesNotMatch(retry, /tabindex|aria-hidden/);
    assert.match(m, /<button[^>]*aria-label="Later"[^>]*tabindex="-1" aria-hidden="true"/);
  });

  test('dates: weekday names only earlier this week, month-day before that', () => {
    const monday = render(<ListRow {...row({ date: '2026-10-26T09:00:00-07:00' })} />);
    assert.match(monday, />Monday<\/time>/);
    const lastFriday = render(<ListRow {...row({ date: '2026-10-23T09:00:00-07:00' })} />);
    assert.match(lastFriday, />Oct 23<\/time>/);
  });

  test('hover actions sit inside the meta cell so they cover the whole date column', () => {
    const m = render(<ListRow {...row()} />);
    assert.match(m, /<span class="ui-list-row__meta">.*<time[^>]*>Tuesday<\/time><span class="ui-list-row__actions">/);
  });

  test('mail-derived text follows its own direction (dir="auto")', () => {
    const m = render(<ListRow {...row({ sender: WORST.arabic, primary: WORST.arabic, secondary: WORST.cjk, layout: 'list' })} />);
    assert.match(m, /class="ui-list-row__sender" dir="auto"/);
    assert.match(m, /class="ui-list-row__primary" dir="auto"/);
    assert.match(m, /class="ui-list-row__secondary" dir="auto"/);
  });

  test('search: secondary snippet and bold terms, marks with screen-reader words', () => {
    const m = render(
      <ListRow
        {...row({ layout: 'list', primary: 'Dentist appointment', secondary: 'Your dentist cleaning is Thursday', highlight: ['dentist'], marks: { replied: true, bookmarked: true, attachment: true } })}
      />,
    );
    assert.equal((m.match(/class="ui-list-row__hit"/g) ?? []).length, 2);
    assert.match(m, /<b class="ui-list-row__hit">Dentist<\/b>/);
    assert.match(m, /data-has-secondary="true"/);
    assert.match(text(m), /Replied\. .*Bookmarked\. .*Has attachments\./);
  });

  test('worst case: long, unbreakable, one-letter, CJK, RTL and emoji render intact', () => {
    for (const [sender, primary] of [
      [WORST.oneLetter, WORST.subject],
      [WORST.email, WORST.email],
      [WORST.cjk, WORST.cjk],
      [WORST.arabic, WORST.arabic],
      [WORST.emoji, WORST.emoji],
    ]) {
      const m = render(<ListRow {...row({ sender, primary, density: 'compact' })} />);
      assert.ok(text(m).includes(sender));
      assert.ok(text(m).includes(primary));
      assert.match(m, /data-density="compact"/);
    }
  });

  test('swipe underlays exist, hidden, for the motion runtime', () => {
    const m = render(<ListRow {...row({ swipe: { right: 'done', left: 'later' } })} />);
    assert.match(m, /data-side="right" data-kind="done" aria-hidden="true" hidden=""/);
    assert.match(m, /data-side="left" data-kind="later" aria-hidden="true" hidden=""/);
  });
});

describe('ListBox, ListGroup, SectionHeader', () => {
  test('listbox owns aria-activedescendant; group is labelled by its presentational header', () => {
    const m = render(
      <ListBox binding={{ id: 'home', label: 'Home', activeDescendantId: 'focus-jordan' }}>
        <ListGroup
          header={{ id: 'sec-do', label: 'Do now', variant: 'section', count: 6, action: { label: 'Go one by one', commandId: 'home.oneByOne', onSelect: noop } }}
        >
          <ListRow {...row()} />
        </ListGroup>
      </ListBox>,
    );
    assert.match(m, /^<div id="home" class="ui-list-box" role="listbox" tabindex="0" aria-label="Home" aria-activedescendant="focus-jordan">/);
    assert.match(m, /role="group" aria-labelledby="sec-do"/);
    assert.match(m, /<div role="presentation" id="sec-do" class="ui-section-header" data-variant="section"/);
    assert.match(m, /ui-section-header__label">Do now<\/span><span class="ui-section-header__count">6<\/span>/);
    assert.match(m, /title="Go one by one · S" tabindex="-1" aria-hidden="true"/, 'pointer duplicate of S inside the listbox');
    assert.doesNotMatch(m, /<h1|<h2|page-title/, 'no page title, no heading inside the listbox');
  });

  test('multiselectable listbox when picking', () => {
    const m = render(<ListBox binding={{ id: 'all', label: 'All mail' }} multiselectable>{null}</ListBox>);
    assert.match(m, /aria-multiselectable="true"/);
    assert.doesNotMatch(m, /aria-activedescendant/);
  });

  test('an empty section does not render unless held, then it shows 0', () => {
    assert.equal(render(<ListGroup header={{ id: 'u', label: 'Important updates', variant: 'section', count: 0 }}>{null}</ListGroup>), '');
    const held = render(<ListGroup header={{ id: 'u', label: 'Important updates', variant: 'section', count: 0, held: true }}>{null}</ListGroup>);
    assert.match(held, /data-held="true"/);
    assert.match(held, /ui-section-header__count">0</);
  });

  test('outside a listbox the label is a heading; overdue adds a clock; sub-label, 2 new, drop target', () => {
    const settings = render(<SectionHeader id="acc" label="Accounts" variant="section" />);
    assert.match(settings, /^<h2 id="acc" class="ui-section-header"/);
    const overdue = render(<SectionHeader id="ov" label="Overdue" variant="section" tone="overdue" count={9999} />);
    assert.match(overdue, /data-tone="overdue"/);
    assert.match(overdue, /data-icon="clock"/);
    assert.match(overdue, /9,999/);
    const sub = render(<SectionHeader id="bfl" label="Back from Later" variant="sub" count={2} waitingNew={2} action={{ label: 'Clear from Home', onSelect: noop }} />);
    assert.match(sub, /data-variant="sub"/);
    assert.match(text(sub), /Back from Later 2 2 new Clear from Home/);
    const drop = render(<SectionHeader id="wk" label="This week" variant="section" dropTarget={{ label: 'Tomorrow, 8:00 AM', state: 'over' }} />);
    assert.match(drop, /data-drop="over"/);
    assert.match(text(drop), /Move to Tomorrow, 8:00 AM/);
  });
});

describe('FocusSlot and FocusLetter', () => {
  test('slot height follows density', () => {
    for (const density of ['roomy', 'comfortable', 'compact'] as const) {
      assert.match(render(<FocusSlot density={density}>{null}</FocusSlot>), new RegExp(`class="ui-focus-slot" data-density="${density}" role="presentation"`));
    }
  });

  test('meta line, serif summary clamped to two lines, filled suggestion with Space, Later, Done, More', () => {
    const m = render(<FocusLetter {...letter()} />);
    assert.match(m, /^<div id="focus-jordan" role="option" aria-selected="true" class="ui-focus-letter"/);
    assert.match(m, /ui-focus-letter__sender" dir="auto">Jordan Park</);
    assert.match(m, /data-kind="due"[^>]*>.*Tomorrow/);
    assert.match(m, /10:00 AM<\/time>/);
    assert.match(m, /class="ui-summary" dir="auto" data-state="ready" data-clamp="two-lines" title="Summary by Groq"/);
    assert.match(m, /data-variant="filled" data-size="md" title="Reply · Space" tabindex="-1" aria-hidden="true">.*Reply<\/span><kbd class="ui-list-kbd">Space<\/kbd>/);
    assert.match(m, /title="Later · L"/);
    assert.match(m, /title="Done · E"/);
    assert.match(m, /aria-label="More" title="More: bookmark, trash, why it’s here · \."/);
    assert.equal((m.match(/data-variant="filled"/g) ?? []).length, 1, 'one filled button');
    assert.doesNotMatch(m, /data-icon="bookmark"/, 'no bookmark icon on the card');
  });

  test('Done is omitted when the suggestion is Done', () => {
    const m = render(<FocusLetter {...letter({ suggestion: { verb: 'Done', icon: 'check', isDone: true } })} />);
    assert.equal((m.match(/>Done</g) ?? []).length, 1);
  });

  test('demoted: the suggestion becomes a text button without its keycap', () => {
    const m = render(<FocusLetter {...letter({ demoted: true })} />);
    assert.match(m, /data-demoted="true"/);
    assert.doesNotMatch(m, /data-variant="filled"/);
    assert.doesNotMatch(m, /<kbd/);
  });

  test('pending and absent summaries show the subject in SF; narrow drops labels but keeps the verb', () => {
    const pending = render(<FocusLetter {...letter({ summary: { state: 'pending', subject: 'A quieter home' }, narrow: true })} />);
    assert.match(pending, /data-state="pending" data-clamp="two-lines" aria-busy="true">A quieter home</);
    assert.match(pending, /data-narrow="true"/);
    assert.match(pending, /data-label-hidden="true" aria-label="Later"/);
    assert.match(pending, />Reply<\/span>/);
    const absent = render(<FocusLetter {...letter({ summary: { state: 'absent', subject: WORST.subject } })} />);
    assert.match(absent, /data-state="absent"/);
    assert.doesNotMatch(absent, /Summary by/);
  });

  test('key hints: ⌘ held shows badges on Later, Done and More; the default shows none', () => {
    const plain = render(<FocusLetter {...letter()} />);
    assert.doesNotMatch(plain, /data-reveal/);
    const held = render(
      <ListKeyHintsContext.Provider value={{ showKeys: 'held' }}>
        <FocusLetter {...letter()} />
      </ListKeyHintsContext.Provider>,
    );
    const badges = [...held.matchAll(/<kbd class="ui-list-kbd" data-reveal="badge" aria-hidden="true">([^<]+)<\/kbd>/g)].map((x) => x[1]);
    assert.equal(badges.length, 3, held);
    assert.match(held, /class="ui-focus-letter__sender" dir="auto"/);
  });

  test('rejected write shows on the card; worst-case sender and verb', () => {
    const m = render(
      <FocusLetter
        {...letter({ sender: WORST.email, due: DUE_TODAY, rejected: { op: 'mark Done', onRetry: noop }, suggestion: { verb: WORST.emoji, icon: 'calendar', isDone: false } })}
      />,
    );
    assert.match(m, /data-state="rejected"/);
    assert.match(text(m), /Couldn’t mark Done\. Retry/);
    assert.match(m, /data-overdue="true"/);
    assert.match(text(m), /Due today/);
    assert.ok(text(m).includes(WORST.email));
  });
});

describe('LowBand and LowSheet', () => {
  test('label, up to three names and "and N more", plain count right, no badge', () => {
    const m = render(
      <LowBand id="low" senders={['Field Notes', 'Cedar Market', 'Google', 'Rail Co', 'Bookshop', 'Bank']} count={6} cursor={false} density="comfortable" commandId="mail.open" onOpen={noop} />,
    );
    assert.match(m, /role="option" aria-selected="false" class="ui-low-band"/);
    assert.match(text(m), /^Low importance Field Notes, Cedar Market, Google and 3 more 6$/);
    assert.match(m, /title="Open low importance · Return"/);
    assert.equal(lowBandNames(['A']), 'A');
    assert.equal(lowBandNames(['A', 'B']), 'A and B');
    assert.equal(lowBandNames(['A', 'B', 'C']), 'A, B and C');
    assert.equal(lowBandNames([]), '');
    assert.match(m, /<span class="ui-low-band__names" dir="auto">Field Notes, Cedar Market, Google<\/span><span class="ui-low-band__more"> and 3 more<\/span>/);
    const long = render(<LowBand id="low" senders={[WORST.email, WORST.subject, 'X', ...Array(9999).fill('Y')]} count={9999} cursor={false} density="comfortable" commandId="mail.open" onOpen={noop} />);
    assert.match(long, /<span class="ui-low-band__more"> and 9,999 more<\/span>/, 'the count of hidden senders is its own span');
    const big = render(<LowBand id="low" senders={[]} count={9999} cursor density="compact" commandId="mail.open" onOpen={noop} />);
    assert.match(big, /data-cursor="true"/);
    assert.match(text(big), /^Low importance 9,999$/);
  });

  const groups: LowSheetGroup[] = [
    { id: 'g-field', sender: 'Field Notes', rows: [row({ id: 'r1', layout: 'list', sender: 'Field Notes', primary: 'Issue 41: a short guide to winter light' })], onUnsubscribe: noop },
    { id: 'g-cedar', sender: 'Cedar Market', rows: [row({ id: 'r2', layout: 'list', sender: 'Cedar Market', primary: 'Your receipt' }), row({ id: 'r3', layout: 'list', sender: 'Cedar Market', primary: 'Weekly deals' })] },
  ];

  test('closed renders nothing; open is a labelled modal dialog grouped by sender', () => {
    const base = { binding: { id: 'low-list', label: 'Low importance' }, groups, armed: false, markAllCommandId: 'lowImportance.markAllDone', onArm: noop, onCommitAll: noop, onClose: noop };
    assert.equal(render(<LowSheet open={false} {...base} />), '');
    const m = render(<LowSheet open {...base} preview={{ rowId: 'r1', text: 'Winter light, in five short notes.' }} />);
    assert.match(m, /role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    assert.match(m, /Low importance<\/h2><span class="ui-low-sheet__count">3</);
    assert.match(m, /role="listbox"/);
    assert.match(text(m), /Field Notes 1 Unsubscribe/);
    assert.match(text(m), /Press → twice to mark all 3 done/);
    assert.match(text(m), /Winter light, in five short notes\./);
    assert.match(m, /role="dialog" aria-modal="true" aria-labelledby="[^"]+" tabindex="-1"/, 'focusable fallback for focus on open');
    const armed = render(<LowSheet open {...base} armed />);
    assert.match(armed, /data-armed="true"/);
    assert.match(text(armed), /Press → again to mark all 3 done · Esc cancels/);
    assert.match(armed, /class="ui-low-sheet__foot" role="status"/, 'without the shell announcer the foot is the live region');
    const announced = render(<LowSheet open {...base} armed announce={noop} />);
    assert.doesNotMatch(announced, /class="ui-low-sheet__foot" role="status"/, 'with the announcer arming is spoken once');
    assert.match(announced, /<button[^>]*title="Unsubscribe"(?![^>]*tabindex)[^>]*>/, 'Unsubscribe has no key, so it stays reachable');
  });

  test('empty sheet: "No low-importance mail." with Back to Home', () => {
    const m = render(
      <LowSheet open binding={{ id: 'l', label: 'Low importance' }} groups={[]} armed={false} markAllCommandId="lowImportance.markAllDone" onArm={noop} onCommitAll={noop} onClose={noop} />,
    );
    assert.match(text(m), /No low-importance mail\. Back to Home Esc/);
    assert.doesNotMatch(m, /role="listbox"/);
  });
});

describe('CommitChip and CommitEdge', () => {
  test('solid chip with icon plus word; edge on the leaving side', () => {
    const cases = [
      ['done', 'Done', 'check', 'right'],
      ['later', 'Later', 'clock', 'left'],
      ['trash', 'Trash', 'trash', 'right'],
    ] as const;
    for (const [kind, word, icon, side] of cases) {
      const chip = render(<CommitChip kind={kind} />);
      assert.match(chip, new RegExp(`class="ui-commit-chip" data-kind="${kind}" aria-hidden="true"`));
      assert.match(chip, new RegExp(`data-icon="${icon}"`));
      assert.match(text(chip), new RegExp(`^${word}$`));
      assert.match(render(<CommitEdge kind={kind} />), new RegExp(`class="ui-commit-edge" data-kind="${kind}" data-side="${side}" aria-hidden="true"`));
    }
  });
});

describe('Chip', () => {
  test('due formats and provenance; overdue uses the tint with a clock', () => {
    assert.match(text(render(<Chip kind="due" due={TOMORROW} format="short" />)), /^Tomorrow$/);
    assert.match(text(render(<Chip kind="due" due={TOMORROW} format="sentence" />)), /^Due tomorrow$/);
    assert.match(text(render(<Chip kind="due" due={{ ...TOMORROW, at: '2026-10-29T17:00:00-07:00' }} format="withTime" />)), /^Today, 5:00 PM$/);
    assert.match(text(render(<Chip kind="due" due={{ ...TOMORROW, at: '2026-10-31T00:00:00-07:00' }} format="short" />)), /^Sat$/);
    assert.match(text(render(<Chip kind="due" due={{ ...TOMORROW, at: '2026-11-04T00:00:00-08:00' }} format="short" />)), /^Nov 4$/);
    const overdue = render(<Chip kind="due" due={DUE_TODAY} format="short" />);
    assert.match(overdue, /data-overdue="true"/);
    assert.match(overdue, /data-icon="clock"/);
    assert.match(render(<Chip kind="due" due={FOUND} format="sentence" />), /title="[^"]+ · from the email"/);
  });

  test('label with a tag colour, operator pill with a labelled remove button', () => {
    assert.match(render(<Chip kind="label" text="Receipts" color="sand" />), /data-color="sand" style="--swatch:var\(--tag-sand\)"/);
    const op = render(<Chip kind="operator" operator="from" value="jordan" onRemove={noop} />);
    assert.match(op, /data-kind="operator"/);
    assert.match(op, /aria-label="Remove from: jordan"/);
  });

  test('attachment ready, downloading and failed', () => {
    const ready = render(<Chip kind="attachment" name="direction-a.pdf" sizeBytes={4_200_000} state="ready" onOpen={noop} />);
    assert.match(text(ready), /^direction-a\.pdf 4\.2 MB$/);
    assert.match(ready, /title="Open direction-a.pdf"/);
    const busy = render(<Chip kind="attachment" name="b.pdf" sizeBytes={1} state="downloading" onOpen={noop} />);
    assert.match(busy, /aria-busy="true"/);
    assert.match(text(busy), /Downloading…/);
    const failed = render(<Chip kind="attachment" name={WORST.email} sizeBytes={0} state="failed" onOpen={noop} onRetry={noop} />);
    assert.match(failed, /data-state="failed"/);
    assert.match(text(failed), /Couldn’t download\. Try again$/);
  });
});

describe('EmptyLine', () => {
  test('one line, no icon; display block with detail and the Undo last · Z action', () => {
    const line = render(<EmptyLine text="No drafts." />);
    assert.match(line, /class="ui-empty-line" data-size="line" role="status"/);
    assert.equal(text(line), 'No drafts.');
    assert.doesNotMatch(line, /<svg/);
    const zero = render(
      <EmptyLine size="display" text="You handled 12 emails." detail="Next: Design review at 2:00 PM" action={{ label: 'Undo last', commandId: 'app.undo', emphasis: 'text', onSelect: noop }} />,
    );
    assert.match(zero, /data-size="display"/);
    assert.equal(text(zero), 'You handled 12 emails. Next: Design review at 2:00 PM Undo last Z');
    assert.doesNotMatch(zero, /data-variant="filled"/);
  });

  test('No accounts: filled Add an account with plus, then Try demo mail', () => {
    const m = render(
      <EmptyLine
        text="Add an account to bring in your mail."
        action={{ label: 'Add an account', icon: 'plus', emphasis: 'filled', onSelect: noop }}
        secondaryAction={{ label: 'Try demo mail', onSelect: noop }}
      />,
    );
    assert.match(m, /data-variant="filled"[^>]*><svg[^>]*data-icon="plus"/);
    assert.match(text(m), /Add an account Try demo mail$/);
    const search = render(<EmptyLine text="No mail matches 'dentist'." action={{ label: 'Search all mail on Google', keys: 'Return', emphasis: 'text', onSelect: noop }} />);
    assert.match(text(search), /Search all mail on Google Return$/);
  });
});

describe('ErrorLine', () => {
  const cases: [Parameters<typeof ErrorLine>[0], string][] = [
    [{ kind: 'writeRejected', op: 'move to Later', placement: 'row', onAction: noop }, 'Couldn’t move to Later. Retry'],
    [{ kind: 'sendFailed', recipient: 'Jordan', placement: 'column', onAction: noop, editCommandId: 'mail.done' }, 'Couldn’t send to Jordan. Your draft is saved. Try again Edit'],
    [{ kind: 'bodyFailed', placement: 'column', onAction: noop }, 'Couldn’t load this email. Try again'],
    [{ kind: 'askFailed', provider: 'Groq', placement: 'dock', onAction: noop }, 'Groq didn’t answer. Retry Use another provider'],
    [{ kind: 'consentNeeded', placement: 'settings', onAction: noop }, 'Background summaries are paused until you agree to the new provider. Review'],
    [
      { kind: 'keyRefused', provider: 'OpenRouter', keyPage: 'openrouter.ai/keys', placement: 'settings', onAction: noop },
      'OpenRouter refused the saved key, so nothing was sent. Copy a fresh one from openrouter.ai/keys. Your other providers are not affected. Replace key',
    ],
    [{ kind: 'sortFailed', provider: 'Groq', cause: 'keyRefused', placement: 'checklist', onAction: noop }, 'Couldn’t sort with Groq: the key was refused. Mail is ready; sorting will retry. Open Settings'],
    [{ kind: 'sortFailed', provider: 'Groq', cause: 'unreachable', placement: 'checklist', onAction: noop }, 'Couldn’t sort with Groq: Groq didn’t answer. Mail is ready; sorting will retry. Open Settings'],
    [{ kind: 'sortFailed', provider: 'Groq', cause: 'cap', placement: 'checklist', onAction: noop }, 'Couldn’t sort with Groq: today’s AI limit is reached. Mail is ready; sorting will retry. Open Settings'],
    [{ kind: 'reason', text: 'Fastmail refused the app password. Replace it in Settings → Accounts.', retryable: false, placement: 'checklist', onAction: noop }, 'Fastmail refused the app password. Replace it in Settings → Accounts.'],
  ];
  test('Edit shows its hint keycap only with "Show all key hints"; Retry is never a hidden duplicate', () => {
    const props = { kind: 'sendFailed', recipient: 'Jordan', placement: 'column', onAction: noop, editCommandId: 'mail.done' } as const;
    assert.doesNotMatch(render(<ErrorLine {...props} />), /data-reveal/);
    const all = render(
      <ListKeyHintsContext.Provider value={{ showKeys: 'all' }}>
        <ErrorLine {...props} />
      </ListKeyHintsContext.Provider>,
    );
    assert.match(all, /Edit<\/span><kbd class="ui-list-kbd" data-reveal="hint" aria-hidden="true">[^<]+<\/kbd>/);
  });

  for (const [props, copy] of cases) {
    test(`${props.kind} (${props.placement}) writes DESIGN's copy`, () => {
      const m = render(<ErrorLine {...props} />);
      assert.equal(text(m), copy);
      assert.match(m, /data-icon="alert"/);
      const live = props.placement === 'column' || props.placement === 'dock' || props.placement === 'settings';
      assert.equal(/role="alert"/.test(m), live);
    });
  }
});

test('no banned phrase, glyph or exclamation mark rendered anywhere in the list family', () => {
  assert.ok(collected.length > 40);
  for (const markup of collected) assert.deepEqual(bannedIn(markup), [], markup.slice(0, 160));
});
