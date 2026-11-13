// List family: low-importance band and sheet, commit chip and edge, chips, empty and error lines, with demo and worst-case data.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/list-parts.test.tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import type { LowSheetGroup } from '../props';
import { Chip, CommitChip, CommitEdge, EmptyLine, ErrorLine, LowBand, LowSheet } from './index';
import { forwardFocusToListbox } from './internal/Action';
import { ListKeyHintsContext } from './internal/keyHints';
import { lowBandNames } from './LowBand';
import { bannedIn, freezeClock, text, WORST } from './testkit.test';
import { noop, TOMORROW, DUE_TODAY, FOUND, row, collected, render } from './fixtures.test';

before(() => freezeClock());

describe('LowBand and LowSheet', () => {
  test('label, up to three names and "and N more", plain count right, no badge', () => {
    const m = render(
      <LowBand
        id="low"
        senders={['Field Notes', 'Cedar Market', 'Google', 'Rail Co', 'Bookshop', 'Bank']}
        count={6}
        cursor={false}
        density="comfortable"
        commandId="mail.open"
        onOpen={noop}
      />,
    );
    assert.match(m, /role="option" aria-selected="false" class="ui-low-band"/);
    assert.match(text(m), /^Low importance Field Notes, Cedar Market, Google and 3 more 6$/);
    assert.match(m, /title="Open low importance · ↩"/);
    assert.equal(lowBandNames(['A']), 'A');
    assert.equal(lowBandNames(['A', 'B']), 'A and B');
    assert.equal(lowBandNames(['A', 'B', 'C']), 'A, B and C');
    assert.equal(lowBandNames([]), '');
    assert.match(
      m,
      /<span class="ui-low-band__names" dir="auto">Field Notes, Cedar Market, Google<\/span><span class="ui-low-band__more"> and 3 more<\/span>/,
    );
    const long = render(
      <LowBand
        id="low"
        senders={[WORST.email, WORST.subject, 'X', ...Array(9999).fill('Y')]}
        count={9999}
        cursor={false}
        density="comfortable"
        commandId="mail.open"
        onOpen={noop}
      />,
    );
    assert.match(
      long,
      /<span class="ui-low-band__more"> and 9,999 more<\/span>/,
      'the count of hidden senders is its own span',
    );
    const big = render(
      <LowBand
        id="low"
        senders={[]}
        count={9999}
        cursor
        density="compact"
        commandId="mail.open"
        onOpen={noop}
      />,
    );
    assert.match(big, /data-cursor="true"/);
    assert.match(text(big), /^Low importance 9,999$/);
    const clickOnly = render(
      <LowBand
        id="low"
        senders={[]}
        count={0}
        cursor={false}
        density="comfortable"
        onOpen={noop}
      />,
    );
    assert.match(clickOnly, /title="Open low importance"/, 'no command, no key in the tooltip');
  });

  test('moreSenders adds senders the caller did not pass to "and N more"; default unchanged', () => {
    const band = (senders: string[], moreSenders?: number) =>
      render(
        <LowBand
          id="low"
          senders={senders}
          moreSenders={moreSenders}
          count={40}
          cursor={false}
          density="comfortable"
          commandId="mail.open"
          onOpen={noop}
        />,
      );
    assert.match(text(band(['A', 'B', 'C'], 12)), /^Low importance A, B, C and 12 more 40$/);
    assert.match(text(band(['A', 'B', 'C', 'D'], 12)), /^Low importance A, B, C and 13 more 40$/);
    assert.match(text(band(['A'], 5)), /^Low importance A and 5 more 40$/);
    assert.match(text(band(['A', 'B', 'C'], 0)), /^Low importance A, B and C 40$/);
    assert.match(text(band(['A', 'B', 'C', 'D'])), /^Low importance A, B, C and 1 more 40$/);
    assert.match(text(band([], 5)), /^Low importance 40$/);
  });

  const groups: LowSheetGroup[] = [
    {
      id: 'g-field',
      sender: 'Field Notes',
      rows: [
        row({
          id: 'r1',
          layout: 'list',
          sender: 'Field Notes',
          primary: 'Issue 41: a short guide to winter light',
        }),
      ],
      onUnsubscribe: noop,
    },
    {
      id: 'g-cedar',
      sender: 'Cedar Market',
      rows: [
        row({ id: 'r2', layout: 'list', sender: 'Cedar Market', primary: 'Your receipt' }),
        row({ id: 'r3', layout: 'list', sender: 'Cedar Market', primary: 'Weekly deals' }),
      ],
    },
  ];

  test('closed renders nothing; open is a labelled modal dialog grouped by sender', () => {
    const base = {
      binding: { id: 'low-list', label: 'Low importance' },
      groups,
      armed: false,
      markAllCommandId: 'lowImportance.markAllDone',
      onArm: noop,
      onCommitAll: noop,
      onClose: noop,
    };
    assert.equal(render(<LowSheet open={false} {...base} />), '');
    const m = render(
      <LowSheet
        open
        {...base}
        preview={{ rowId: 'r1', text: 'Winter light, in five short notes.' }}
      />,
    );
    assert.match(m, /role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    assert.match(m, /Low importance<\/h2><span class="ui-low-sheet__count">3</);
    assert.match(m, /role="listbox"/);
    assert.match(text(m), /Field Notes 1 Unsubscribe/);
    assert.match(text(m), /Press → twice to mark all 3 done/);
    assert.match(text(m), /Winter light, in five short notes\./);
    assert.match(
      m,
      /role="dialog" aria-modal="true" aria-labelledby="[^"]+" tabindex="-1"/,
      'focusable fallback for focus on open',
    );
    const armed = render(<LowSheet open {...base} armed />);
    assert.match(armed, /data-armed="true"/);
    assert.match(text(armed), /Press → again to mark all 3 done · Esc cancels/);
    assert.match(
      armed,
      /class="ui-low-sheet__foot" role="status"/,
      'without the shell announcer the foot is the live region',
    );
    const announced = render(<LowSheet open {...base} armed announce={noop} />);
    assert.doesNotMatch(
      announced,
      /class="ui-low-sheet__foot" role="status"/,
      'with the announcer arming is spoken once',
    );
    assert.match(
      announced,
      /<button[^>]*title="Unsubscribe"(?![^>]*tabindex)[^>]*>/,
      'Unsubscribe has no key, so it stays reachable',
    );
  });

  test('empty sheet: "No low-importance mail" with Back to Home', () => {
    const m = render(
      <LowSheet
        open
        binding={{ id: 'l', label: 'Low importance' }}
        groups={[]}
        armed={false}
        markAllCommandId="lowImportance.markAllDone"
        onArm={noop}
        onCommitAll={noop}
        onClose={noop}
      />,
    );
    assert.match(text(m), /No low-importance mail Back to Home Esc/);
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
      assert.match(
        chip,
        new RegExp(`class="ui-commit-chip" data-kind="${kind}" aria-hidden="true"`),
      );
      assert.match(chip, new RegExp(`data-icon="${icon}"`));
      assert.match(text(chip), new RegExp(`^${word}$`));
      assert.match(
        render(<CommitEdge kind={kind} />),
        new RegExp(
          `class="ui-commit-edge" data-kind="${kind}" data-side="${side}" aria-hidden="true"`,
        ),
      );
    }
  });
});

describe('Chip', () => {
  test('due formats and provenance; overdue uses the tint with a clock', () => {
    assert.match(text(render(<Chip kind="due" due={TOMORROW} format="short" />)), /^Tomorrow$/);
    assert.match(
      text(render(<Chip kind="due" due={TOMORROW} format="sentence" />)),
      /^Due tomorrow$/,
    );
    assert.match(
      text(
        render(
          <Chip
            kind="due"
            due={{ ...TOMORROW, at: '2026-10-29T17:00:00-07:00' }}
            format="withTime"
          />,
        ),
      ),
      /^Today, 5:00 PM$/,
    );
    assert.match(
      text(
        render(
          <Chip kind="due" due={{ ...TOMORROW, at: '2026-10-31T00:00:00-07:00' }} format="short" />,
        ),
      ),
      /^Sat$/,
    );
    assert.match(
      text(
        render(
          <Chip kind="due" due={{ ...TOMORROW, at: '2026-11-04T00:00:00-08:00' }} format="short" />,
        ),
      ),
      /^Nov 4$/,
    );
    const overdue = render(<Chip kind="due" due={DUE_TODAY} format="short" />);
    assert.match(overdue, /data-overdue="true"/);
    assert.match(overdue, /data-icon="clock"/);
    assert.match(
      render(<Chip kind="due" due={FOUND} format="sentence" />),
      /title="[^"]+ · from the email"/,
    );
  });

  test('label with a tag colour, operator pill with a labelled remove button', () => {
    assert.match(
      render(<Chip kind="label" text="Receipts" color="sand" />),
      /data-color="sand" style="--swatch:var\(--tag-sand\)"/,
    );
    const op = render(<Chip kind="operator" operator="from" value="jordan" onRemove={noop} />);
    assert.match(op, /data-kind="operator"/);
    assert.match(op, /aria-label="Remove from: jordan"/);
  });

  test('attachment ready, downloading and failed', () => {
    const ready = render(
      <Chip
        kind="attachment"
        name="direction-a.pdf"
        sizeBytes={4_200_000}
        state="ready"
        onOpen={noop}
      />,
    );
    assert.match(text(ready), /^direction-a\.pdf 4\.2 MB$/);
    assert.match(ready, /title="Open direction-a.pdf"/);
    const busy = render(
      <Chip kind="attachment" name="b.pdf" sizeBytes={1} state="downloading" onOpen={noop} />,
    );
    assert.match(busy, /aria-busy="true"/);
    assert.match(text(busy), /Downloading…/);
    const failed = render(
      <Chip
        kind="attachment"
        name={WORST.email}
        sizeBytes={0}
        state="failed"
        onOpen={noop}
        onRetry={noop}
      />,
    );
    assert.match(failed, /data-state="failed"/);
    assert.match(text(failed), /Couldn’t download\. Try again$/);
  });
});

describe('EmptyLine', () => {
  test('one line, no icon; display block with detail and the Undo last · Z action', () => {
    const line = render(<EmptyLine text="No drafts" />);
    assert.match(
      line,
      /class="ui-empty-line" data-size="line" data-placement="inline" role="status"/,
    );
    assert.equal(text(line), 'No drafts');
    assert.doesNotMatch(line, /<svg/);
    const zero = render(
      <EmptyLine
        placement="pane"
        size="display"
        text="You handled 12 emails"
        detail="Next: Design review at 2:00 PM"
        action={{ label: 'Undo last', commandId: 'app.undo', emphasis: 'text', onSelect: noop }}
      />,
    );
    assert.match(zero, /data-size="display" data-placement="pane"/);
    assert.equal(text(zero), 'You handled 12 emails Next: Design review at 2:00 PM Undo last Z');
    assert.doesNotMatch(zero, /data-variant="filled"/);
  });

  test('one muted mark above the line; the pane placement carries the centre hook', () => {
    const pane = render(<EmptyLine placement="pane" icon="trash" text="Trash is empty" />);
    assert.match(pane, /data-placement="pane"/);
    assert.match(
      pane,
      /ui-empty-line__copy"><svg[^>]*ui-list-icon" data-size="sm" data-icon="trash"[^>]*aria-hidden="true"/,
    );
    const css = readFileSync(new URL('./list.css', import.meta.url), 'utf8');
    assert.match(
      css,
      /\.aplos-screen:has\(> \.ui-empty-line\[data-placement='pane'\]\) \{[^}]*display: flex/s,
      'the slot becomes a column the pane line can fill',
    );
    assert.match(css, /\.ui-empty-line\[data-placement='pane'\][^}]*justify-content: safe center/s);
  });

  test('No accounts: filled Add an account with plus, then Try demo mail', () => {
    const m = render(
      <EmptyLine
        text="Add an account to bring in your mail"
        action={{ label: 'Add an account', icon: 'plus', emphasis: 'filled', onSelect: noop }}
        secondaryAction={{ label: 'Try demo mail', onSelect: noop }}
      />,
    );
    assert.match(m, /data-variant="filled"[^>]*><svg[^>]*data-icon="plus"/);
    assert.match(text(m), /Add an account Try demo mail$/);
    const search = render(
      <EmptyLine
        text="No mail matches 'dentist'"
        action={{
          label: 'Search all mail on Google',
          keys: 'Return',
          emphasis: 'text',
          onSelect: noop,
        }}
      />,
    );
    assert.match(text(search), /Search all mail on Google ↩$/);
  });
});

describe('ErrorLine', () => {
  const cases: [Parameters<typeof ErrorLine>[0], string][] = [
    [
      { kind: 'writeRejected', op: 'move to Later', placement: 'row', onAction: noop },
      'Couldn’t move to Later. Retry',
    ],
    [
      {
        kind: 'sendFailed',
        recipient: 'Jordan',
        placement: 'column',
        onAction: noop,
        editCommandId: 'mail.done',
      },
      'Couldn’t send to Jordan. Your draft is saved. Try again Edit',
    ],
    [
      { kind: 'bodyFailed', placement: 'column', onAction: noop },
      'Couldn’t load this email. Try again',
    ],
    [
      { kind: 'askFailed', provider: 'Groq', placement: 'dock', onAction: noop },
      'Groq didn’t answer. Retry Use another provider',
    ],
    [
      { kind: 'listFailed', placement: 'column', onAction: noop },
      'Couldn’t load this list. Try again',
    ],
    [
      { kind: 'consentNeeded', placement: 'settings', onAction: noop },
      'Background summaries are paused until you agree to the new provider. Review',
    ],
    [
      {
        kind: 'keyRefused',
        provider: 'OpenRouter',
        keyPage: 'openrouter.ai/keys',
        placement: 'settings',
        onAction: noop,
      },
      'OpenRouter refused the saved key, so nothing was sent. Copy a fresh one from openrouter.ai/keys. Your other providers are not affected. Replace key',
    ],
    [
      {
        kind: 'sortFailed',
        provider: 'Groq',
        cause: 'keyRefused',
        placement: 'checklist',
        onAction: noop,
      },
      'Couldn’t sort with Groq: the key was refused. Mail is ready; sorting will retry. Open Settings',
    ],
    [
      {
        kind: 'sortFailed',
        provider: 'Groq',
        cause: 'unreachable',
        placement: 'checklist',
        onAction: noop,
      },
      'Couldn’t sort with Groq: Groq didn’t answer. Mail is ready; sorting will retry. Open Settings',
    ],
    [
      {
        kind: 'sortFailed',
        provider: 'Groq',
        cause: 'cap',
        placement: 'checklist',
        onAction: noop,
      },
      'Couldn’t sort with Groq: today’s AI limit is reached. Mail is ready; sorting will retry. Open Settings',
    ],
    [
      {
        kind: 'reason',
        text: 'Fastmail refused the app password. Replace it in Settings → Accounts.',
        retryable: false,
        placement: 'checklist',
        onAction: noop,
      },
      'Fastmail refused the app password. Replace it in Settings → Accounts.',
    ],
  ];
  test('Edit shows its hint keycap only with "Show all key hints"; Retry is never a hidden duplicate', () => {
    const props = {
      kind: 'sendFailed',
      recipient: 'Jordan',
      placement: 'column',
      onAction: noop,
      editCommandId: 'mail.done',
    } as const;
    assert.doesNotMatch(render(<ErrorLine {...props} />), /data-reveal/);
    const all = render(
      <ListKeyHintsContext.Provider value={{ showKeys: 'all' }}>
        <ErrorLine {...props} />
      </ListKeyHintsContext.Provider>,
    );
    assert.match(
      all,
      /Edit<\/span><kbd class="ui-list-kbd" data-reveal="hint" aria-hidden="true">[^<]+<\/kbd>/,
    );
  });

  test('consentNeeded: Review is a text button, and filled only when the screen passes it as its one main action', () => {
    const props = { kind: 'consentNeeded', placement: 'settings', onAction: noop } as const;
    const plain = render(<ErrorLine {...props} />);
    assert.match(plain, /<button[^>]*data-variant="text"[^>]*>(?:(?!<\/button>).)*Review/);
    assert.doesNotMatch(plain, /data-variant="filled"/);
    const main = render(<ErrorLine {...props} mainAction />);
    assert.match(main, /<button[^>]*data-variant="filled"[^>]*>(?:(?!<\/button>).)*Review/);
    assert.doesNotMatch(main, /data-variant="text"/);
    assert.equal(text(main), text(plain));
  });

  test('mainAction changes nothing for the other kinds, whose actions are text buttons', () => {
    const lone = render(
      <ErrorLine kind="bodyFailed" placement="column" onAction={noop} mainAction />,
    );
    assert.match(lone, /data-variant="text"/);
    assert.doesNotMatch(lone, /data-variant="filled"/);
  });

  for (const [props, copy] of cases) {
    test(`${props.kind} (${props.placement}) writes DESIGN's copy`, () => {
      const m = render(<ErrorLine {...props} />);
      assert.equal(text(m), copy);
      assert.match(m, /data-icon="alert"/);
      const live =
        props.placement === 'column' ||
        props.placement === 'dock' ||
        props.placement === 'settings';
      assert.equal(/role="alert"/.test(m), live);
    });
  }
});

describe('duplicate action focus', () => {
  // No DOM in this suite: a stub node whose parent answers closest() by selector.
  const stub = (listbox: unknown, focusable: unknown) => {
    const parent = {
      closest: (selector: string) => (selector.includes('listbox') ? listbox : focusable),
    };
    return { parentElement: parent, focus: undefined } as unknown as HTMLElement;
  };
  const target = () => {
    const calls: unknown[] = [];
    return { calls, focus: (options?: unknown) => calls.push(options) };
  };

  test('focus goes to the listbox it sits in', () => {
    const box = target();
    const other = target();
    const span = stub(box, other);
    forwardFocusToListbox(span);
    span.focus({ preventScroll: true });
    assert.deepEqual(box.calls, [{ preventScroll: true }]);
    assert.deepEqual(other.calls, []);
  });

  test('outside a listbox, focus goes to the nearest focusable ancestor, not body', () => {
    const near = target();
    const span = stub(null, near);
    forwardFocusToListbox(span);
    span.focus();
    assert.deepEqual(near.calls, [undefined]);
  });

  test('with nothing to focus it does nothing, and a null ref is ignored', () => {
    const span = stub(null, null);
    forwardFocusToListbox(span);
    assert.doesNotThrow(() => span.focus());
    assert.doesNotThrow(() => forwardFocusToListbox(null));
  });
});

test('no banned phrase, glyph or exclamation mark rendered anywhere in the list parts', () => {
  assert.ok(collected.length > 40);
  for (const markup of collected) assert.deepEqual(bannedIn(markup), [], markup.slice(0, 160));
});
