// List family: rows, listbox, groups, section headers and the focus letter, with demo and worst-case data.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/list.test.tsx

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { FocusLetter, FocusSlot, ListBox, ListGroup, ListRow, SectionHeader } from './index';
import { ListKeyHintsContext } from './internal/keyHints';
import { bannedIn, freezeClock, text, WORST } from './testkit.test';
import { noop, TOMORROW, DUE_TODAY, row, letter, collected, render } from './fixtures.test';

before(() => freezeClock());

describe('ListRow', () => {
  test('read row: option, no dot fill, dim line, date column, hover actions as pointer duplicates', () => {
    const m = render(<ListRow {...row()} />);
    assert.match(
      m,
      /^<div id="row-leah" role="option" aria-selected="false" class="ui-list-row" data-layout="home" data-density="comfortable"/,
    );
    assert.doesNotMatch(m, /data-unread/);
    assert.match(m, /Tuesday<\/time>/);
    assert.match(m, /class="ui-list-row__actions"/);
    assert.match(m, /aria-label="Later" title="Later · ←" aria-hidden="true"/);
    assert.match(m, /aria-label="Done" title="Done · →" aria-hidden="true"/);
    assert.doesNotMatch(m, /ui-list-row__account|ui-list-row__dot/, 'no dots on a row');
  });

  test('unread, cursor, due chip: no unread dot and no account dot, "Unread" stays for screen readers', () => {
    const m = render(
      <ListRow
        {...row({
          unread: true,
          cursor: true,
          due: TOMORROW,
          account: { label: 'alex@fernworks.studio' },
        })}
      />,
    );
    assert.match(m, /aria-selected="true"/);
    assert.match(m, /data-unread="true" data-cursor="true"/);
    assert.match(m, /Unread\./);
    assert.match(m, /data-kind="due"[^>]*>.*Due tomorrow/);
    assert.match(m, /data-icon="calendar"/, 'a due date wears the calendar, never the Later clock');
    assert.doesNotMatch(m, /ui-list-row__account|ui-list-row__dot|--swatch/, 'no dots on a row');
    assert.match(m, /title="alex@fernworks.studio"/, 'account always in the row tooltip');
  });

  test('bulk picking: pick box shows only while picking and aria-selected follows the pick', () => {
    const m = render(
      <ListRow {...row({ layout: 'list', picking: true, picked: true, cursor: false })} />,
    );
    assert.match(m, /aria-selected="true"/);
    assert.match(m, /data-picked="true" data-picking="true"/);
    assert.match(m, /ui-list-row__pick/);
    assert.doesNotMatch(m, /ui-list-row__dot/);
  });

  test('a tag is a quiet word before the line, so a draft never reads as sent mail', () => {
    const m = render(<ListRow {...row({ layout: 'list', tag: 'Draft' })} />);
    assert.match(m, /<span class="ui-list-row__tag">Draft<\/span>/);
    assert.doesNotMatch(render(<ListRow {...row({ layout: 'list' })} />), /ui-list-row__tag/);
  });

  test('done layout: fixed stamp column, "Move to Home" is the only action', () => {
    const m = render(
      <ListRow
        {...row({
          layout: 'done',
          doneAt: '2026-10-29T09:41:00-07:00',
          hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }],
        })}
      />,
    );
    assert.match(m, /data-layout="done"/);
    assert.match(
      m,
      /class="ui-list-row__stamp"[^>]*>.*aria-label="Done".*>9:41 AM<\/time><\/span>/,
    );
    assert.match(m, /aria-label="Move to Home" title="Move to Home · H"/);
    const older = render(
      <ListRow {...row({ layout: 'done', doneAt: '2026-10-28T08:52:00-07:00' })} />,
    );
    assert.match(older, />Yesterday<\/time>/);
    assert.doesNotMatch(older, /Done Yesterday/, 'the word is not repeated before the date');
  });

  test('done layout: only a reported finish time says "Done" in the tooltip', () => {
    const reported = render(
      <ListRow {...row({ layout: 'done', doneAt: '2026-10-28T08:52:00-07:00' })} />,
    );
    assert.match(reported, /class="ui-list-row__stamp" title="Done Wednesday/);
    const estimated = render(
      <ListRow
        {...row({ layout: 'done', doneAt: '2026-10-28T08:52:00-07:00', doneEstimated: true })}
      />,
    );
    assert.match(estimated, /class="ui-list-row__stamp" title="Wednesday/);
  });

  test('later layout: the laterUntil chip takes the date column', () => {
    const m = render(
      <ListRow
        {...row({
          layout: 'later',
          laterUntil: { kind: 'at', at: '2026-10-27T00:00:00-07:00', overdue: true },
        })}
      />,
    );
    assert.match(m, /data-kind="laterUntil" data-overdue="true"/);
    assert.match(m, /Back Tue, Oct 27/);
    assert.doesNotMatch(m, /ui-list-row__date/);
    const someday = render(
      <ListRow {...row({ layout: 'later', laterUntil: { kind: 'someday' } })} />,
    );
    assert.match(someday, /Back someday/);
  });

  test('later layout: a return on the deadline day is not said twice', () => {
    const same = render(
      <ListRow
        {...row({
          layout: 'later',
          due: { at: '2026-10-29T23:59:00-07:00', overdue: false, source: 'user' },
          laterUntil: { kind: 'at', at: '2026-10-29T23:59:00-07:00', overdue: false },
        })}
      />,
    );
    assert.match(same, /data-kind="due"/);
    assert.doesNotMatch(same, /data-kind="laterUntil"/);
    const other = render(
      <ListRow
        {...row({
          layout: 'later',
          due: { at: '2026-10-29T23:59:00-07:00', overdue: false, source: 'user' },
          laterUntil: { kind: 'at', at: '2026-10-31T09:00:00-07:00', overdue: false },
        })}
      />,
    );
    assert.match(other, /data-kind="laterUntil"/);
    assert.match(
      text(other),
      /Back (Oct 31|Sat, Oct 31|\w+, Oct 31)/,
      'beside a due chip it says Back',
    );
    const alone = render(
      <ListRow
        {...row({
          layout: 'later',
          laterUntil: { kind: 'at', at: '2026-10-31T09:00:00-07:00', overdue: false },
        })}
      />,
    );
    assert.match(
      text(alone),
      /Back /,
      'a return time always says Back, with or without a due chip',
    );
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
    assert.match(m, /<span[^>]*aria-label="Later"[^>]*aria-hidden="true"/);
  });

  test('dates: weekday names only earlier this week, month-day before that', () => {
    const monday = render(<ListRow {...row({ date: '2026-10-26T09:00:00-07:00' })} />);
    assert.match(monday, />Monday<\/time>/);
    const lastFriday = render(<ListRow {...row({ date: '2026-10-23T09:00:00-07:00' })} />);
    assert.match(lastFriday, />Oct 23<\/time>/);
  });

  test('hover actions sit inside the meta cell so they cover the whole date column', () => {
    const m = render(<ListRow {...row()} />);
    assert.match(
      m,
      /<span class="ui-list-row__meta">.*<time[^>]*>Tuesday<\/time><span class="ui-list-row__actions">/,
    );
  });

  test('mail-derived text follows its own direction (dir="auto")', () => {
    const m = render(
      <ListRow
        {...row({
          sender: WORST.arabic,
          primary: WORST.arabic,
          secondary: WORST.cjk,
          layout: 'list',
        })}
      />,
    );
    assert.match(m, /class="ui-list-row__sender" dir="auto" title="[^"]+"/);
    assert.match(m, /class="ui-list-row__primary" dir="auto"/);
    assert.match(m, /class="ui-list-row__secondary" dir="auto"/);
    assert.match(
      m,
      /ui-list-row__primary[^>]*>[^<]*<\/span><span class="ui-list-row__sep" aria-hidden="true">·<\/span><span class="ui-list-row__secondary"/,
      'a dot (hidden from screen readers) sits between the subject and the summary',
    );
  });

  test('search: secondary snippet and bold terms, marks with screen-reader words', () => {
    const m = render(
      <ListRow
        {...row({
          layout: 'list',
          primary: 'Dentist appointment',
          secondary: 'Your dentist cleaning is Thursday',
          highlight: ['dentist'],
          marks: { replied: true, bookmarked: true, attachment: true },
        })}
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
          header={{
            id: 'sec-do',
            label: 'Do now',
            variant: 'section',
            count: 6,
            action: { label: 'Go one by one', commandId: 'home.oneByOne', onSelect: noop },
          }}
        >
          <ListRow {...row()} />
        </ListGroup>
      </ListBox>,
    );
    assert.match(
      m,
      /^<div id="home" class="ui-list-box" role="listbox" tabindex="0" aria-label="Home" aria-activedescendant="focus-jordan">/,
    );
    assert.match(m, /role="group" aria-labelledby="sec-do"/);
    assert.match(
      m,
      /<div role="presentation" id="sec-do" class="ui-section-header" data-variant="section"/,
    );
    assert.match(
      m,
      /ui-section-header__label">Do now<\/span><span class="ui-section-header__count">6<\/span>/,
    );
    assert.match(
      m,
      /title="Go one by one · S" aria-hidden="true"/,
      'a pointer duplicate of S inside the listbox (a span: not focusable and out of the accessibility tree, so the group owns only options)',
    );
    assert.doesNotMatch(
      m,
      /<button[^>]*Go one by one/,
      'no button inside the listbox: axe aria-required-children (#534 had made it one)',
    );
    assert.doesNotMatch(m, /<h1|<h2|page-title/, 'no page title, no heading inside the listbox');
  });

  test('multiselectable listbox when picking', () => {
    const m = render(
      <ListBox binding={{ id: 'all', label: 'All mail' }} multiselectable>
        {null}
      </ListBox>,
    );
    assert.match(m, /aria-multiselectable="true"/);
    assert.doesNotMatch(m, /aria-activedescendant/);
  });

  test('an empty section does not render unless held, then it shows 0', () => {
    assert.equal(
      render(
        <ListGroup header={{ id: 'u', label: 'Important updates', variant: 'section', count: 0 }}>
          {null}
        </ListGroup>,
      ),
      '',
    );
    const held = render(
      <ListGroup
        header={{ id: 'u', label: 'Important updates', variant: 'section', count: 0, held: true }}
      >
        {null}
      </ListGroup>,
    );
    assert.match(held, /data-held="true"/);
    assert.match(held, /ui-section-header__count">0</);
  });

  test('outside a listbox the label is a heading; overdue adds a clock; sub-label, 2 new, drop target', () => {
    const settings = render(<SectionHeader id="acc" label="Accounts" variant="section" />);
    assert.match(settings, /^<h2 id="acc" class="ui-section-header"/);
    const overdue = render(
      <SectionHeader id="ov" label="Overdue" variant="section" tone="overdue" count={9999} />,
    );
    assert.match(overdue, /data-tone="overdue"/);
    assert.match(overdue, /data-icon="clock"/);
    assert.match(overdue, /9,999/);
    const sub = render(
      <SectionHeader
        id="bfl"
        label="Back from Later"
        variant="sub"
        count={2}
        waitingNew={2}
        action={{ label: 'Clear from Home', onSelect: noop }}
      />,
    );
    assert.match(sub, /data-variant="sub"/);
    assert.match(text(sub), /Back from Later 2 2 new Clear from Home/);
    const drop = render(
      <SectionHeader
        id="wk"
        label="This week"
        variant="section"
        dropTarget={{ label: 'Tomorrow, 8:00 AM', state: 'over' }}
      />,
    );
    assert.match(drop, /data-drop="over"/);
    assert.match(text(drop), /Move to Tomorrow, 8:00 AM/);
  });
});

describe('FocusSlot and FocusLetter', () => {
  test('slot height follows density', () => {
    for (const density of ['roomy', 'comfortable', 'compact'] as const) {
      assert.match(
        render(<FocusSlot density={density}>{null}</FocusSlot>),
        new RegExp(`class="ui-focus-slot" data-density="${density}" role="presentation"`),
      );
    }
  });

  test('the card keeps the bookmark and paperclip marks before the date', () => {
    const m = render(<FocusLetter {...letter()} marks={{ bookmarked: true, attachment: true }} />);
    assert.match(
      m,
      /ui-focus-letter__marks[\s\S]*title="Bookmarked"[\s\S]*title="Has attachments"[\s\S]*<time class="ui-focus-letter__date"/,
    );
    assert.doesNotMatch(render(<FocusLetter {...letter()} />), /ui-focus-letter__marks/);
  });

  test('meta line, serif summary clamped to two lines, filled suggestion with Space, Later, Done, More', () => {
    const m = render(<FocusLetter {...letter()} />);
    assert.match(
      m,
      /^<div id="focus-jordan" role="option" aria-selected="true" class="ui-focus-letter"/,
    );
    assert.match(
      m,
      /ui-focus-letter__sender" dir="auto" title="Jordan Park">Jordan Park</,
      'a name cut short in the card can still be read in full',
    );
    assert.match(m, /data-kind="due"[^>]*>.*Due tomorrow/);
    assert.match(
      m,
      /ui-focus-letter__sender" dir="auto" title="Jordan Park">Jordan Park<\/span><span class="ui-chip" data-kind="due"[\s\S]*Due tomorrow[\s\S]*<time class="ui-focus-letter__date"/,
      'the chip sits on the sender line, right after the name',
    );
    assert.doesNotMatch(m, /ui-summary__lead/, 'nothing leads the summary on the card');
    assert.match(m, /10:00 AM<\/time>/);
    assert.match(
      m,
      /class="ui-summary" dir="auto" data-state="ready" data-clamp="two-lines" title="Summary by Groq"/,
    );
    assert.match(
      m,
      /data-variant="filled" data-size="md" title="Reply · Space" aria-hidden="true">.*Reply<\/span><kbd class="ui-list-kbd">Space<\/kbd>/,
    );
    assert.match(m, /title="Later · ←"/);
    assert.match(m, /title="Done · →"/);
    assert.match(m, /aria-label="More" title="More: bookmark, trash, why it’s here · \."/);
    assert.equal((m.match(/data-variant="filled"/g) ?? []).length, 1, 'one filled button');
    assert.doesNotMatch(m, /data-icon="bookmark"/, 'no bookmark icon on the card');
  });

  test('Done is omitted when the suggestion is Done', () => {
    const m = render(
      <FocusLetter {...letter({ suggestion: { verb: 'Done', icon: 'check', isDone: true } })} />,
    );
    assert.equal((m.match(/>Done</g) ?? []).length, 1);
  });

  test('picked: the card carries data-picked for the accent wash', () => {
    assert.match(render(<FocusLetter {...letter({ picked: true })} />), /data-picked="true"/);
    assert.doesNotMatch(render(<FocusLetter {...letter()} />), /data-picked/);
  });

  test('demoted: the suggestion becomes a text button and the card keeps its keys’ room (the sheet hides them)', () => {
    const m = render(<FocusLetter {...letter({ demoted: true })} />);
    assert.match(m, /data-demoted="true"/);
    assert.doesNotMatch(m, /data-variant="filled"/);
    assert.match(m, />Space<\/kbd>/, 'the cap stays in the markup so nothing slides; CSS hides it');
  });

  test('pending shows the placeholder, absent the subject alone; narrow drops labels but keeps the verb', () => {
    const pending = render(
      <FocusLetter
        {...letter({ summary: { state: 'pending', subject: 'A quieter home' }, narrow: true })}
      />,
    );
    assert.match(pending, /class="ui-summary-placeholder"/);
    assert.match(pending, /class="ui-focus-letter"[^>]*aria-busy="true"/);
    assert.match(pending, /Summarizing…/);
    assert.doesNotMatch(pending, /ui-summary"/, 'no subject line in the space while pending');
    assert.match(pending, /data-narrow="true"/);
    assert.match(pending, /data-label-hidden="true" aria-label="Later"/);
    assert.match(pending, />Reply<\/span>/);
    const absent = render(
      <FocusLetter {...letter({ summary: { state: 'absent', subject: WORST.subject } })} />,
    );
    assert.match(absent, /data-state="absent"/);
    assert.doesNotMatch(absent, /Summary by|ui-summary-placeholder|Summarizing/);
  });

  test('key hints: ⌘ held shows a badge on More; Later and Done show their caps always', () => {
    const plain = render(<FocusLetter {...letter()} />);
    assert.doesNotMatch(plain, /data-reveal/);
    const held = render(
      <ListKeyHintsContext.Provider value={{ showKeys: 'held' }}>
        <FocusLetter {...letter()} />
      </ListKeyHintsContext.Provider>,
    );
    const badges = [
      ...held.matchAll(
        /<kbd class="ui-list-kbd" data-reveal="badge" aria-hidden="true">([^<]+)<\/kbd>/g,
      ),
    ].map(x => x[1]);
    assert.deepEqual(badges, ['.'], held);
    assert.match(held, /class="ui-focus-letter__sender" dir="auto" title="/);
  });

  test('rejected write shows on the card; worst-case sender and verb', () => {
    const m = render(
      <FocusLetter
        {...letter({
          sender: WORST.email,
          due: DUE_TODAY,
          rejected: { op: 'mark Done', onRetry: noop },
          suggestion: { verb: WORST.emoji, icon: 'calendar', isDone: false },
        })}
      />,
    );
    assert.match(m, /data-state="rejected"/);
    assert.match(text(m), /Couldn’t mark Done\. Retry/);
    assert.match(m, /data-overdue="true"/);
    assert.match(text(m), /Due today/);
    assert.ok(text(m).includes(WORST.email));
  });
});

test('no banned phrase, glyph or exclamation mark rendered anywhere in the list rows and focus letter', () => {
  assert.ok(collected.length > 35);
  for (const markup of collected) assert.deepEqual(bannedIn(markup), [], markup.slice(0, 160));
});
