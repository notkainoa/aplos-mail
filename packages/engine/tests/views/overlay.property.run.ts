import assert from 'node:assert/strict';
import { incoming, worldEngine, type TestEngine } from './harness';
import { inboxIds, nextOp, openOps, settle } from './acts';
import { BIG_NOW } from './big';
import { rng } from './world';

/*
 * The "stale overlay" attack (plan 10 E3 (b)): random interleavings of commands, provider progress, mail arriving and
 * the order in which a client sees receipts and frames, against a model of the Inbox. A tiny client overlay (what plan 30's
 * `optimistic.ts` does: apply a receipt's effect to the newest frame until a frame reaches the receipt's state) must never
 * show a thread in a place the engine never had it since the client's last frame, never let an old frame bring a handled
 * thread back, and must equal the engine once it has caught up.
 *
 * The run is split over `overlay.property.<n>.test.ts` (8 parts of 15 seeds by default, 120 in all; `APLOS_VIEWS_PROPERTY`
 * sets the total) so the CI shards spread it: no part runs for more than about 40 s.
 */

export const SEQUENCES = Number(process.env.APLOS_VIEWS_PROPERTY ?? 120);
const STEPS = 30;

type Move = 'done' | 'trash' | 'spam' | 'restore';

/** The engine's Inbox as the model sees it, from the seq it was true at. */
interface Entry {
  seq: number;
  inbox: ReadonlySet<string>;
}

interface Receipt {
  seq: number;
  thread: string;
  inInbox: boolean;
}

/** The model: which threads are in the Inbox, by what each command does to a thread. */
class Model {
  inbox: Set<string>;
  readonly history: Entry[] = [];
  /** Undo stack: the operation, and whether its thread was in the Inbox before it. */
  readonly stack: { opId: string; thread: string; before: boolean }[] = [];

  constructor(initial: string[], seq: number) {
    this.inbox = new Set(initial);
    this.history.push({ seq, inbox: new Set(this.inbox) });
  }

  record(seq: number) {
    this.history.push({ seq, inbox: new Set(this.inbox) });
  }

  /** The Inbox the engine had at `seq`. */
  at(seq: number): ReadonlySet<string> {
    let found = this.history[0]!;
    for (const e of this.history) if (e.seq <= seq) found = e;
    return found.inbox;
  }

  /** Every state of `thread` the engine had from `seq` on. */
  since(thread: string, seq: number): Set<boolean> {
    const out = new Set<boolean>([this.at(seq).has(thread)]);
    for (const e of this.history) if (e.seq > seq) out.add(e.inbox.has(thread));
    return out;
  }
}

/** The client: the newest frame, and the receipts no frame has reached yet laid over it. */
class Client {
  frame: { seq: number; ids: Set<string> };
  pending: Receipt[] = [];

  constructor(seq: number, ids: string[]) {
    this.frame = { seq, ids: new Set(ids) };
  }

  onFrame(seq: number, ids: string[]) {
    this.frame = { seq, ids: new Set(ids) };
    this.pending = this.pending.filter(r => r.seq > seq);
  }

  onReceipt(r: Receipt) {
    if (r.seq > this.frame.seq) this.pending.push(r);
  }

  shown(): Set<string> {
    const out = new Set(this.frame.ids);
    for (const r of this.pending) {
      if (r.inInbox) out.add(r.thread);
      else out.delete(r.thread);
    }
    return out;
  }
}

async function runSequence(seed: number) {
  const r = rng(seed * 7919 + 13);
  const t: TestEngine & { world: unknown; close(): Promise<void> } = await worldEngine(seed, 40);
  try {
    const win = await t.call('View/watch', {
      spec: { kind: 'mailbox', role: 'inbox' },
      limit: 200,
    });
    const model = new Model(win.ids, win.state.seq);
    const client = new Client(win.state.seq, win.ids);
    const frames: { seq: number; ids: string[] }[] = [];
    t.session.subscribe(f => {
      if (f.frame === 'window' && f.windowId === win.windowId)
        frames.push({ seq: f.state.seq, ids: f.ids });
    });
    const receipts: Receipt[] = [];
    const pool = [...win.ids];
    let arrivals = 0;

    const verifyFrame = (f: { seq: number; ids: string[] }) =>
      assert.deepEqual(
        new Set(f.ids),
        model.at(f.seq),
        `seed ${seed}: a frame at seq ${f.seq} shows the Inbox the engine had then`,
      );
    const checkClient = () => {
      const shown = client.shown();
      for (const id of pool)
        assert.ok(
          model.since(id, client.frame.seq).has(shown.has(id)),
          `seed ${seed}: ${id} is shown ${shown.has(id) ? 'in' : 'out of'} the Inbox, which the engine never had since seq ${client.frame.seq}`,
        );
      if (!client.pending.length)
        assert.deepEqual(shown, model.at(client.frame.seq), `seed ${seed}: caught up`);
    };
    /** The client sees the next receipt or frame, in a random order between the two streams. */
    const deliver = () => {
      const canFrame = frames.length > 0;
      const canReceipt = receipts.length > 0;
      if (!canFrame && !canReceipt) return;
      if (canFrame && (!canReceipt || r.chance(0.5))) {
        const f = frames.shift()!;
        verifyFrame(f);
        client.onFrame(f.seq, f.ids);
      } else client.onReceipt(receipts.shift()!);
      checkClient();
    };

    const move = async (kind: Move) => {
      const thread = r.pick(pool);
      const before = model.inbox.has(thread);
      const opId = nextOp(`p${seed}`);
      const action = kind === 'restore' ? { type: 'restore' as const } : { type: kind };
      const receipt = await t.call('Thread/act', { opId, ids: [thread], action });
      if (kind === 'restore') model.inbox.add(thread);
      else model.inbox.delete(thread);
      model.record(receipt.appliedState.seq);
      model.stack.push({ opId, thread, before });
      receipts.push({
        seq: receipt.appliedState.seq,
        thread,
        inInbox: model.inbox.has(thread),
      });
    };
    const undo = async () => {
      const top = model.stack.pop();
      if (!top) return;
      const receipt = await t.call('Operation/undo', {
        opId: top.opId,
        undoOpId: nextOp(`u${seed}`),
      });
      if (top.before) model.inbox.add(top.thread);
      else model.inbox.delete(top.thread);
      model.record(receipt.appliedState.seq);
      receipts.push({ seq: receipt.appliedState.seq, thread: top.thread, inInbox: top.before });
    };
    const arrive = () => {
      const thread = `arrival-${seed}-${arrivals++}`;
      const result = t.commit([incoming(thread, { date: BIG_NOW + arrivals * 1_000 })], 'sync');
      const id = `acct-1:${thread}`;
      pool.push(id);
      model.inbox.add(id);
      model.record(result.seq);
    };

    for (let step = 0; step < STEPS; step++) {
      const roll = r.int(100);
      if (roll < 28) await move('done');
      else if (roll < 38) await move('trash');
      else if (roll < 44) await move('spam');
      else if (roll < 56) await move('restore');
      else if (roll < 72) await undo();
      else if (roll < 82) arrive();
      else if (roll < 90) settle(t, r.chance(0.8) ? 'synced' : 'inflight');
      else await t.advance(r.int(700));
      for (let k = r.int(4); k > 0; k--) deliver();
      if (r.chance(0.3)) await t.advance(r.int(400));
    }
    // Everything the client was told arrives, and the engine settles.
    await t.advance(600);
    while (frames.length || receipts.length) deliver();
    assert.deepEqual(
      client.shown(),
      model.inbox,
      `seed ${seed}: the client ends on the engine's Inbox`,
    );
    assert.deepEqual(
      new Set(await inboxIds(t)),
      model.inbox,
      `seed ${seed}: and the model matches the store`,
    );
    assert.ok(
      openOps(t.store).every(o => o.payload),
      'every queued op is one the provider lane can drain',
    );
  } finally {
    await t.close();
  }
}

/** The seed range part `part` of `of` covers, out of `SEQUENCES` in all (seeds count from 1). */
export function seedRange(part: number, of: number) {
  const per = Math.ceil(SEQUENCES / of);
  return { first: (part - 1) * per + 1, last: Math.min(part * per, SEQUENCES) };
}

/** Runs the seeds of one part: the property test files each cover a slice so the CI shards can spread them. */
export async function runPart(part: number, of: number) {
  const { first, last } = seedRange(part, of);
  for (let seed = first; seed <= last; seed++) await runSequence(seed);
}
