/**
 * The send fuzz (lane card criterion 5; plan 30 U6 "a fuzzer interleaves send, undo and fixture-engine restart"): 200
 * seeded sequences of 40 steps each interleave typing, waiting, send, double Return, a second composer pressing Send on
 * the same draft, Undo, Send now, the tray's other verbs, scripted send outcomes, the Mac sleeping, Esc, discard (asked,
 * confirmed or cancelled), send later, and a stand-in restart that drops the renderer's state without a flush. Two
 * racing ops act BEFORE the engine answers: `race` presses and then, in the same tick, presses again, undoes, sends
 * now, closes or has a second composer press; `restartPending` presses and restarts the stand-in while the send is
 * still pending. After every step it checks, against the engine's own rows:
 *
 * - never two submissions for one send (at most one live per draft, at most one sent, at most one new row per press);
 * - never a duplicate or missing tray (one composer shows at most one tray; a held send always shows it, after a reload
 *   too) and the drain matches the undo window (`undoSendSeconds`, varied per sequence);
 * - never a lost draft (the last text the engine confirmed is in the draft row, or the draft was sent, or discarded
 *   after the confirmation);
 * - Esc never discards (every `Draft/destroy` follows a confirmed "Discard this draft?");
 * - an Undo pressed before the engine answered, with no press after it, always undoes: the draft has no held send.
 *
 * Run: `cd apps/desktop && npx tsx --test src/renderer/screens/compose/sendFuzz.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFromDraft, freshCompose, type ComposeState } from './model/composeState';
import { htmlToText } from './model/fields';
import { replyDraftFor } from './model/reopen';
import { isLiveSubmission, phaseOf, sendView } from './model/sendState';
import { createComposeSession, type ComposeSession } from './runtime/session';
import { bootStandIn, type StandInKit } from './runtime/standinKit';

const SEQUENCES = 200;
const STEPS = 40;
const UNDO_CHOICES = [0, 5, 8, 10, 20, 30] as const;

/** mulberry32: small, fast, seeded. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPS = [
  ['type', 6],
  ['wait', 5],
  ['send', 4],
  ['double', 2],
  ['twin', 1],
  ['sendLater', 1],
  ['undo', 3],
  ['sendNow', 1],
  ['trayAction', 2],
  ['outcome', 1],
  ['sleep', 1],
  ['escape', 2],
  ['reopen', 2],
  ['discardAsk', 1],
  ['discardConfirm', 1],
  ['discardCancel', 1],
  ['restart', 2],
  ['race', 4],
  ['restartPending', 2],
] as const;

type Op = (typeof OPS)[number][0];
const PRESSES: ReadonlySet<Op> = new Set([
  'send',
  'double',
  'twin',
  'sendLater',
  'trayAction',
  'race',
  'restartPending',
]);
const TOTAL_WEIGHT = OPS.reduce((sum, [, weight]) => sum + weight, 0);
const ALPHABET = 'abc xyz\n&<>';
const ME = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };

/** What the run reached, so a fuzz that stopped exercising a state fails instead of passing quietly. */
const reached = new Map<string, number>();

function count(key: string): void {
  reached.set(key, (reached.get(key) ?? 0) + 1);
}

interface World {
  readonly kit: StandInKit;
  readonly random: () => number;
  readonly undoSeconds: number;
  session: ComposeSession;
  /** The last text the engine confirmed for each draft. */
  readonly confirmed: Map<string, string>;
  readonly discarded: Set<string>;
  readonly drafts: Set<string>;
  confirms: number;
  /** Second composers that pressed Send in the last op (each may make one submission of its own). */
  twins: number;
  readonly log: string[];
}

function pickOp(random: () => number): Op {
  let roll = random() * TOTAL_WEIGHT;
  for (const [op, weight] of OPS) {
    roll -= weight;
    if (roll < 0) return op;
  }
  return 'wait';
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function randomText(random: () => number): string {
  const length = 1 + Math.floor(random() * 6);
  let text = '';
  for (let i = 0; i < length; i++) text += pick(random, [...ALPHABET]);
  return text;
}

function freshReply(kit: StandInKit): ComposeState {
  const context = { accountId: kit.accountId, mode: 'reply' as const, threadId: kit.threadId };
  return freshCompose(context, { to: [ME], cc: [], bcc: [], subject: 'Re: plans', body: '' });
}

function openSession(kit: StandInKit, initial: ComposeState): ComposeSession {
  return createComposeSession({ api: kit.api, timers: kit.timers }, initial);
}

/** What the reader would mount after a reload: the thread's send or reply draft from the engine, else a fresh reply. */
function reopenAfterRestart(world: World): ComposeSession {
  const store = world.kit.engine.fixture.store;
  const drafts = store.all('Draft').filter(d => !d.submissionId);
  const live = store.all('Submission').filter(isLiveSubmission);
  const id = replyDraftFor(world.kit.threadId, drafts, live);
  const draft = id ? store.get('Draft', id) : undefined;
  return openSession(world.kit, draft ? composeFromDraft(draft) : freshReply(world.kit));
}

function press(world: World, extra: { notBefore?: number } = {}) {
  const now = world.kit.timers.now();
  world.session.dispatch({ type: 'send', now, undoSeconds: world.undoSeconds, ...extra });
}

async function twinPress(world: World) {
  const id = world.session.getState().save.draftId;
  const draft = id ? world.kit.draft(id) : undefined;
  if (!draft) return;
  const twin = openSession(world.kit, composeFromDraft(draft));
  twin.dispatch({ type: 'send', now: world.kit.timers.now(), undoSeconds: world.undoSeconds });
  press(world);
  await world.kit.settle();
  twin.dispose();
}

function trayAction(world: World) {
  const state = world.session.getState();
  const view = sendView(phaseOf(state.send, world.kit.timers.now(), true), String);
  if (view.actions.length === 0) return;
  const action = pick(world.random, view.actions);
  const notBefore = world.kit.timers.now() + 2 * 3_600_000;
  world.session.dispatch({ type: 'action', action, notBefore });
}

const RACERS = ['press', 'undo', 'undo', 'sendNow', 'escape', 'twin'] as const;

/** One verb in the same tick as the press, before any answer. Returns true when it was an Undo of a pending send. */
function racer(world: World, verb: (typeof RACERS)[number], twins: ComposeSession[]): boolean {
  const pending = world.session.getState().send.kind === 'pending';
  if (verb === 'press') press(world);
  if (verb === 'undo') world.session.dispatch({ type: 'action', action: 'undo' });
  if (verb === 'sendNow') world.session.dispatch({ type: 'action', action: 'sendNow' });
  if (verb === 'escape') world.session.dispatch({ type: 'escape' });
  if (verb === 'twin') twins.push(twinOf(world));
  return verb === 'undo' && pending;
}

/** A second composer on the same draft pressing Send at once. */
function twinOf(world: World): ComposeSession {
  const id = world.session.getState().save.draftId;
  const draft = id ? world.kit.draft(id) : undefined;
  const twin = openSession(world.kit, draft ? composeFromDraft(draft) : freshReply(world.kit));
  twin.dispatch({ type: 'send', now: world.kit.timers.now(), undoSeconds: world.undoSeconds });
  return twin;
}

/** Press, then up to three verbs before the engine answers; an Undo of the pending send must win. */
async function race(world: World) {
  press(world);
  let undone = false;
  const twins: ComposeSession[] = [];
  const burst = 1 + Math.floor(world.random() * 3);
  for (let i = 0; i < burst; i++) {
    const verb = pick(world.random, RACERS);
    const undid = racer(world, verb, twins);
    // A press of this composer while its send is pending changes nothing, so the Undo still stands; a second
    // composer's press is a send of its own.
    if (verb === 'twin') undone = false;
    if (undid) undone = true;
  }
  const draftId = world.session.getState().save.draftId;
  for (let i = 0; i < 2; i++) {
    await world.kit.settle();
    world.kit.observe(world.session);
  }
  await world.kit.settle();
  for (const twin of twins) twin.dispose();
  world.twins = twins.length;
  if (!undone || !draftId) return;
  count('race undo before the answer');
  const held = world.kit
    .submissions(draftId)
    .filter(s => s.state === 'queued' || s.state === 'scheduled');
  assert.equal(held.length, 0, 'an Undo pressed before the answer was lost');
}

/** Press, then the stand-in restarts while the send is still pending (the call in flight or not yet made). */
async function restartPending(world: World) {
  press(world);
  if (world.random() < 0.5) await Promise.resolve();
  await restart(world);
}

async function restart(world: World) {
  const send = world.session.getState().send;
  if (send.kind !== 'none') count(`restart during ${send.kind}`);
  // A crash: no flush, the renderer's state is gone; the engine voids every window.
  world.session.dispose();
  await world.kit.control.reset({ reason: 'restart' });
  world.session = reopenAfterRestart(world);
}

async function apply(world: World, op: Op): Promise<void> {
  const { kit, session, random } = world;
  const now = kit.timers.now();
  switch (op) {
    case 'type':
      return session.dispatch({
        type: 'edit',
        patch: { body: session.getState().fields.body + randomText(random) },
        now,
      });
    case 'wait':
      return kit.advance(Math.floor(random() * 3_000));
    case 'send':
      return press(world);
    case 'double':
      press(world);
      return press(world);
    case 'twin':
      return twinPress(world);
    case 'sendLater':
      return press(world, { notBefore: now + 3_600_000 });
    case 'undo':
      return session.dispatch({ type: 'action', action: 'undo' });
    case 'sendNow':
      return session.dispatch({ type: 'action', action: 'sendNow' });
    case 'trayAction':
      return trayAction(world);
    case 'outcome':
      await kit.control.nextSendOutcome({
        outcome: pick(random, ['sent', 'uncertain', 'failed'] as const),
      });
      return;
    case 'sleep':
      return kit.sleep(6 * 60_000);
    case 'escape':
      return session.dispatch({ type: 'escape' });
    case 'reopen':
      return session.dispatch({ type: 'reopen' });
    case 'discardAsk':
      return session.dispatch({ type: 'askDiscard' });
    case 'discardConfirm':
      if (session.getState().confirm !== 'discard') return;
      world.confirms++;
      return session.dispatch({ type: 'confirmDiscard' });
    case 'discardCancel':
      return session.dispatch({ type: 'cancelDiscard' });
    case 'restart':
      return restart(world);
    case 'race':
      return race(world);
    case 'restartPending':
      return restartPending(world);
  }
}

function submissionCount(world: World): number {
  return world.kit.engine.fixture.store.all('Submission').length;
}

function note(world: World): void {
  const state = world.session.getState();
  const id = state.save.draftId;
  if (!id) return;
  world.drafts.add(id);
  if (state.ended === 'discarded') world.discarded.add(id);
  const clean = state.save.savedSeq === state.save.editSeq && state.save.flightSeq === null;
  if (clean && !state.discarding && world.kit.draft(id)) world.confirmed.set(id, state.fields.body);
}

function checkSubmissions(world: World, op: Op, before: number): void {
  for (const id of world.drafts) {
    const rows = world.kit.submissions(id);
    assert.ok(rows.filter(isLiveSubmission).length <= 1, `two live sends of ${id}`);
    assert.ok(rows.filter(r => r.state === 'sent').length <= 1, `two sent copies of ${id}`);
  }
  const made = submissionCount(world) - before;
  const allowed = (PRESSES.has(op) ? 1 : 0) + world.twins;
  assert.ok(made <= allowed, `${op} made ${made} submissions`);
}

function checkTray(world: World): void {
  const state = world.session.getState();
  const now = world.kit.timers.now();
  const view = sendView(phaseOf(state.send, now, true), String);
  if (view.tray) assert.equal(state.open, false, 'a tray and an open composer at once');
  if (view.tray?.kind === 'sending') {
    assert.equal(view.tray.totalSeconds, world.undoSeconds, 'the drain spans the undo window');
    assert.ok(view.tray.secondsLeft >= 0 && view.tray.secondsLeft <= view.tray.totalSeconds);
  }
  const id = state.save.draftId;
  const held = id
    ? world.kit.submissions(id).find(s => s.state === 'queued' && now < s.notBefore)
    : undefined;
  if (held) assert.equal(view.tray?.kind, 'sending', 'a held send shows its tray');
}

function checkDrafts(world: World): void {
  for (const [id, text] of world.confirmed) {
    if (world.discarded.has(id)) continue;
    const draft = world.kit.draft(id);
    if (draft) {
      assert.equal(htmlToText(draft.html), text, `draft ${id} lost its confirmed text`);
      continue;
    }
    const sent = world.kit.submissions(id).some(s => s.state === 'sent');
    assert.ok(sent, `draft ${id} is gone without being sent or discarded`);
  }
  const destroys = world.kit.calls.filter(call => call.startsWith('Draft/destroy')).length;
  assert.ok(destroys <= world.confirms, 'a draft was destroyed without the confirmation');
}

async function step(world: World, index: number): Promise<void> {
  const op = pickOp(world.random);
  world.log.push(`${index}:${op}`);
  world.twins = 0;
  const before = submissionCount(world);
  const draftBefore = world.session.getState().save.draftId;
  const existedBefore = draftBefore ? world.kit.draft(draftBefore) !== undefined : false;
  await apply(world, op);
  await world.kit.settle();
  world.kit.observe(world.session);
  world.kit.observe(world.session);
  note(world);
  count(`phase ${phaseOf(world.session.getState().send, world.kit.timers.now(), true).kind}`);
  checkSubmissions(world, op, before);
  checkTray(world);
  checkDrafts(world);
  if (op === 'escape' && existedBefore)
    assert.ok(world.kit.draft(draftBefore!), 'Esc removed the draft');
}

async function runSequence(seed: number): Promise<void> {
  const random = rng(seed);
  const undoSeconds = pick(random, UNDO_CHOICES);
  const kit = await bootStandIn(1, undoSeconds);
  const world: World = {
    kit,
    random,
    undoSeconds,
    session: openSession(kit, freshReply(kit)),
    confirmed: new Map(),
    discarded: new Set(),
    drafts: new Set(),
    confirms: 0,
    twins: 0,
    log: [],
  };
  try {
    for (let i = 0; i < STEPS; i++) await step(world, i);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `seed ${seed} (undo ${undoSeconds} s) after ${world.log.join(' ')}: ${message}`,
    );
  } finally {
    world.session.dispose();
  }
}

const MUST_REACH = [
  'phase held',
  'phase sent',
  'phase failed',
  'phase uncertain',
  'phase suspended',
  'phase scheduled',
  'phase idle',
  'restart during tracking',
  'restart during pending',
  'race undo before the answer',
] as const;

test(`send fuzz: ${SEQUENCES} sequences x ${STEPS} steps keep one send, one tray, every draft, and ask before discarding`, async () => {
  for (let seed = 1; seed <= SEQUENCES; seed++) await runSequence(seed);
  for (const key of MUST_REACH)
    assert.ok((reached.get(key) ?? 0) > 0, `the fuzz never reached ${key}`);
  console.log(
    [...reached]
      .sort()
      .map(([key, n]) => `${key}: ${n}`)
      .join(', '),
  );
});
