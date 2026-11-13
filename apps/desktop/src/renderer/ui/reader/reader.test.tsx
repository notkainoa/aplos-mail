// Reader family: structure, copy, aria and data-state for each component, with demo and worst-case data.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/reader/reader.test.tsx

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { ReaderActionsProps, ReaderHeadProps, UndoTrayProps } from '../props';
import { bannedIn, freezeClock, html, text, WORST } from '../list/testkit.test';
import {
  LoadingLine,
  ReaderActions,
  ReaderHead,
  ReplyStub,
  Summary,
  ThreadMessage,
  UndoTray,
  Why,
} from './index';

const noop = () => {};
const collected: string[] = [];
function render(element: Parameters<typeof html>[0]): string {
  const markup = html(element);
  collected.push(markup);
  return markup;
}

function head(over: Partial<ReaderHeadProps> = {}): ReaderHeadProps {
  return {
    due: { at: '2026-10-30T00:00:00-07:00', overdue: false, source: 'ai' },
    summary: {
      state: 'ready',
      text: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.',
      subject: 'A quieter home for the Hollow Creek site',
      provenance: { provider: 'Groq', local: false },
    },
    ...over,
  };
}

function actions(over: Partial<ReaderActionsProps> = {}): ReaderActionsProps {
  return {
    suggestion: { verb: 'Reply', icon: 'reply', isDone: false },
    commands: { suggest: 'mail.suggested', later: 'mail.later', done: 'mail.done' },
    demoted: false,
    onSuggestion: noop,
    onLater: noop,
    onDone: noop,
    ...over,
  };
}

function tray(over: Partial<UndoTrayProps> = {}): UndoTrayProps {
  return {
    state: { kind: 'sending', recipients: 'Jordan', secondsLeft: 8, totalSeconds: 8 },
    reducedMotion: false,
    placement: 'thread',
    undoCommandId: 'app.undo',
    onAction: noop,
    ...over,
  };
}

before(() => freezeClock());

describe('Summary', () => {
  test('ready is the serif line with provenance on hover; local models say "on this Mac"', () => {
    const m = render(
      <Summary
        state="ready"
        text="Priya needs the revised deck today."
        subject="Re: Q4 review deck"
        provenance={{ provider: 'Groq', local: false }}
      />,
    );
    assert.match(
      m,
      /^<p class="ui-summary" dir="auto" data-state="ready" data-clamp="none" title="Summary by Groq">Priya needs the revised deck today\./,
    );
    const local = render(
      <Summary
        state="ready"
        text="T"
        subject="S"
        provenance={{ provider: 'Ollama', local: true }}
        clamp="two-lines"
        id="sum"
      />,
    );
    assert.match(
      local,
      /id="sum" class="ui-summary" dir="auto" data-state="ready" data-clamp="two-lines" title="Summary by Ollama on this Mac"/,
    );
  });

  test('pending breathes the subject in SF; absent shows the subject and nothing else', () => {
    const pending = render(
      <Summary state="pending" subject="A quieter home for the Hollow Creek site" />,
    );
    assert.match(
      pending,
      /data-state="pending" data-clamp="none" aria-busy="true">A quieter home for the Hollow Creek site<\/p>$/,
    );
    const absent = render(<Summary state="absent" subject={WORST.subject} />);
    assert.match(absent, /data-state="absent"/);
    assert.doesNotMatch(absent, /title=|aria-busy|Summary by/);
    assert.equal(text(absent), WORST.subject);
  });
});

describe('ReaderHead', () => {
  test('the summary landmark and a hairline; no sender line, no time, no buttons', () => {
    const m = render(<ReaderHead {...head()} />);
    assert.match(m, /data-kind="due" data-source="ai" title="[^"]+ · from the email"/);
    assert.match(text(m), /Due tomorrow$/);
    assert.match(
      m,
      /<section class="ui-reader-head__summary" aria-label="Summary"><p class="ui-summary" dir="auto" data-state="ready" data-clamp="none"/,
    );
    assert.match(m, /<hr class="ui-reader-head__rule"\/?>/, 'a hairline under the summary');
    assert.doesNotMatch(m, /ui-reader-head__(from|name|to|when|actions)/, 'no sender line');
    assert.doesNotMatch(m, /<button|<time|<kbd/);
  });

  test('pending and absent summaries keep the subject in SF, without a due chip', () => {
    const pending = render(
      <ReaderHead
        {...head({ summary: { state: 'pending', subject: 'A quieter home' }, due: undefined })}
      />,
    );
    assert.match(pending, /data-state="pending"/);
    assert.doesNotMatch(pending, /data-kind="due"/);
  });
});

describe('ReaderActions', () => {
  test('one pinned bar: filled Reply with Space, then Later and Done; no monogram', () => {
    const m = render(<ReaderActions {...actions()} />);
    assert.equal((m.match(/class="ui-reader-actions"/g) ?? []).length, 1);
    assert.match(m, /role="group" aria-label="Actions"/);
    assert.match(
      m,
      /data-variant="filled" data-size="md" title="Reply · Space\. Hold R to dictate a reply">.*Reply<\/span><kbd class="ui-list-kbd">Space<\/kbd>/,
    );
    assert.match(m, /title="Later · ←"/);
    assert.match(m, /title="Done · →"/);
    assert.doesNotMatch(m, /tabindex="-1"/, 'the reader is not a listbox: buttons are focusable');
    assert.doesNotMatch(m, /data-icon="more"/, '⋯ lives in the pane header');
  });

  test('Add to calendar suggestion; Done omitted when the suggestion is Done; demoted while replying', () => {
    const cal = render(
      <ReaderActions
        {...actions({ suggestion: { verb: 'Add to calendar', icon: 'calendar', isDone: false } })}
      />,
    );
    assert.match(cal, /data-icon="calendar"/);
    assert.doesNotMatch(
      cal,
      /Hold R to dictate/,
      'only a reply suggestion carries the dictation hint',
    );
    const done = render(
      <ReaderActions {...actions({ suggestion: { verb: 'Done', icon: 'check', isDone: true } })} />,
    );
    assert.equal((text(done).match(/Done/g) ?? []).length, 1);
    const demoted = render(<ReaderActions {...actions({ demoted: true })} />);
    assert.doesNotMatch(demoted, /data-variant="filled"|<kbd/);
    assert.match(demoted, /data-demoted="true"/, 'the bar rests in the flow under the open reply');
    assert.match(text(demoted), /Replying/, 'the reply button says so while the reply is open');
    assert.match(demoted, /aria-pressed="true"/);
    const calDemoted = render(
      <ReaderActions
        {...actions({
          demoted: true,
          suggestion: { verb: 'Add to calendar', icon: 'calendar', isDone: false },
        })}
      />,
    );
    assert.doesNotMatch(text(calDemoted), /Replying/, 'only a reply suggestion becomes Replying');
  });
});

describe('ThreadMessage', () => {
  test('article landmark with header, read body, attachments and the cursor rail', () => {
    const m = render(
      <ThreadMessage
        id="msg-4"
        from="Jordan Park"
        toLabel="to you, Mina Cho"
        date="2026-10-29T09:40:00-07:00"
        cursor
        body={<p>Both directions are ready.</p>}
        attachments={[
          {
            kind: 'attachment',
            name: 'direction-a.pdf',
            sizeBytes: 4_200_000,
            state: 'ready',
            onOpen: noop,
          },
          {
            kind: 'attachment',
            name: 'direction-b.pdf',
            sizeBytes: 3_100_000,
            state: 'failed',
            onOpen: noop,
            onRetry: noop,
          },
        ]}
        remoteImages={{ blocked: true, onLoad: noop }}
        quoted={{ shown: false, onToggle: noop, commandId: 'reader.expand' }}
      />,
    );
    assert.match(
      m,
      /^<article id="msg-4" class="ui-thread-message" data-cursor="true" aria-labelledby="msg-4-from">/,
    );
    assert.match(
      text(m),
      /^Jordan Park to you, Mina Cho Today, 9:40 AM Load images from this sender Both directions are ready\. Show quoted text/,
    );
    assert.match(m, /aria-expanded="false"/);
    assert.match(m, /role="list" aria-label="Attachments"/);
    assert.match(
      text(m),
      /direction-a\.pdf 4\.2 MB direction-b\.pdf Couldn’t download\. Try again/,
    );
  });

  test('a folded card with the sender mark reads like the open one: mark, name, when, then who it went to', () => {
    const fold = { open: false, onToggle: noop, commandId: 'reader.expand' } as const;
    const html = render(
      <ThreadMessage
        id="e2"
        from="Jordan Park"
        toLabel="to you"
        leading={<span className="mark">J</span>}
        date="2026-10-20T09:00:00-07:00"
        cursor={false}
        fold={fold}
        excerpt="Kicking off."
      />,
    );
    const at = (needle: string) => html.indexOf(needle);
    assert.ok(at('ui-thread-message__from') < at('ui-thread-message__when'), 'name, then time');
    assert.ok(at('ui-thread-message__when') < at('ui-thread-message__to'), 'time, then to');
  });

  test('an earlier message is a compact card: its own first words, a visible Show full button, aria-expanded, no body', () => {
    const fold = { open: false, onToggle: noop, commandId: 'reader.expand' } as const;
    const folded = render(
      <ThreadMessage
        id="e1"
        from="Jordan Park"
        toLabel="to you"
        date="2026-10-20T09:00:00-07:00"
        cursor={false}
        fold={fold}
        excerpt="Kicking off: here is the brief we agreed on Friday…"
      />,
    );
    assert.match(folded, /data-fold="folded"/);
    assert.match(
      folded,
      /<button type="button" class="ui-thread-message__toggle" aria-expanded="false"[^>]*aria-label="Show full, message from Jordan Park"[^>]*aria-describedby="e1-excerpt"/,
    );
    assert.match(folded, />Show full<\/span>/, 'the visible hint');
    assert.doesNotMatch(
      folded,
      /aria-controls/,
      'nothing to control while folded: the body is not mounted',
    );
    assert.match(
      text(folded),
      /^Jordan Park to you .* Kicking off: here is the brief we agreed on Friday… Show full$/,
    );
    assert.match(folded, /id="e1-excerpt"/, 'the button is described by the excerpt');
    assert.doesNotMatch(folded, /ui-thread-message__body/, 'a folded card loads and draws no body');
    const open = render(
      <ThreadMessage
        id="e1"
        from="Jordan Park"
        toLabel="to you"
        date="2026-10-20T09:00:00-07:00"
        cursor={false}
        fold={{ ...fold, open: true }}
        excerpt="never shown while open…"
        body={<p>The whole brief.</p>}
      />,
    );
    assert.match(open, /data-fold="open"/);
    assert.match(open, /aria-expanded="true"/);
    assert.match(open, /aria-label="Show less, message from Jordan Park"/);
    assert.match(open, /aria-controls="e1-content"/);
    assert.match(open, />Show less<\/span>/, 'the same place reads Show less once open');
    assert.doesNotMatch(open, /aria-describedby/, 'no excerpt to describe it while open');
    assert.doesNotMatch(text(open), /never shown/);
    assert.match(text(open), /The whole brief\./);
  });

  test('a card with no text says "No preview" in dim text; a card never promises O for quoted text', () => {
    const fold = { open: false, onToggle: noop, commandId: 'reader.expand' } as const;
    const empty = render(
      <ThreadMessage
        id="e2"
        from="Jordan Park"
        toLabel="to you"
        date="2026-10-20T09:00:00-07:00"
        cursor={false}
        fold={fold}
        excerpt=""
      />,
    );
    assert.match(empty, /ui-thread-message__excerpt" dir="auto" data-empty="true">No preview</);
    assert.doesNotMatch(empty, /!|…/);
    const open = render(
      <ThreadMessage
        id="e3"
        from="Jordan Park"
        toLabel="to you"
        date="2026-10-20T09:00:00-07:00"
        cursor={false}
        fold={{ ...fold, open: true }}
        body={<p>The brief.</p>}
        quoted={{ shown: false, onToggle: noop }}
      />,
    );
    assert.match(open, /title="Fold this message · O"/, 'O folds the card');
    assert.match(open, /title="Show quoted text"/, "the card's quoted button names no key");
    const latest = render(
      <ThreadMessage
        id="e4"
        from="Jordan Park"
        toLabel="to you"
        date="2026-10-20T09:00:00-07:00"
        cursor
        body={<p>The latest.</p>}
        quoted={{ shown: false, onToggle: noop, commandId: 'reader.expand' }}
      />,
    );
    assert.match(
      latest,
      /title="Show quoted text · O"/,
      'on the latest message O does show quoted text',
    );
  });

  test('the toggle is the same button, last in the head at the same place, folded or open (focus survives a fold)', () => {
    const fold = { open: false, onToggle: noop, commandId: 'reader.expand' } as const;
    const card = (open: boolean) =>
      render(
        <ThreadMessage
          id="e5"
          from="Jordan Park"
          toLabel="to you"
          leading={<span className="mark" />}
          recipients={open ? <span className="to" /> : undefined}
          date="2026-10-20T09:00:00-07:00"
          cursor={false}
          fold={{ ...fold, open }}
          excerpt="First words…"
          body={<p>All of it.</p>}
        />,
      );
    // Same tree position: after the line (and the excerpt's slot, null when open), the head's last child.
    const children = (markup: string) => {
      const head = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
      return [
        ...head.matchAll(
          /<(span|button)(?: id="[^"]*")? (?:type="button" )?class="(ui-thread-message__(?:line|excerpt|toggle))"/g,
        ),
      ].map(m => m[2]);
    };
    assert.deepEqual(children(card(false)), [
      'ui-thread-message__line',
      'ui-thread-message__excerpt',
      'ui-thread-message__toggle',
    ]);
    assert.deepEqual(children(card(true)), [
      'ui-thread-message__line',
      'ui-thread-message__toggle',
    ]);
    for (const markup of [card(false), card(true)])
      assert.match(markup, /<\/span><button type="button" class="ui-thread-message__toggle"/);
    // An opened earlier message has the card's header row: the mark, the name, the time, the To circles.
    const open = card(true);
    assert.match(open, /data-layout="card"/);
    assert.match(open, /class="mark"/);
    assert.match(open, /class="to"/);
  });

  test('a message you just sent carries the undo tray in place', () => {
    const m = render(
      <ThreadMessage
        id="sent"
        from="You"
        toLabel="to Jordan Park"
        date="2026-10-29T09:59:30-07:00"
        cursor={false}
        body={<p>Direction B.</p>}
        undoTray={tray()}
      />,
    );
    assert.match(text(m), /^You to Jordan Park Just now/);
    assert.match(m, /class="ui-undo-tray" data-state="sending" data-placement="thread"/);
  });
});

describe('LoadingLine and ReplyStub', () => {
  test('one quiet status line with the label', () => {
    const m = render(<LoadingLine label="Loading Maple Library…" />);
    assert.match(
      m,
      /^<p class="ui-loading-line" role="status"><span class="ui-loading-line__spinner" aria-hidden="true"><\/span>/,
    );
    assert.equal(text(m), 'Loading Maple Library…');
  });

  test('"Reply to Jordan…" with its R keycap always shown', () => {
    const m = render(<ReplyStub recipientName="Jordan" commandId="mail.reply" onOpen={noop} />);
    assert.match(
      m,
      /^<button type="button" class="ui-reply-stub" title="Reply · R\. Hold R to dictate a reply">/,
    );
    assert.equal(text(m), 'Reply to Jordan… R');
    assert.equal(
      text(
        render(<ReplyStub recipientName={WORST.oneLetter} commandId="mail.reply" onOpen={noop} />),
      ),
      'Reply to Q… R',
    );
  });
});

describe('Why', () => {
  test('one sentence, a quote and the two lane corrections with their keys', () => {
    const m = render(
      <Why
        reason="Jordan asked you a direct question with a deadline."
        quote="Can you send me your preference by tomorrow?"
        lane="update"
        commands={{ up: 'mail.laneUp', down: 'mail.laneDown' }}
        onMove={noop}
      />,
    );
    assert.match(m, /role="group" aria-labelledby="[^"]+" data-lane="update"/);
    assert.equal(
      text(m),
      'Why it’s here Jordan asked you a direct question with a deadline. Can you send me your preference by tomorrow? Move up a lane ⌥↑ Move down a lane ⌥↓',
    );
    assert.match(m, /<blockquote class="ui-why__quote">/);
    assert.doesNotMatch(m, /disabled/);
  });

  test('up is off in Do now, down is off in Low importance', () => {
    const top = render(
      <Why
        reason="R"
        lane="do"
        commands={{ up: 'mail.laneUp', down: 'mail.laneDown' }}
        onMove={noop}
      />,
    );
    assert.match(top, /title="Move up a lane · ⌥↑" disabled=""/);
    assert.doesNotMatch(top, /title="Move down a lane · ⌥↓" disabled=""/);
    const bottom = render(
      <Why
        reason="R"
        lane="low"
        commands={{ up: 'mail.laneUp', down: 'mail.laneDown' }}
        onMove={noop}
      />,
    );
    assert.match(bottom, /title="Move down a lane · ⌥↓" disabled=""/);
  });
});

describe('UndoTray', () => {
  test('sending: "Sending to Jordan in 8 s · Undo Z · Send now" with the neutral drain', () => {
    const m = render(<UndoTray {...tray()} />);
    assert.match(
      m,
      /data-state="sending" data-placement="thread" role="group" aria-label="Undo send"/,
    );
    assert.equal(text(m), 'Sending to Jordan in 8 s Undo Z Send now');
    assert.match(
      m,
      /class="ui-undo-tray__drain" style="--undo-scale:1;--undo-elapsed:0" aria-hidden="true"/,
    );
    const longer = render(
      <UndoTray
        {...tray({
          state: {
            kind: 'sending',
            recipients: 'Jordan and Mina',
            secondsLeft: 15,
            totalSeconds: 20,
          },
        })}
      />,
    );
    assert.match(longer, /--undo-scale:2.5;--undo-elapsed:0.25/);
    assert.match(text(longer), /Sending to Jordan and Mina in 15 s/);
  });

  test('reduced motion: no drain, the text countdown only', () => {
    const m = render(
      <UndoTray
        {...tray({
          reducedMotion: true,
          state: { kind: 'sending', recipients: 'Jordan', secondsLeft: 3, totalSeconds: 8 },
        })}
      />,
    );
    assert.match(m, /data-motion="reduced"/);
    assert.doesNotMatch(m, /ui-undo-tray__drain/);
    assert.match(text(m), /Sending to Jordan in 3 s/);
  });

  test('uncertain, suspended and deferred notices write their copy as status lines', () => {
    const uncertain = render(
      <UndoTray {...tray({ state: { kind: 'uncertain' }, placement: 'toast' })} />,
    );
    assert.match(uncertain, /data-placement="toast" role="status"/);
    assert.equal(text(uncertain), 'Couldn’t confirm this was sent. Check Sent Send anyway');
    assert.equal(
      text(render(<UndoTray {...tray({ state: { kind: 'suspended' } })} />)),
      'Missed its time while your Mac was off. Send now Reschedule',
    );
    assert.equal(
      text(
        render(
          <UndoTray
            {...tray({ state: { kind: 'deferred', until: '2026-10-29T14:14:00-07:00' } })}
          />,
        ),
      ),
      'Couldn’t send until 2:14 PM. Your draft is saved.',
    );
  });
});

test('no banned phrase, glyph or exclamation mark rendered anywhere in the reader family', () => {
  assert.ok(collected.length > 20);
  for (const markup of collected) assert.deepEqual(bannedIn(markup), [], markup.slice(0, 160));
});
