// The focus card's summary space in its three states (owner decision 2026-11-13): a quiet placeholder while the
// summary is being written, the serif line when it lands, and the subject alone, with the slot fitting the card,
// when no summary will come.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FocusLetter, FocusSlot } from './index';
import type { FocusLetterProps } from '../props';

const SUBJECT = 'October illustrations';

function letter(summary: FocusLetterProps['summary']): string {
  return renderToStaticMarkup(
    <FocusSlot density="comfortable" fit={summary.state === 'absent' ? 'content' : 'fixed'}>
      <FocusLetter
        id="home-row-t1"
        sender="Drew Bell"
        date="2025-10-22T08:03:00-07:00"
        summary={summary}
        suggestion={{ verb: 'Reply', icon: 'reply', isDone: false }}
        commands={{
          suggest: 'mail.suggested',
          later: 'mail.later',
          done: 'mail.done',
          more: 'list.more',
        }}
        demoted={false}
        onSuggestion={() => undefined}
        onLater={() => undefined}
        onDone={() => undefined}
        onMore={() => undefined}
      />
    </FocusSlot>,
  );
}

describe('the focus card summary space', () => {
  test('summaries on, still being written: two soft lines and a muted label, subject kept for screen readers', () => {
    const m = letter({ state: 'pending', subject: SUBJECT });
    assert.match(m, /data-width="long"/);
    assert.match(m, /data-width="short"/);
    assert.match(m, /Summarizing…/);
    assert.match(m, new RegExp(`ui-list-sr">${SUBJECT}<`));
    assert.doesNotMatch(
      m,
      /data-fit/,
      'a pending card keeps the slot height, so the buttons stay put',
    );
    assert.doesNotMatch(m, /sparkle|Sparkle|shimmer/i);
  });

  test('summaries on, written: the serif line replaces the placeholder in the same slot', () => {
    const m = letter({
      state: 'ready',
      text: 'Drew sent the October illustrations and needs a reply by Friday.',
      subject: SUBJECT,
      provenance: { provider: 'Groq', local: false },
    });
    assert.match(m, /data-state="ready"/);
    assert.match(m, /needs a reply by Friday/);
    assert.doesNotMatch(m, /ui-summary-placeholder|Summarizing/);
    assert.doesNotMatch(m, /data-fit/);
  });

  test('summaries off, failed or timed out: no placeholder, the subject alone and the slot fits the card', () => {
    const m = letter({ state: 'absent', subject: SUBJECT });
    assert.match(m, /class="ui-focus-slot" data-density="comfortable" data-fit="content"/);
    assert.match(m, /data-state="absent"/);
    assert.doesNotMatch(m, /ui-summary-placeholder|Summarizing|error/i);
  });
});
