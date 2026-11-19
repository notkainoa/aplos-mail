/**
 * Test support: the stand-in engine (F6) on a fake clock shared with the composer's timers, a `ComposeApi` over its
 * typed client, and read-only oracles on the engine's own rows. Tests only; nothing here ships, and nothing sends mail.
 */
import { createClient } from '@aplos/contract/client';
import {
  createFixtureEngine,
  defaultNow,
  fakeClock,
  type FixtureEngine,
} from '@aplos/contract-fixture';
import { fixtureControl, type FixtureControl } from '@aplos/contract-fixture/control';
import type { Draft, Message, Submission } from '../../../data';
import type { ComposeApi } from './composeApi';
import type { ComposeSession } from './session';

export interface StandInKit {
  readonly engine: FixtureEngine;
  readonly control: FixtureControl;
  readonly api: ComposeApi;
  readonly timers: { now(): number; setTimeout(callback: () => void, ms: number): () => void };
  readonly accountId: string;
  /** A thread with mail to reply to. */
  readonly threadId: string;
  readonly undoSeconds: number;
  /** Moves the shared clock: the engine's send timers and the composer's autosave fire in time order. */
  advance(ms: number): Promise<void>;
  /** The Mac sleeps for `ms`: no timer fires on the way, then due timers fire late (a held send turns suspended). */
  sleep(ms: number): Promise<void>;
  /** Lets in-flight calls answer. */
  settle(): Promise<void>;
  /** Every `Draft/set`, `Draft/destroy` and `Submission/set` the composer made, in order. */
  readonly calls: string[];
  draft(id: string): Draft | undefined;
  submissions(draftId: string): readonly Submission[];
  sentMessages(): readonly Message[];
  /** Feeds the engine's current rows for this session's draft and submission back to it, as the hooks would. */
  observe(session: ComposeSession): void;
}

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

/** A stand-in on the demo mailbox. `undoSeconds` sets Settings → Mail → Undo send first (the stand-in's default otherwise). */
export async function bootStandIn(seed = 1, undoSeconds?: number): Promise<StandInKit> {
  const clock = fakeClock(defaultNow);
  const engine = createFixtureEngine({ scenario: 'demo', clock, seed });
  const client = createClient(engine.connect());
  const store = engine.fixture.store;
  const calls: string[] = [];
  let n = 0;
  const mint = () => `test-op-${++n}`;
  const api: ComposeApi = {
    saveDraft: args => {
      calls.push(`Draft/set ${args.id ?? 'new'}`);
      return client.api.draft.set({ opId: mint(), ...args });
    },
    destroyDraft: args => {
      calls.push(`Draft/destroy ${args.id}`);
      return client.api.draft.destroy({ opId: mint(), ...args });
    },
    setSubmission: args => {
      calls.push(`Submission/set ${args.action.type}`);
      return client.api.submission.set({ opId: args.opId ?? mint(), action: args.action });
    },
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await nextTask();
  };
  if (undoSeconds !== undefined)
    await client.api.settings.set({
      opId: mint(),
      patch: { mail: { undoSendSeconds: undoSeconds } },
    });
  const account = store.all('Account')[0]!;
  const thread = store.all('Thread').find(t => t.accountId === account.id && t.messageCount > 0)!;
  const kit: StandInKit = {
    engine,
    control: fixtureControl(engine),
    api,
    timers: { now: () => clock.now(), setTimeout: (callback, ms) => clock.after(ms, callback) },
    accountId: account.id,
    threadId: thread.id,
    undoSeconds: store.get('Settings', 'settings')!.mail.undoSendSeconds,
    async advance(ms) {
      clock.advance(ms);
      await settle();
    },
    async sleep(ms) {
      clock.sleep(ms);
      await settle();
    },
    settle,
    calls,
    draft: id => store.get('Draft', id),
    submissions: draftId => store.all('Submission').filter(s => s.draftId === draftId),
    sentMessages: () => store.all('Message').filter(m => m.fromMe && m.date >= defaultNow),
    observe(session) {
      const state = session.getState();
      const id = state.save.draftId;
      if (id) session.dispatch({ type: 'observeDraft', draft: store.get('Draft', id) ?? null });
      const send = session.getState().send;
      const row = send.kind === 'tracking' ? store.get('Submission', send.submissionId) : undefined;
      if (row) session.dispatch({ type: 'observeSubmission', submission: row });
    },
  };
  return kit;
}
