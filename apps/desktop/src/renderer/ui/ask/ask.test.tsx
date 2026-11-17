import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AskDockProps,
  AskTurnProps,
  CitationData,
  PaletteItem,
  PaletteProps,
  ProposalCardProps,
  SearchFieldProps,
} from '../props';
import {
  AskDock,
  AskTurn,
  Citation,
  OperatorToken,
  Palette,
  ProposalCard,
  SearchField,
  StepLog,
} from './index';
import { openCitation } from './Citation';
import { announcesAnswered } from './AskTurn';
import { formatRecent, formatSource, setFormatClock } from './format';
import { nextActiveId } from './palette-nav';

const noop = () => undefined;
const html = (element: ReactElement) => renderToStaticMarkup(element);
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const BANNED = [
  /sparkle/i,
  /wand/i,
  /✨|⭐|🪄|🤖|🧠/,
  /magic/i,
  /AI-powered/i,
  /Copilot/i,
  /Ask me anything/i,
  /Hold to talk/i,
  /Todo/,
  /gradient/i,
  /backdrop/i,
];
function clean(markup: string) {
  assert.ok(!text(markup).includes('!'), `an exclamation mark in: ${text(markup)}`);
  for (const pattern of BANNED) assert.ok(!pattern.test(markup), `${pattern} rendered`);
}

const LONG_QUESTION = 'What did everyone say about the '.padEnd(300, 'Hollow Creek design review ');
const LONG_ADDRESS = `${'a'.repeat(62)}@${'b'.repeat(17)}.co`;

const source1: CitationData = {
  index: 1,
  quote: 'Can we do the design review Thursday, 2:00 to 2:30? Jordan can join.',
  from: 'Mina Cho',
  date: '2020-03-20T09:12:00-07:00',
  subject: 'Hollow Creek review',
  threadId: 't1',
};
const source2: CitationData = {
  index: 2,
  quote: 'Can you send me your preference by tomorrow?',
  from: 'Jordan Park',
  date: '2020-03-02T10:00:00-07:00',
  subject: 'A quieter home for the Hollow Creek site',
  threadId: 't2',
};

const fold = {
  summary: 'Read 14 emails from Jordan · 3 steps',
  steps: ['Searched mail for “design review”', 'Read 14 emails from Jordan and Mina'],
  expanded: false,
  onToggle: noop,
};

function turn(over: Partial<AskTurnProps> = {}) {
  return (
    <AskTurn
      id="q1"
      question="When is the Hollow Creek design review?"
      state="answered"
      citations={[source1, source2]}
      onOpenCitation={noop}
      answer={[
        [
          { kind: 'text', text: 'Mina’s note puts the design review with you and Jordan at ' },
          { kind: 'text', text: 'Thursday, 2:00–2:30 PM', strong: true },
          { kind: 'text', text: '.' },
          { kind: 'cite', index: 1 },
          { kind: 'text', text: ' Jordan also wants your layout pick by tomorrow.' },
          { kind: 'cite', index: 2 },
        ],
      ]}
      {...over}
    />
  );
}

test('Citation: a mono [n] chip with the quote as a described tooltip and a source line', () => {
  const markup = html(<Citation {...source1} onOpen={noop} />);
  assert.match(
    markup,
    /<button[^>]*aria-label="Source 1: Mina Cho, Hollow Creek review"[^>]*aria-describedby="([^"]+)"[^>]*>\[1\]<\/button>/,
  );
  const id = /aria-describedby="([^"]+)"/.exec(markup)![1];
  assert.match(markup, new RegExp(`id="${id.replace(/[:]/g, '\\:')}"[^>]*role="tooltip"`));
  assert.ok(
    text(markup).includes('“Can we do the design review Thursday, 2:00 to 2:30? Jordan can join.”'),
  );
  assert.match(text(markup), /Mina Cho · Mar 20, 2020 · Hollow Creek review/);
  clean(markup);
});

test('Citation survives a 1-character index, 9999, a very long quote and RTL text', () => {
  const big = html(
    <Citation {...source1} index={9999} quote={'x'.repeat(400)} from="منى الحسن" onOpen={noop} />,
  );
  assert.match(big, />\[9999\]</);
  assert.ok(big.includes('x'.repeat(400)));
  assert.match(big, /dir="auto"/);
});

test('StepLog: a steady status line while working, a disclosure after', () => {
  const working = html(
    <StepLog
      current="Reading 14 emails from Jordan"
      summary=""
      steps={[]}
      expanded={false}
      onToggle={noop}
    />,
  );
  assert.match(working, /data-state="working"/);
  assert.match(working, /role="status"/);
  assert.match(text(working), /^Reading 14 emails from Jordan$/);
  assert.doesNotMatch(working, /shimmer|pulse|typewriter|blink/i);

  const folded = html(<StepLog {...fold} />);
  assert.match(folded, /data-state="folded"/);
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /<ul[^>]*hidden/);
  assert.match(text(folded), /Read 14 emails from Jordan · 3 steps/);
  const open = html(<StepLog {...fold} expanded />);
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /<ul[^>]*hidden/);
  assert.match(open, /<li[^>]*>Searched mail for “design review”<\/li>/);
});

test('ProposalCard: the one card, the filled button with Return, Not now with Esc', () => {
  const base: ProposalCardProps = {
    kicker: 'Add to Calendar',
    title: 'Design review',
    consequence: 'Thu 2:00–2:30 PM · Hollow Creek',
    color: 'ember',
    confirmLabel: 'Add',
    state: 'pending',
    onConfirm: noop,
    onDismiss: noop,
  };
  const pending = html(<ProposalCard {...base} />);
  assert.match(pending, /data-state="pending"/);
  assert.match(pending, /aria-labelledby/);
  assert.match(pending, /--swatch:var\(--tag-ember\)/);
  assert.match(pending, /data-variant="filled"[^>]*>.*Add.*<kbd[^>]*>↩<\/kbd>/);
  // The hint is the real Tooltip now (hover and keyboard focus), so the markup carries the label only.
  assert.match(
    pending,
    /data-variant="text"[^>]*><span class="ui-compose-btn__label">Not now<\/span>/,
  );
  assert.doesNotMatch(pending, /Not now<\/span><kbd/);
  assert.equal((pending.match(/data-variant="filled"/g) ?? []).length, 1);
  assert.match(text(pending), /Add to CalendarDesign reviewThu 2:00–2:30 PM · Hollow Creek/);
  clean(pending);

  const applied = html(
    <ProposalCard
      {...base}
      state="applied"
      appliedText="Added to Calendar · Thu 2:00–2:30 PM · Hollow Creek"
    />,
  );
  assert.match(applied, /data-state="applied"/);
  assert.match(applied, /role="status"/);
  assert.doesNotMatch(applied, /<button/);
  assert.equal(text(applied), 'Added to Calendar · Thu 2:00–2:30 PM · Hollow Creek');
  assert.equal(html(<ProposalCard {...base} state="dismissed" />), '');

  const worst = html(
    <ProposalCard
      {...base}
      title={LONG_QUESTION}
      consequence={LONG_ADDRESS}
      kicker="カレンダーに追加"
      color={undefined}
    />,
  );
  assert.ok(worst.includes(LONG_ADDRESS));
  assert.doesNotMatch(worst, /ui-proposal-card__mark/);
});

test('AskTurn: question line, serif prose with the decisive fact, citation chips', () => {
  const markup = html(turn());
  assert.match(markup, /<article id="q1"[^>]*aria-labelledby="q1-question"/);
  assert.match(
    markup,
    /class="ui-ask-turn__question" id="q1-question"[^>]*>When is the Hollow Creek design review\?/,
  );
  assert.match(markup, /<strong>Thursday, 2:00–2:30 PM<\/strong>/);
  assert.equal((markup.match(/role="tooltip"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /No source in your mail/);
  assert.doesNotMatch(markup, /ui-ask-turn__caret/);
  assert.match(text(markup), /Mar 20, 2020/);
  assert.match(text(markup), /Mar 2, 2020/);
  clean(markup);
});

test('AskTurn: every answer cites or says "No source in your mail"; unreferenced sources still show', () => {
  assert.match(text(html(turn({ citations: [] }))), /No source in your mail/);
  const loose = html(
    turn({ answer: [[{ kind: 'text', text: 'Nothing is pending.' }]], citations: [source1] }),
  );
  assert.match(loose, /class="ui-ask-turn__sources"/);
  assert.match(loose, /\[1\]/);
  assert.doesNotMatch(loose, /No source in your mail/);
});

test('AskTurn announces "Answered" only after this mount saw the turn unfinished', () => {
  // A reopened conversation mounts every turn 'answered': none may announce, or reopening queues one status each.
  const answered = html(turn());
  assert.doesNotMatch(answered, /role="status">\s*Answered/);
  assert.doesNotMatch(
    answered,
    /ui-ask-turn__answer[^>]*role="status"/,
    'the prose stays out of aria-live',
  );
  assert.equal(announcesAnswered(true, 'answered'), true, 'a live transition announces');
  assert.equal(announcesAnswered(false, 'answered'), false, 'mounted answered stays quiet');
  for (const state of [
    'working',
    'streaming',
    'stopped',
    'failed',
    'paused',
    'excluded',
  ] as const) {
    assert.equal(announcesAnswered(true, state), false);
    assert.doesNotMatch(
      html(turn({ state, answer: undefined, citations: [] })),
      /Answered/,
      `no announcement while ${state}`,
    );
  }
});

test('AskTurn states: working, streaming with one caret, stopped, failed', () => {
  const working = html(
    turn({
      state: 'working',
      answer: undefined,
      citations: [],
      steps: { ...fold, current: 'Reading 14 emails from Jordan' },
    }),
  );
  assert.match(working, /data-state="working"/);
  assert.match(working, /aria-busy="true"/);
  assert.match(text(working), /Reading 14 emails from Jordan/);
  assert.doesNotMatch(working, /No source/);

  const streaming = html(turn({ state: 'streaming', citations: [] }));
  assert.equal((streaming.match(/ui-ask-turn__caret/g) ?? []).length, 1);
  assert.doesNotMatch(streaming, /No source/);

  assert.match(text(html(turn({ state: 'stopped' }))), /Stopped\./);

  const failed = html(
    turn({
      state: 'failed',
      answer: undefined,
      citations: [],
      provider: 'Groq',
      onRetry: noop,
      onUseAnotherProvider: noop,
    }),
  );
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Groq didn't answer\.RetryUse another provider/);
  assert.match(
    text(html(turn({ state: 'failed', answer: undefined, citations: [] }))),
    /Ask didn't answer\./,
  );
  clean(failed);
});

test('AskTurn with a proposal puts the card after the answer', () => {
  const markup = html(
    turn({
      proposal: {
        kicker: 'Add to Calendar',
        title: 'Design review',
        consequence: 'Thu 2:00–2:30 PM',
        confirmLabel: 'Add',
        state: 'pending',
        onConfirm: noop,
        onDismiss: noop,
      },
    }),
  );
  assert.ok(markup.indexOf('ui-ask-turn__answer') < markup.indexOf('ui-proposal-card'));
});

test('AskTurn worst case: a 300-character question, CJK, Arabic, emoji and a 9999 citation', () => {
  assert.equal(LONG_QUESTION.length, 300);
  const markup = html(
    turn({
      question: LONG_QUESTION,
      citations: [{ ...source1, index: 9999, from: LONG_ADDRESS }],
      answer: [
        [
          { kind: 'text', text: 'デザインレビューは木曜日です。', strong: true },
          { kind: 'cite', index: 9999 },
        ],
        [{ kind: 'text', text: 'الاجتماع يوم الخميس 🧗' }],
      ],
    }),
  );
  assert.ok(markup.includes(LONG_QUESTION));
  assert.ok(markup.includes('デザインレビューは木曜日です。'));
  assert.ok(markup.includes('الاجتماع يوم الخميس 🧗'));
  assert.match(markup, /\[9999\]/);
  assert.match(markup, /dir="auto"/);
  clean(markup);
});

function dock(over: Partial<AskDockProps> = {}) {
  return (
    <AskDock
      tab="ask"
      onTabChange={noop}
      onClose={noop}
      width={360}
      onWidthChange={noop}
      providerReady
      onOpenSettings={noop}
      today={<p>Thursday, October 29</p>}
      value=""
      onChange={noop}
      onSubmit={noop}
      working={false}
      onStop={noop}
      queued={[]}
      onQueuedChange={noop}
      onSendQueuedNow={noop}
      {...over}
    />
  );
}

const empty = {
  suggestions: [
    'What needs a reply from me today?',
    'When am I free tomorrow afternoon?',
    'Summarize this week’s mail from Jordan',
  ],
  recents: [
    {
      id: 'r1',
      question: 'When is the Hollow Creek design review?',
      at: '2020-03-02T09:42:00-07:00',
    },
    { id: 'r2', question: 'How much is Drew’s October invoice?', at: '2019-12-31T09:00:00-07:00' },
  ],
  cursorIndex: 1,
  onPickSuggestion: noop,
  onOpenRecent: noop,
};

test('AskDock: header with an Ask | Today tablist and a labelled close', () => {
  const markup = html(dock({ empty }));
  assert.match(markup, /<aside[^>]*aria-label="Ask"/);
  assert.match(markup, /--ask-dock-w:360px/);
  assert.match(markup, /role="tablist"[^>]*aria-label="Ask or Today"/);
  assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Ask</);
  assert.match(markup, /role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"[^>]*>Today</);
  assert.match(markup, /aria-label="Close"/);
  assert.match(markup, /role="tabpanel"/);
  assert.match(markup, /role="separator"[^>]*aria-valuenow="360"/);
  clean(markup);
});

test('AskDock empty view: placeholder, three suggestions, recent chats with times, cursor wired to the field', () => {
  const markup = html(dock({ empty }));
  assert.match(markup, /placeholder="Ask about your mail or calendar"/);
  assert.match(text(markup), /Try asking.*What needs a reply from me today\?.*Recent/);
  assert.equal((markup.match(/role="option"/g) ?? []).length, 5);
  assert.match(markup, /aria-selected="true"[^>]*data-cursor="true"/);
  const listId = /id="([^"]+)"[^>]*class="ui-ask-dock__empty"/.exec(markup)![1];
  assert.match(markup, new RegExp(`aria-controls="${listId}"`));
  assert.match(markup, new RegExp(`aria-activedescendant="${listId}-s1"`));
  assert.match(text(markup), /Mar 2, 2020/);
  assert.match(text(markup), /Dec 31, 2019/);
  assert.doesNotMatch(text(markup), /Ask me anything/i);
  clean(markup);
});

test('AskDock: input is never disabled; working shows Stop; queued follow-ups are editable cards', () => {
  const markup = html(
    dock({
      working: true,
      conversation: turn({ state: 'working', answer: undefined, citations: [] }),
      queued: [{ id: 'f1', text: 'And is Mina free then?' }],
      value: 'draft question',
    }),
  );
  assert.doesNotMatch(markup, /disabled/);
  assert.match(markup, /<textarea[^>]*aria-label="Ask"[^>]*>draft question<\/textarea>/);
  assert.match(
    markup,
    /class="ui-ask-dock__input"[^>]*data-dictation="body"/,
    'the field marks itself dictable for the held A',
  );
  assert.match(markup, /Stop/);
  assert.match(markup, /role="group"[^>]*aria-label="Queued follow-up"/);
  assert.match(text(markup), /Queued · ⌘Return sends now/);
  assert.match(
    markup,
    /<textarea[^>]*aria-label="Queued follow-up"[^>]*>And is Mina free then\?<\/textarea>/,
  );
  assert.doesNotMatch(html(dock()), />Stop</);
  clean(markup);
});

test('AskDock: no provider is one plain line and a link, never an alert', () => {
  const markup = html(dock({ providerReady: false, empty }));
  assert.match(text(markup), /Add an AI key to ask\./);
  assert.match(markup, /<button[^>]*class="ui-ask-dock__link"[^>]*>Open Settings → AI/);
  assert.doesNotMatch(markup, /role="alert"|stamp|ui-ask-dock__empty/);
  assert.doesNotMatch(markup, /<textarea[^>]*disabled/, 'typing stays allowed');
  assert.match(markup, /<button[^>]*(disabled[^>]*aria-label="Ask"|aria-label="Ask"[^>]*disabled)/);
  assert.doesNotMatch(html(dock({ empty })), /<button[^>]*disabled/, 'with a provider Ask is live');
});

test('AskDock: dictation shows the meter and the Listening line; Today hides the field', () => {
  const dictating = html(dock({ empty, dictation: { holdKey: 'A', level: 0.3 } }));
  assert.match(text(dictating), /Listening\. Release A to keep, Esc to cancel\./);
  assert.match(dictating, /role="meter"/);

  const today = html(dock({ tab: 'today' }));
  assert.match(today, /role="tab"[^>]*aria-selected="true"[^>]*>Today</);
  assert.match(text(today), /Thursday, October 29/);
  assert.doesNotMatch(today, /<textarea/);
});

test('AskDock clamps its width to 300 to 440 and survives worst-case recents', () => {
  assert.match(html(dock({ width: 100 })), /--ask-dock-w:300px/);
  assert.match(html(dock({ width: 9999 })), /--ask-dock-w:440px/);
  assert.match(html(dock({ width: Number.NaN })), /--ask-dock-w:360px/);
  const markup = html(
    dock({
      empty: {
        ...empty,
        suggestions: ['q'],
        recents: [
          { id: 'x', question: LONG_QUESTION, at: '2020-03-02T09:42:00-07:00' },
          { id: 'y', question: '佐藤さんに何を送った？ 🧗', at: '2020-03-01T09:42:00-07:00' },
        ],
        cursorIndex: undefined,
      },
    }),
  );
  assert.ok(markup.includes(LONG_QUESTION));
  assert.ok(markup.includes('佐藤さんに何を送った？ 🧗'));
  assert.doesNotMatch(markup, /aria-activedescendant/);
});

const items: PaletteItem[] = [
  { id: 'cmd-reply', commandId: 'mail.reply', label: 'Reply', icon: 'reply' },
  { id: 'cmd-done', commandId: 'mail.done', label: 'Done', icon: 'check' },
  { id: 'cmd-home', commandId: 'nav.home', label: 'Home', icon: 'home' },
  {
    id: 'cmd-delete',
    commandId: 'mail.deleteForever',
    label: 'Delete forever',
    icon: 'trash',
    destructive: true,
    group: 'Actions',
  },
];

function palette(over: Partial<PaletteProps> = {}) {
  return (
    <Palette
      open
      query=""
      onQueryChange={noop}
      context="Drew Bell · October illustrations"
      sections={[
        { id: 'suggested', label: 'Suggested', items: items.slice(0, 2) },
        { id: 'goto', label: 'Go to', items: items.slice(2, 3) },
      ]}
      activeId="cmd-reply"
      onActiveChange={noop}
      onRun={noop}
      listboxId="palette-list"
      onBack={noop}
      onClose={noop}
      {...over}
    />
  );
}

test('Palette closed renders nothing', () => {
  assert.equal(html(palette({ open: false })), '');
});

test('Palette first open: context line, Suggested and Go to, digits 1 to 3, keycaps from the registry', () => {
  const markup = html(palette());
  assert.match(markup, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Commands"/);
  const input = /<input[^>]*>/.exec(markup)![0];
  assert.match(input, /role="combobox"/);
  assert.match(input, /aria-controls="palette-list"/);
  assert.match(markup, /aria-activedescendant="cmd-reply"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(text(markup), /For: Drew Bell · October illustrations/);
  assert.match(markup, /id="palette-list"[^>]*role="listbox"/);
  assert.equal((markup.match(/role="group"/g) ?? []).length, 2);
  assert.ok(markup.indexOf('Suggested') < markup.indexOf('Go to'));
  assert.equal((markup.match(/ui-palette__num/g) ?? []).length, 3);
  assert.match(markup, /id="cmd-reply"[^>]*role="option"[^>]*aria-selected="true"/);
  assert.match(markup, /id="cmd-done"[^>]*aria-selected="false"/);
  assert.match(markup, /<kbd[^>]*>R<\/kbd>/);
  assert.match(markup, /<kbd[^>]*>E<\/kbd>/);
  assert.match(markup, /<kbd[^>]*>⌃1<\/kbd>/);
  assert.match(markup, /placeholder="Type a command"/);
  assert.doesNotMatch(markup, /ui-palette__confirm/);
  clean(markup);
});

test('Palette filtering: flat list, match bolding, group names, no digits', () => {
  const markup = html(
    palette({
      query: 'rep',
      sections: [
        {
          id: 'results',
          label: 'Results',
          items: [
            { ...items[0], matches: [0, 1, 2], group: 'Actions' },
            { ...items[3], matches: [0], group: 'Actions' },
          ],
        },
      ],
    }),
  );
  assert.match(markup, /<b>Rep<\/b>ly/);
  assert.match(markup, /<b>D<\/b>elete forever/);
  assert.match(markup, /ui-palette__group">Actions</);
  assert.doesNotMatch(markup, /ui-palette__num/);
  assert.match(markup, /ui-palette__section-label" data-hidden="true"/);
  assert.match(markup, /data-destructive="true"/);
});

test('Palette empty result and breadcrumbs', () => {
  const none = html(palette({ query: 'zzz', sections: [] }));
  assert.match(text(none), /No commands match “zzz”\./);
  assert.match(none, /role="status"/);
  assert.doesNotMatch(none, /role="listbox"/);
  assert.match(none, /aria-expanded="false"/);

  const nested = html(palette({ trail: ['Settings', 'AI providers'] }));
  assert.match(nested, /<ol[^>]*aria-label="Path"/);
  assert.match(text(nested), /SettingsAI providers/);
});

test('Palette destructive confirm defaults to Cancel: Return cancels, ⇧Return deletes', () => {
  const markup = html(
    palette({
      confirm: {
        question: 'Delete forever?',
        consequence:
          '“Invoice #0412 · October illustrations” will be removed from your account. This can’t be undone.',
        confirmLabel: 'Delete forever',
        destructive: true,
        presentation: 'inline',
        onConfirm: noop,
        onCancel: noop,
      },
    }),
  );
  assert.match(markup, /ui-palette__confirm/);
  assert.match(markup, /role="group"[^>]*aria-labelledby/);
  assert.match(text(markup), /Delete forever\?/);
  assert.ok(markup.indexOf('Cancel') < markup.indexOf('Delete forever</span>'), 'Cancel row first');
  assert.match(markup, /data-primary="true"[^>]*><span>Cancel<\/span><kbd[^>]*>↩<\/kbd>/);
  assert.match(markup, /data-tone="danger"[^>]*>.*<span>Delete forever<\/span><kbd[^>]*>⇧↩<\/kbd>/);
  assert.match(markup, /readOnly|readonly/);
  assert.doesNotMatch(markup, /role="listbox"/);
  assert.doesNotMatch(markup, /For: /);
  clean(markup);
});

test('Palette plain confirm makes the confirm row the default', () => {
  const markup = html(
    palette({
      confirm: {
        question: 'Discard this draft?',
        consequence: 'It cannot be recovered.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: false,
        presentation: 'inline',
        onConfirm: noop,
        onCancel: noop,
      },
    }),
  );
  assert.match(markup, /data-primary="true"[^>]*><span>Discard<\/span><kbd[^>]*>↩<\/kbd>/);
  assert.match(markup, /><span>Keep editing<\/span><kbd[^>]*>Esc<\/kbd>/);
});

test('Palette worst case: 300-character context, CJK and Arabic labels, 80-character address in a label', () => {
  const markup = html(
    palette({
      context: LONG_QUESTION,
      sections: [
        {
          id: 'x',
          label: 'Actions',
          items: [
            { id: 'a', commandId: 'mail.reply', label: `Reply to ${LONG_ADDRESS}`, icon: 'reply' },
            {
              id: 'b',
              commandId: 'mail.done',
              label: '完了にする',
              icon: 'check',
              matches: [0, 1],
            },
            { id: 'c', commandId: 'mail.later', label: 'ردّ على الرسالة', icon: 'clock' },
            { id: 'd', commandId: 'mail.later', label: 'Later 🧗', icon: 'clock' },
          ],
        },
      ],
      activeId: 'a',
    }),
  );
  assert.ok(markup.includes(LONG_ADDRESS));
  assert.ok(markup.includes('<b>完了</b>にする'));
  assert.ok(markup.includes('ردّ على الرسالة'));
  assert.ok(markup.includes('Later 🧗'));
  assert.ok(markup.includes(LONG_QUESTION));
  clean(markup);
});

function search(over: Partial<SearchFieldProps> = {}) {
  return (
    <SearchField
      value=""
      onChange={noop}
      tokens={[]}
      onRemoveToken={noop}
      onSubmit={noop}
      scopeLabel="All accounts"
      resultsId="results"
      onLeaveToList={noop}
      {...over}
    />
  );
}

test('SearchField: heading-size combobox, the fixed hint when there are no tokens, scope on the right', () => {
  const markup = html(search());
  assert.match(markup, /role="search"/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-controls="results"/);
  assert.match(markup, /aria-label="Search mail"/);
  assert.match(markup, /placeholder="Search mail"/);
  assert.match(text(markup), /Narrow with/);
  for (const operator of [
    'from:',
    'to:',
    'subject:',
    'has:attachment',
    'before:',
    'after:',
    'in:done',
  ]) {
    assert.match(
      markup,
      new RegExp(`<button[^>]*>.*?<span class="ui-compose-btn__label">${operator}</span>`),
    );
  }
  assert.match(text(markup), /All accounts/);
  clean(markup);
});

test('SearchField tokens replace the hint and are removable; a scope picker becomes a button', () => {
  const markup = html(
    search({
      value: 'layout',
      tokens: [
        { operator: 'from', value: 'jordan' },
        { operator: 'has', value: 'attachment' },
        { operator: 'in', value: 'done' },
      ],
      onScope: noop,
    }),
  );
  assert.doesNotMatch(text(markup), /Narrow with/);
  assert.match(markup, /value="layout"/);
  assert.match(markup, /aria-label="Remove from: jordan"/);
  assert.match(markup, /aria-label="Remove has: attachment"/);
  assert.match(markup, /aria-label="Remove in: done"/);
  assert.match(
    markup,
    /<button[^>]*data-variant="text"[^>]*><span class="ui-compose-btn__label">All accounts<\/span>/,
  );
});

test('SearchField and OperatorToken survive an 80-character address, CJK, Arabic, one letter', () => {
  const markup = html(
    search({
      value: '請求書 🧾',
      scopeLabel: 'جميع الحسابات',
      tokens: [
        { operator: 'from', value: LONG_ADDRESS },
        { operator: 'to', value: 'a' },
        { operator: 'subject', value: 'تقرير' },
      ],
    }),
  );
  assert.ok(markup.includes(LONG_ADDRESS));
  assert.ok(markup.includes('value="請求書 🧾"'));
  assert.ok(markup.includes('جميع الحسابات'));
  const token = html(<OperatorToken operator="before" value="2026-10-01" onRemove={noop} />);
  assert.match(token, /data-operator="before"/);
  assert.match(token, /<b[^>]*>before:<\/b>/);
  assert.match(token, /title="Remove"/);
  clean(markup);
});

test('format: the default "now" follows the clock the host injects', () => {
  try {
    setFormatClock(() => new Date(2026, 9, 28, 10, 0).getTime());
    assert.equal(formatRecent('2026-10-28T09:42:00-07:00'), '9:42 AM');
    assert.equal(formatRecent('2026-10-27T09:42:00-07:00'), 'Yesterday');
    assert.equal(formatSource('2026-10-28T09:42:00-07:00'), 'Today, 9:42 AM');
  } finally {
    setFormatClock(null);
  }
});

test('format: wall-clock dates are deterministic and relative to the given clock', () => {
  const now = '2026-10-29T10:00';
  assert.equal(formatRecent('2026-10-29T09:42:00-07:00', now), '9:42 AM');
  assert.equal(formatRecent('2026-10-28T20:00:00-07:00', now), 'Yesterday');
  assert.equal(formatRecent('2026-10-26T08:00:00-07:00', now), 'Mon');
  assert.equal(formatRecent('2026-10-01T08:00:00-07:00', now), 'Oct 1');
  assert.equal(formatRecent('2025-10-01T08:00:00-07:00', now), 'Oct 1, 2025');
  assert.equal(formatSource('2026-10-29T10:00:00-07:00', now), 'Today, 10:00 AM');
  assert.equal(formatSource('2026-10-28T16:12:00-07:00', now), 'Yesterday, 4:12 PM');
  assert.equal(formatSource('2026-10-27T09:12:00-07:00', now), 'Oct 27');
  assert.equal(formatRecent('garbage', now), '');
});

test('Palette cursor: with nothing active ArrowDown lands first and ArrowUp last, then both wrap', () => {
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5'];
  assert.equal(nextActiveId(ids, undefined, 1), 'o1');
  assert.equal(nextActiveId(ids, undefined, -1), 'o5');
  assert.equal(nextActiveId(ids, 'gone', -1), 'o5');
  assert.equal(nextActiveId(ids, 'o5', 1), 'o1');
  assert.equal(nextActiveId(ids, 'o1', -1), 'o5');
  assert.equal(nextActiveId(ids, 'o3', -1), 'o2');
  assert.equal(nextActiveId([], undefined, 1), undefined);
});

test('Palette: a long breadcrumb keeps its text in a shrinkable span, the input stays in the field', () => {
  const long = 'Settings'.padEnd(80, 'x');
  const markup = html(palette({ trail: [long, 'AI providers'] }));
  assert.match(markup, /<li[^>]*><span class="ui-palette__trail-text">Settingsx+<\/span>/);
  assert.ok(markup.indexOf('ui-palette__trail') < markup.indexOf('ui-palette__input'));
});

test('AskTurn: provenance on hover only, local models say "on this Mac"; a daily limit is a quiet line', () => {
  const groq = html(turn({ provenance: { provider: 'Groq', local: false } }));
  assert.match(groq, /class="ui-ask-turn__answer"[^>]*title="Answer by Groq"/);
  assert.doesNotMatch(text(groq), /Answer by/);
  const local = html(turn({ provenance: { provider: 'Ollama', local: true } }));
  assert.match(local, /title="Answer by Ollama on this Mac"/);
  assert.doesNotMatch(html(turn()), /Answer by/);

  const paused = html(turn({ state: 'paused', answer: undefined, citations: [] }));
  assert.match(text(paused), /Paused for today\. Resumes tomorrow\./);
  assert.doesNotMatch(paused, /role="alert"/);
  assert.doesNotMatch(paused, /No source/);
  clean(paused);
  assert.doesNotMatch(text(paused), /Use another provider/);
  const other = html(
    turn({ state: 'paused', answer: undefined, citations: [], onUseAnotherProvider: noop }),
  );
  assert.match(text(other), /Paused for today\. Resumes tomorrow\. Use another provider/);
  assert.doesNotMatch(other, /role="alert"/);
});

test("Citation blocks the answer's provenance title, so only the quote tooltip shows on hover", () => {
  const markup = html(turn({ provenance: { provider: 'Groq', local: false } }));
  assert.match(markup, /<span class="ui-citation" title=""/);
});

test('An event citation without an event handler is inert instead of opening an empty thread', () => {
  const opened: unknown[] = [];
  openCitation({
    ...source1,
    kind: 'event',
    eventId: 'e1',
    threadId: '',
    onOpen: (id, index) => opened.push([id, index]),
  });
  assert.deepEqual(opened, []);
});

test('Citation clicks pass the citation number, for threads and for events', () => {
  const opened: unknown[] = [];
  const onOpen = (id: string, index: number) => opened.push(['thread', id, index]);
  const onOpenEvent = (id: string, index: number) => opened.push(['event', id, index]);
  openCitation({ ...source2, onOpen, onOpenEvent });
  openCitation({
    ...source1,
    index: 3,
    kind: 'event',
    eventId: 'e9',
    threadId: '',
    onOpen,
    onOpenEvent,
  });
  assert.deepEqual(opened, [
    ['thread', 't2', 2],
    ['event', 'e9', 3],
  ]);
});

test('Citation drops empty parts: no dangling separators when a field is missing', () => {
  const noSubject = html(<Citation {...source1} subject="" onOpen={noop} />);
  assert.match(text(noSubject), /Mina Cho · Mar 20, 2020$/);
  assert.match(noSubject, /aria-label="Source 1: Mina Cho"/);
  const bare = html(<Citation {...source1} from=" " subject="" date="" onOpen={noop} />);
  assert.doesNotMatch(text(bare), /·/);
  assert.match(bare, /aria-label="Source 1"/);
  const empty = html(<Citation {...source1} from="" subject="" date="" quote="" onOpen={noop} />);
  assert.doesNotMatch(empty, /role="tooltip"|aria-describedby/);
});
