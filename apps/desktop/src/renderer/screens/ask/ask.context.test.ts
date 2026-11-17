/**
 * The `Ask/run` context the dock sends (ask.context.ts) and the refusal it answers with (`ai.accountExcluded`):
 * the open draft's account is read at run start and goes only while a composer is open; the refusal shows the
 * dock's own line with a Settings action and hands the question back to the field. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/ask/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposeSession } from '../compose/runtime/session';
import { openDraftAccount } from '../compose/runtime/useComposeSession';
import { freshCompose, type ComposeState } from '../compose/model/composeState';
import { askContext, askRunArgs } from './ask.context';
import { dockView, initialAsk, runRefused, type AskInputs, type AskState } from './ask.model';
import { AskPanel, type AskPanelHandlers } from './AskPanel';

const noop = () => undefined;
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [{ id: 'groq', label: 'Groq', local: false, status: 'ready' }],
    askReady: true,
    askModel: { provider: 'groq', model: 'demo' },
    calendars: new Map(),
    suggestions: [],
    recents: [],
    ...extra,
  };
}

function running(question = 'What did Mina say?'): AskState {
  return {
    ...initialAsk,
    conversationId: 'conv-1',
    run: { clientId: 'c1', question, searchAll: false, stopped: false, settled: false },
  };
}

const session = (state: ComposeState): Pick<ComposeSession, 'getState'> => ({
  getState: () => state,
});

test('no draft open: the context carries the view and target but no draft', () => {
  const ctx = askContext({ target: null, screen: 'home' });
  assert.equal(ctx.view, 'home');
  assert.ok(!('draft' in ctx), 'no draft key at all while no composer is open');

  const onThread = askContext({
    target: { kind: 'thread', id: 't1', title: 'Mina' },
    screen: { label: 'thread' },
  });
  assert.equal(onThread.threadId, 't1');
  assert.equal(onThread.eventId, undefined);
});

test('a draft open sends its account; once the composer is gone nothing stale goes', () => {
  const shell = {
    target: null,
    screen: { label: 'compose' } as const,
    draftAccountId: 'acct-work',
  };
  const open = askContext(shell);
  assert.equal(open.view, 'compose');
  assert.deepEqual(open.draft, { accountId: 'acct-work' });

  // The composer closed between mount and this run: the read is fresh, so no account is sent.
  const closed = askContext({ ...shell, draftAccountId: undefined });
  assert.ok(!('draft' in closed));
});

test('the account read follows the open composer: closed and sending composers count for nothing', () => {
  const writing = freshCompose({ accountId: 'a1', mode: 'new' });
  assert.equal(openDraftAccount([]), undefined);
  assert.equal(openDraftAccount([session({ ...writing, open: false })]), undefined);
  assert.equal(openDraftAccount([session(writing)]), 'a1');
  // A compose page mounted over an inline reply is the draft being written now.
  const reply = freshCompose({ accountId: 'a2', mode: 'reply', threadId: 't1' });
  assert.equal(openDraftAccount([session(reply), session(writing)]), 'a1');
});

test('the run effect carries the context: question, scope, view, the draft account', () => {
  const args = askRunArgs(
    { question: 'Reply for me?', conversationId: 'conv-1', searchAll: true },
    { target: null, screen: { label: 'compose' }, draftAccountId: 'acct-work' },
    'Europe/Berlin',
  );
  assert.equal(args.question, 'Reply for me?');
  assert.equal(args.conversationId, 'conv-1');
  assert.deepEqual(args.scope, { searchAllMail: true });
  assert.deepEqual(args.context?.draft, { accountId: 'acct-work' });
  assert.equal(args.context?.view, 'compose');
  assert.equal(args.timeZone, 'Europe/Berlin');
});

test('the sidebar picker scopes the run: one account narrows, All accounts sends nothing', () => {
  // Account A picked: the run searches A only (the engine still refuses a kept-out id).
  const picked = askRunArgs(
    { question: 'invoices?', searchAll: false },
    { target: null, screen: 'home', accountScope: 'acct-work' },
    'UTC',
  );
  assert.deepEqual(picked.scope, { accountIds: ['acct-work'] });
  // The search-all toggle rides alongside the pick, not instead of it.
  const pickedAll = askRunArgs(
    { question: 'invoices?', searchAll: true },
    { target: null, screen: 'home', accountScope: 'acct-work' },
    'UTC',
  );
  assert.deepEqual(pickedAll.scope, { searchAllMail: true, accountIds: ['acct-work'] });
  // All accounts: no scope at all — the engine reads every AI-allowed account.
  const all = askRunArgs(
    { question: 'invoices?', searchAll: false },
    { target: null, screen: 'home', accountScope: null },
    'UTC',
  );
  assert.equal(all.scope, undefined);
});

test('an ai.accountExcluded refusal maps to the excluded turn and the question stays in the field', () => {
  const state = runRefused(running(), 'c1', {
    type: 'forbidden',
    reasonCode: 'ai.accountExcluded',
    message: 'off',
  });
  assert.equal(state.field, 'What did Mina say?');
  const view = dockView(state, inputs());
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].state, 'excluded');
  assert.equal(view.turns[0].question, 'What did Mina say?');
  assert.equal(view.working, false);
});

test('other refusals keep the generic failure: no exclusion, the field stays as typed', () => {
  const state = runRefused(running(), 'c1', {
    type: 'internal',
    reasonCode: 'ai.failed',
    message: 'nope',
  });
  assert.equal(state.field, '');
  assert.equal(dockView(state, inputs()).turns[0].state, 'failed');
});

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

test('the excluded turn shows the dock’s own line with a Settings action, never "didn’t answer"', () => {
  const state = runRefused(running(), 'c1', {
    type: 'forbidden',
    reasonCode: 'ai.accountExcluded',
    message: 'off',
  });
  const markup = renderToStaticMarkup(
    createElement(AskPanel, {
      view: dockView(state, inputs()),
      tab: 'ask',
      width: 360,
      today: null,
      handlers,
    }),
  );
  const rendered = text(markup);
  assert.match(rendered, /This account is turned off for AI/);
  assert.match(rendered, /Turn it on in Settings, or ask from another account/);
  assert.match(rendered, /Open Settings/);
  assert.doesNotMatch(rendered, /didn't answer/);
  assert.ok(!rendered.includes('!'));
});
