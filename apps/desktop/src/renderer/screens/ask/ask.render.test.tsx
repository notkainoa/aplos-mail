/**
 * Render checks for the dock's states through `AskPanel` + `dockView` (renderToStaticMarkup, no DOM): citation
 * numbering, the queued card, the paused and stopped lines, and the design bans — no sparkle, wand or star glyph, no
 * exclamation marks, and never a character of a key anywhere in the markup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Citation, ProgressFrame, Proposal } from '../../data';
import { dockView, initialAsk, type AskInputs, type AskState } from './ask.model';
import { AskPanel, type AskPanelHandlers } from './AskPanel';
import { ConsentLine } from './AskConsent';

const noop = () => undefined;
const html = (element: ReactElement) => renderToStaticMarkup(element);
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const BANNED = [
  /sparkle/i,
  /wand/i,
  /✨|⭐|★|☆|🪄|🤖|🧠/,
  /magic/i,
  /AI-powered/i,
  /Copilot/i,
  /Ask me anything/i,
  /Hold to talk/i,
  /\bTodo\b/,
  /\bbeta\b/i,
];
/** Any string that even looks like a secret must never appear. */
const KEY_CHARS = /\bsk-[A-Za-z0-9_-]{8,}|\bapi[_-]?key\b|\bbearer [a-z0-9]{8,}|\bxox[baprs]-/i;

function clean(markup: string) {
  const rendered = text(markup);
  assert.ok(!rendered.includes('!'), `an exclamation mark in: ${rendered.slice(0, 200)}`);
  for (const pattern of [...BANNED, KEY_CHARS]) {
    assert.ok(!pattern.test(markup), `${pattern} rendered`);
  }
}

const handlers: AskPanelHandlers = {
  onTabChange: noop,
  onClose: noop,
  onWidthChange: noop,
  onOpenSettings: noop,
  onChange: noop,
  onSubmit: noop,
  onStop: noop,
  onQueuedChange: noop,
  onSendQueuedNow: noop,
  onPickSuggestion: noop,
  onOpenRecent: noop,
  onToggleSteps: noop,
  onOpenCitation: noop,
  onOpenEventCitation: noop,
  onRetry: noop,
  onUseAnotherProvider: noop,
  onConfirmProposal: noop,
  onDismissProposal: noop,
};

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [{ id: 'groq', label: 'Groq', local: false, status: 'ready' }],
    askReady: true,
    askModel: { provider: 'groq', model: 'demo-model-1' },
    calendars: new Map(),
    suggestions: ['What needs a reply today?'],
    recents: [{ id: 'r1', title: 'Old chat', updatedAt: Date.now() - 3_600_000 }],
    ...extra,
  };
}

let seq = 0;
function frame(kind: ProgressFrame['kind'], extra: Partial<ProgressFrame> = {}): ProgressFrame {
  seq += 1;
  return {
    frame: 'progress',
    dbEpoch: 'demo',
    seq,
    runId: 'r1',
    source: 'ask',
    kind,
    turnId: 'turn-1',
    ...extra,
  } as ProgressFrame;
}

const cite = (n: number): Citation => ({
  kind: 'message',
  n,
  messageId: `m${n}`,
  threadId: `t${n}`,
  quote: `quote ${n}`,
  fromName: 'Mina',
  date: Date.now(),
  subject: 'Hollow Creek',
});

function running(queued: string[] = []): AskState {
  return {
    ...initialAsk,
    conversationId: 'conv-1',
    run: {
      clientId: 'c1',
      question: 'q?',
      searchAll: false,
      runId: 'r1',
      stopped: false,
      settled: false,
    },
    queued: queued.map((text, i) => ({ id: `q${i}`, text, searchAll: false })),
  };
}

function panel(state: AskState, input: AskInputs, tab: 'ask' | 'today' = 'ask') {
  return html(
    <AskPanel
      view={dockView(state, input)}
      tab={tab}
      width={360}
      today={<div>today</div>}
      handlers={handlers}
    />,
  );
}

test('answered turn: numbered citation chips, serif answer, provenance on hover only', () => {
  const frames = [
    frame('text', { delta: 'Mina says Thursday. ' }),
    frame('citation', { citation: cite(1) }),
    frame('done'),
  ];
  const markup = panel(running(), inputs({ frames }));
  clean(markup);
  assert.ok(markup.includes('[1]'));
  assert.ok(markup.includes('quote 1'));
  assert.ok(markup.includes('Answer by Groq'));
});

test('queued follow-up while streaming renders an editable card with the send-now hint', () => {
  const markup = panel(
    running(['And is Mina free then?']),
    inputs({ frames: [frame('text', { delta: 'working ' })] }),
  );
  clean(markup);
  assert.ok(text(markup).includes('And is Mina free then?'));
  assert.ok(text(markup).includes('Queued'));
});

test('empty view: suggestions, a recent chat and the placeholder, still clean', () => {
  const markup = panel(initialAsk, inputs());
  clean(markup);
  assert.ok(text(markup).includes('What needs a reply today?'));
  assert.ok(text(markup).includes('Old chat'));
  assert.ok(markup.includes('Ask about your mail or calendar'));
});

test('stopped, failed, paused and no-provider states all render their plain lines', () => {
  const live = running();
  const stopped = { ...live, run: { ...live.run!, stopped: true, settled: true } };
  clean(panel(stopped, inputs({ frames: [frame('text', { delta: 'half' })] })));
  assert.ok(
    text(panel(stopped, inputs({ frames: [frame('text', { delta: 'half' })] }))).includes(
      'Stopped.',
    ),
  );
  const failed = panel(
    running(),
    inputs({ frames: [frame('error', { problem: { reasonCode: 'ai.unreachable' } })] }),
  );
  clean(failed);
  assert.ok(text(failed).includes("Groq didn't answer."));
  const paused = panel(
    running(),
    inputs({ frames: [frame('error', { problem: { reasonCode: 'ai.dailyCap' } })] }),
  );
  clean(paused);
  assert.ok(text(paused).includes('Paused for today. Resumes tomorrow.'));
  const noprov = panel(initialAsk, inputs({ askReady: false }));
  clean(noprov);
  assert.ok(text(noprov).includes('Ask needs an AI key.'));
});

test('the proposal card shows its consequence and the consent line names provider and model', () => {
  const proposal: Proposal = {
    kind: 'triage',
    id: 'p1',
    consequence: 'Move 3 emails to Later',
    state: 'open',
    threadIds: ['t1'],
    action: { type: 'later' },
  };
  const markup = panel(
    running(),
    inputs({ frames: [frame('proposal', { proposal }), frame('done')] }),
  );
  clean(markup);
  assert.ok(text(markup).includes('Move 3 emails to Later'));
  const consent = html(
    <ConsentLine
      provider="Groq"
      model="llama-3.3-70b"
      local={false}
      onAllow={noop}
      onNotNow={noop}
    />,
  );
  clean(consent);
  assert.ok(text(consent).includes('Groq · llama-3.3-70b'));
});
