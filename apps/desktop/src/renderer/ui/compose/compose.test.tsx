import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposeCommands, Recipient } from '../props';
import { Composer, DraftState, InlineReply, LevelMeter, RecipientField, Suggestion } from './index';

const noop = () => undefined;
const html = (element: ReactElement) => renderToStaticMarkup(element);
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

/** Things that must never render in any state (DESIGN §9 rule 8, §10). */
const BANNED = [
  /sparkle/i,
  /wand/i,
  /✨|⭐|🪄|🤖|🧠/,
  /magic/i,
  /AI-powered/i,
  /Copilot/i,
  /Hold to talk/i,
  /Todo/,
  /gradient/i,
  /backdrop/i,
];
function clean(markup: string) {
  const copy = text(markup);
  assert.ok(!copy.includes('!'), `an exclamation mark in: ${copy}`);
  for (const pattern of BANNED) assert.ok(!pattern.test(markup), `${pattern} rendered`);
}

const commands: ComposeCommands = {
  send: 'compose.send',
  attach: 'compose.attach',
  more: 'compose.format',
  cc: 'compose.ccBcc',
};

const LONG_SUBJECT = 'Re: '.padEnd(300, 'Hollow Creek launch plan ');
const LONG_ADDRESS = `${'a'.repeat(62)}@${'b'.repeat(17)}.co`;
const demoPeople: Recipient[] = [
  { id: 'jordan', name: 'Jordan Park', address: 'jordan@parkandpine.example' },
  { id: 'mina', name: 'Mina Cho', address: 'mina@parkandpine.example' },
];
const worstPeople: Recipient[] = [
  { id: 'long', address: LONG_ADDRESS },
  { id: 'one', name: 'A', address: 'a@example.test' },
  { id: 'cjk', name: '佐藤 花子', address: 'hana@example.test' },
  { id: 'ar', name: 'منى الحسن', address: 'mona@example.test' },
  { id: 'emoji', name: 'Theo 🧗', address: 'theo@example.test' },
];

function field(over: Partial<Parameters<typeof RecipientField>[0]> = {}) {
  return (
    <RecipientField
      label="To"
      recipients={demoPeople}
      query=""
      onQueryChange={noop}
      onCommit={noop}
      onRemove={noop}
      listboxId="to-list"
      {...over}
    />
  );
}

test('LevelMeter is a meter with a name, a clamped value and five bars, and no ring', () => {
  const quiet = html(<LevelMeter level={0} label="Listening" />);
  assert.match(quiet, /role="meter"/);
  assert.match(quiet, /aria-label="Listening"/);
  assert.match(quiet, /aria-valuenow="0"/);
  assert.match(quiet, /data-state="idle"/);
  assert.equal((quiet.match(/<i /g) ?? []).length, 5);
  assert.match(
    html(<LevelMeter level={0.5} label="Listening" />),
    /data-state="active"[^>]*style="--level:0.5"/,
  );
  assert.match(html(<LevelMeter level={7} label="Listening" />), /aria-valuenow="1"/);
  assert.match(html(<LevelMeter level={Number.NaN} label="Listening" />), /aria-valuenow="0"/);
  assert.doesNotMatch(quiet, /ring|breath/i);
});

test('DraftState writes the three lines of DESIGN 7.6', () => {
  assert.equal(text(html(<DraftState state="saving" />)), 'Saving…');
  assert.equal(text(html(<DraftState state="saved" />)), 'Draft saved');
  const failed = html(<DraftState state="failed" onRetry={noop} />);
  assert.equal(text(failed), 'Couldn’t save·Retry', 'the typographic apostrophe (voice rule)');
  assert.match(failed, /role="status"/);
  assert.match(failed, /data-state="failed"/);
  assert.match(failed, /<button[^>]*>.*Retry/);
  // Without a retry handler there is no dangling separator.
  const bare = html(<DraftState state="failed" />);
  assert.doesNotMatch(bare, /<button/);
  assert.equal(text(bare), 'Couldn’t save');
  // An untouched new message has no draft yet: no line at all, never "Draft saved".
  assert.equal(html(<DraftState state="none" />), '');
  // Worst case at a 300 px pane: the text gives way (own span), the dot and Retry come after it and never shrink.
  assert.ok(failed.indexOf('ui-draft-state__text') < failed.indexOf('ui-draft-state__dot'));
  assert.ok(failed.indexOf('ui-draft-state__dot') < failed.indexOf('Retry'));
  for (const state of ['saving', 'saved', 'failed'] as const)
    clean(html(<DraftState state={state} onRetry={noop} />));
});

test('Suggestion says what DESIGN says for an AI draft and for the follow-up nudge', () => {
  const draft = html(<Suggestion kind="draft" onKeep={noop} onDismiss={noop} />);
  assert.equal(text(draft), 'The gray sentence is a suggestion.KeepTabDismissEsc');
  assert.match(draft, /role="status"/);
  assert.match(draft, /<kbd[^>]*>Tab<\/kbd>/);
  assert.match(draft, /<kbd[^>]*>Esc<\/kbd>/);
  const followUp = html(<Suggestion kind="followUp" onKeep={noop} onDismiss={noop} />);
  assert.match(text(followUp), /^Aplos drafted this follow-up from your last email\./);
  assert.match(followUp, /data-kind="followUp"/);
  clean(draft);
  clean(followUp);
});

test('the draft strip is the reply card’s sibling, not inside it, with two real buttons that hold their keys', () => {
  const markup = html(reply({ suggestion: { kind: 'followUp', onKeep: noop, onDismiss: noop } }));
  const card = markup.slice(0, markup.indexOf('</section>') + '</section>'.length);
  assert.match(card, /^<section[^>]*class="ui-inline-reply"/);
  assert.doesNotMatch(card, /ui-suggestion/, 'nothing of the strip is inside the card');
  const rest = markup.slice(card.length);
  assert.match(
    rest,
    /^<div class="ui-suggestion" role="status" data-kind="followUp">/,
    'it follows the card directly',
  );
  assert.equal(rest.match(/<button type="button" class="ui-suggestion__act"/g)?.length, 2);
  assert.match(text(rest), /Aplos drafted this follow-up from your last email\.KeepTabDismissEsc/);
  assert.doesNotMatch(markup, /data-icon="(sparkle|wand|star)/i, 'no sparkle, wand or star');
  assert.doesNotMatch(html(reply()), /ui-suggestion/, 'no strip without a suggestion');
});

test('the placeholders are calm: To while empty, Subject; Cc stays bare', () => {
  assert.match(html(field({ recipients: [] })), /placeholder="Add a name or email"/);
  assert.doesNotMatch(html(field()), /placeholder=/, 'no placeholder next to chips');
  assert.doesNotMatch(html(field({ label: 'Cc', recipients: [] })), /placeholder=/);
  assert.match(html(composer()), /placeholder="Subject"/);
});

test('RecipientField is a combobox with a labelled listbox, removable people and the Cc owner', () => {
  const demo = html(
    field({
      query: 'ha',
      suggestions: [{ id: 'hana', name: 'Hana Sato', address: 'hana@studiokettle.example' }],
      activeSuggestionId: 'hana',
      ccButton: { onSelect: noop, commandId: 'compose.ccBcc' },
    }),
  );
  assert.match(demo, /role="group"[^>]*aria-label="To"/);
  assert.match(demo, /role="combobox"/);
  assert.match(demo, /aria-controls="to-list"/);
  assert.match(demo, /aria-expanded="true"/);
  assert.match(demo, /aria-activedescendant="to-list-hana"/);
  assert.match(demo, /id="to-list"[^>]*role="listbox"/);
  assert.match(demo, /id="to-list-hana"[^>]*role="option"[^>]*aria-selected="true"/);
  assert.match(demo, /aria-label="Remove Jordan Park"/);
  assert.match(demo, />Cc</);
  assert.doesNotMatch(demo, /title="Add Cc or Bcc/);
  assert.match(demo, /value="ha"/);
  clean(demo);

  const closed = html(field());
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /aria-activedescendant/);
  assert.match(closed, /id="to-list"[^>]*hidden/);
});

test('RecipientField survives worst-case people: long address, one letter, CJK, Arabic, emoji, invalid', () => {
  const markup = html(
    field({ label: 'Cc', recipients: worstPeople, invalidIds: ['long'], listboxId: 'cc-list' }),
  );
  assert.ok(markup.includes(LONG_ADDRESS));
  assert.match(markup, /data-invalid="true"[^>]*title="a{62}@/);
  assert.match(markup, /not a valid address/);
  assert.match(markup, /aria-label="Remove A"/);
  assert.ok(markup.includes('佐藤 花子'));
  assert.ok(markup.includes('منى الحسن'));
  assert.match(markup, /dir="auto"[^>]*>منى الحسن/);
  assert.ok(markup.includes('Theo 🧗'));
  assert.match(markup, /aria-label="Add Cc recipients"/);
  assert.equal((markup.match(/ui-recipient-field__name/g) ?? []).length, 5);
  clean(markup);
});

function reply(over: Partial<Parameters<typeof InlineReply>[0]> = {}) {
  return (
    <InlineReply
      recipients={field()}
      onPopOut={noop}
      editor={<div>Hi Jordan, Direction B for the first launch.</div>}
      draftState="saved"
      onRetrySave={noop}
      commands={commands}
      onSend={noop}
      onAttach={noop}
      onMore={noop}
      {...over}
    />
  );
}

test('InlineReply: the card, Send with its keycap, draft state, attach, more and pop out', () => {
  const markup = html(reply());
  assert.match(markup, /<section[^>]*class="ui-inline-reply"[^>]*aria-label="Reply"/);
  assert.match(markup, /aria-label="Pop out reply"/);
  // The tips are the real Tooltip (hover and keyboard focus), not a native title: only the names are in the markup.
  assert.match(markup, /aria-label="Attach"/);
  assert.match(markup, /aria-label="More"/);
  assert.doesNotMatch(markup, /title="Attach a file/);
  assert.match(markup, /data-variant="filled"[^>]*>.*Send.*<kbd[^>]*>⌘↩<\/kbd>/);
  assert.equal((markup.match(/data-variant="filled"/g) ?? []).length, 1, 'one filled button');
  assert.match(markup, /Draft saved/);
  assert.doesNotMatch(markup, /Listening/);
  clean(markup);
});

test('InlineReply: dictation, blocked send, conflict, follow-up hint and a failed save', () => {
  const dictating = html(reply({ dictation: { holdKey: 'R', level: 0.4 } }));
  assert.match(text(dictating), /Listening\. Release R to keep, Esc to cancel\./);
  assert.match(dictating, /role="meter"/);
  assert.doesNotMatch(dictating, /Draft saved/);
  clean(dictating);

  const blocked = html(
    reply({ blocked: { field: 'to', message: 'Add at least one recipient before you send.' } }),
  );
  assert.match(blocked, /data-blocked="true"/);
  assert.match(blocked, /role="alert"/);
  assert.match(text(blocked), /Add at least one recipient before you send\./);
  assert.doesNotMatch(blocked, /shake/i);
  clean(blocked);

  const conflict = html(
    reply({ conflict: { onKeepMine: noop, onTakeTheirs: noop, onKeepBoth: noop } }),
  );
  assert.match(
    text(conflict),
    /This draft changed on another device\.Keep mineTake theirsKeep both/,
  );

  const nudge = html(reply({ suggestion: { kind: 'followUp', onKeep: noop, onDismiss: noop } }));
  assert.match(text(nudge), /Aplos drafted this follow-up from your last email\./);

  const failed = html(reply({ draftState: 'failed' }));
  assert.match(text(failed), /Couldn’t save·Retry/);
});

function composer(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  return (
    <Composer
      recipients={field()}
      subject="Hollow Creek: going with Direction B"
      onSubjectChange={noop}
      editor={<div>Hi Jordan and Mina,</div>}
      draftState="saved"
      onRetrySave={noop}
      commands={commands}
      onSend={noop}
      onAttach={noop}
      onFormat={noop}
      {...over}
    />
  );
}

test('Composer: To row, heading-size subject, body, footer with Send, draft state, attach and format', () => {
  const markup = html(composer());
  assert.match(markup, /aria-label="New message"/);
  assert.match(
    markup,
    /<input[^>]*aria-label="Subject"[^>]*placeholder="Subject"[^>]*value="Hollow Creek: going with Direction B"/,
  );
  assert.match(markup, /<footer[^>]*class="ui-composer__foot"/);
  assert.match(markup, /<kbd[^>]*>⌘↩<\/kbd>/);
  assert.match(markup, /aria-label="Formatting"/);
  assert.match(markup, /Draft saved/);
  assert.doesNotMatch(markup, /Polish suggests/);
  assert.doesNotMatch(markup, /is a suggestion/);
  clean(markup);
});

test('Composer: AI draft hint, Polish bar, follow-up hint and dictation from an empty body', () => {
  assert.match(
    text(html(composer({ suggestion: { kind: 'draft', onKeep: noop, onDismiss: noop } }))),
    /The gray sentence is a suggestion\./,
  );
  assert.match(
    text(html(composer({ suggestion: { kind: 'followUp', onKeep: noop, onDismiss: noop } }))),
    /Aplos drafted this follow-up from your last email\./,
  );

  const polish = html(composer({ polish: { changes: 3, onUse: noop, onKeep: noop } }));
  assert.match(text(polish), /Polish suggests 3 changes\. Yours stays until you choose\./);
  assert.match(polish, /Use these.*<kbd[^>]*>↩<\/kbd>/);
  assert.match(polish, /Keep mine.*<kbd[^>]*>Esc<\/kbd>/);
  assert.match(
    text(html(composer({ polish: { changes: 1, onUse: noop, onKeep: noop } }))),
    /Polish suggests 1 change\./,
  );
  assert.match(
    text(html(composer({ polish: { changes: 9999, onUse: noop, onKeep: noop } }))),
    /Polish suggests 9999 changes\./,
  );
  clean(polish);

  const dictating = html(composer({ dictation: { holdKey: 'Space', level: 0.2 } }));
  assert.match(text(dictating), /Listening\. Release Space to keep, Esc to cancel\./);
});

test('Composer: a blocked send outlines the named field and says why in one sentence', () => {
  for (const field of ['to', 'subject', 'body'] as const) {
    const markup = html(
      composer({ blocked: { field, message: 'Add a subject or send without one.' } }),
    );
    assert.equal((markup.match(/data-blocked="true"/g) ?? []).length, 1, `${field} outlined once`);
    assert.match(markup, /role="alert"/);
  }
  const subject = html(composer({ blocked: { field: 'subject', message: 'Add a subject.' } }));
  assert.match(subject, /aria-invalid="true"/);
  assert.match(subject, /aria-describedby="[^"]*-blocked"/);
});

test('Composer survives a 300-character subject, CJK, Arabic and emoji', () => {
  assert.equal(LONG_SUBJECT.length, 300);
  const long = html(
    composer({ subject: LONG_SUBJECT, recipients: field({ recipients: worstPeople }) }),
  );
  assert.ok(long.includes(`value="${LONG_SUBJECT}"`));
  assert.ok(long.includes(LONG_ADDRESS));
  for (const subject of ['件名：ホロークリーク', 'الموضوع: مراجعة التصميم', 'Launch 🚀 plan']) {
    const markup = html(composer({ subject }));
    assert.ok(markup.includes(`value="${subject}"`));
    assert.match(markup, /<input[^>]*dir="auto"/);
  }
  clean(long);
});

test('Composer: failed save and a draft conflict', () => {
  assert.match(text(html(composer({ draftState: 'failed' }))), /Couldn’t save·Retry/);
  assert.match(text(html(composer({ draftState: 'saving' }))), /Saving…/);
  assert.match(
    text(html(composer({ conflict: { onKeepMine: noop, onTakeTheirs: noop, onKeepBoth: noop } }))),
    /This draft changed on another device\./,
  );
});
