import { ContractError } from '@aplos/contract/contract-error';
import type { Fixture } from './engine';
import type { ControlArgs, Knob } from './control-types';
import { setupTick } from './methods/account';
import { nextMidnight } from './methods/ai';
import { clean, must } from './methods/util';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const ok = { ok: true as const };
const meta = (fx: Fixture) => must(fx.store, 'Meta', 'meta');

/** One knob's implementation: the fixture plus that knob's narrowed args. */
type KnobHandler<K extends Knob> = (
  fx: Fixture,
  args: Extract<ControlArgs, { knob: K }>,
) => unknown;

/** Every knob, as small independent functions; the dispatcher below looks them up by `args.knob`. */
const knobs: { [K in Knob]: KnobHandler<K> } = {
  setAccountStatus: (fx, args) => {
    const a = must(fx.store, 'Account', args.accountId, 'No such account.');
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put('Account', {
        ...a,
        health: clean({
          ...a.health,
          status: args.status,
          reasonCode: args.reasonCode,
          reconnectBy: args.reconnectBy ?? a.health.reconnectBy,
        }),
      }),
    );
    return ok;
  },
  pauseAccount: (fx, args) => {
    const a = must(fx.store, 'Account', args.accountId, 'No such account.');
    const until = fx.now + args.forMs;
    const reasonCode = args.reasonCode ?? 'rate.minute';
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Account', {
        ...a,
        health: {
          ...a.health,
          status: {
            state: 'paused',
            until,
            class: args.class ?? 'throttle',
            reason: args.reason ?? 'rateLimitExceeded',
          },
          reasonCode,
        },
      });
      const r = tx.get('Setup', a.id);
      if (r && r.state !== 'ready')
        tx.put('Setup', { ...r, state: 'paused', pausedUntil: until, reasonCode });
    });
    fx.clock.after(args.forMs, () => {
      const now = fx.store.get('Account', a.id);
      if (now?.health.status.state === 'paused' && now.health.status.until === until)
        fx.write({ kind: 'Fixture/resume' }, tx =>
          tx.put('Account', {
            ...now,
            health: clean({
              ...now.health,
              status: { state: 'ok' as const },
              reasonCode: undefined,
            }),
          }),
        );
    });
    return ok;
  },
  failNextWrite: (fx, args) => {
    fx.failures.push({
      mode: args.mode ?? 'afterReceipt',
      type: args.type ?? 'providerError',
      message: args.message ?? 'Gmail did not accept this change. Try again.',
      reasonCode: args.reasonCode,
      afterMs: args.afterMs ?? 500,
    });
    return ok;
  },
  setSubmissionState: (fx, args) => {
    const s = must(fx.store, 'Submission', args.submissionId, 'No such submission.');
    if (!['queued', 'scheduled', 'sending'].includes(args.state)) {
      fx.runs.get(s.id)?.();
      fx.runs.delete(s.id);
    }
    const { problem: _, ...rest } = s;
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put(
        'Submission',
        clean({
          ...rest,
          state: args.state,
          problem: args.problem ? { ...args.problem, at: fx.now } : undefined,
        }),
      ),
    );
    return ok;
  },
  nextSendOutcome: (fx, args) => {
    fx.sendOutcomes.push(args.outcome);
    return ok;
  },
  advanceSetup: (fx, args) => {
    const ids = args.accountId ? [args.accountId] : fx.store.all('Setup').map(r => r.id);
    for (const id of ids) {
      if (args.to) {
        setupTick(fx, id, args.to);
        if (args.reasonCode) {
          const r = fx.store.get('Setup', id)!;
          fx.write({ kind: 'Fixture/control' }, tx =>
            tx.put('Setup', { ...r, reasonCode: args.reasonCode }),
          );
        }
      } else for (let i = 0; i < (args.steps ?? 1); i++) setupTick(fx, id);
    }
    return ok;
  },
  setClock: async (fx, args) => {
    fx.clock.set(args.now);
    fx.emit({ frame: 'host', event: { type: 'clock', now: fx.now } });
    await settle();
    return { now: fx.now };
  },
  askScript: (fx, args) => {
    const { knob: _, ...script } = args;
    fx.askScripts.push(script);
    return ok;
  },
  failNextAi: (fx, args) => {
    fx.aiFailures.set(args.feature, clean({ reasonCode: args.reasonCode, message: args.message }));
    return ok;
  },
  searchRemote: (fx, args) => {
    const { knob: _, ...script } = args;
    fx.searchScripts.push(script);
    return ok;
  },
  transcribeResult: (fx, args) => {
    fx.transcripts.push(args.text);
    return ok;
  },
  calendarChange: async (fx, args) => {
    const e = fx.store.get('Event', args.eventId);
    if (!e) throw new Error(`No event ${args.eventId}.`);
    const { types } = fx.store.commit(tx =>
      args.removed
        ? tx.del('Event', e.id)
        : tx.put('Event', { ...e, ...args.patch, sync: 'synced' }),
    );
    fx.changed(types);
    await settle();
    return ok;
  },
  resolveConnect: async (fx, args) => {
    const { knob: _, connectId, delayMs, ...outcome } = args;
    if (!connectId)
      fx.connectScripts.push({ ...outcome, ...(delayMs !== undefined ? { delayMs } : {}) });
    else {
      const live = fx.connects.get(connectId);
      if (!live) throw new Error(`No connect flow ${connectId} is waiting.`);
      if (delayMs) fx.clock.after(delayMs, () => live.finish(outcome));
      else live.finish(outcome);
    }
    await settle();
    return ok;
  },
  advanceClock: async (fx, args) => {
    fx.clock.advance(args.ms);
    await settle();
    return { now: fx.now };
  },
  sleep: async (fx, args) => {
    fx.clock.sleep(args.ms);
    fx.emit({ frame: 'host', event: { type: 'clock', now: fx.now } });
    await settle();
    return { now: fx.now };
  },
  setOrdering: (fx, args) => {
    fx.ordering = { ...args.ordering };
    return ok;
  },
  replay: (fx, args) => {
    for (const frame of args.frames) fx.emit(frame as never);
    return ok;
  },
  reset: (fx, args) => {
    fx.reset(args.reason);
    return ok;
  },
  compactLog: fx => {
    fx.store.compact();
    return ok;
  },
  park: (fx, args) => {
    const parked = {
      reasonCode: args.reasonCode,
      message: args.message,
      at: fx.now,
      canRetry: args.canRetry ?? true,
    };
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put('Meta', { ...meta(fx), engine: { state: 'parked', parked } }),
    );
    fx.emit({
      frame: 'host',
      event: {
        type: 'parked',
        reasonCode: parked.reasonCode,
        message: parked.message,
        canRetry: parked.canRetry,
        at: parked.at,
      },
    });
    return ok;
  },
  unpark: fx => {
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put('Meta', { ...meta(fx), engine: { state: 'ready' } }),
    );
    return ok;
  },
  hostEvent: (fx, args) => {
    fx.emit({ frame: 'host', event: args.event });
    return ok;
  },
  draftChanged: (fx, args) => {
    const d = must(fx.store, 'Draft', args.draftId, 'No such draft.');
    const revision = d.revision + 1;
    const { value } = fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put(
        'Draft',
        args.conflict
          ? { ...d, conflict: { theirsRevision: revision, at: fx.now, device: 'MacBook Air' } }
          : { ...d, revision, updatedAt: fx.now, sync: 'synced' },
      ),
    );
    fx.emit({
      frame: 'Draft/changed',
      draftId: d.id,
      revision: args.conflict ? d.revision : revision,
      conflict: args.conflict,
      draft: value,
    });
    return ok;
  },
  deliverMail: (fx, args) => {
    const a = must(fx.store, 'Account', args.accountId, 'No such account.');
    const me = { address: a.address, name: a.name };
    const prev = args.threadId ? fx.store.get('Thread', args.threadId) : undefined;
    const threadId = prev?.id ?? `${a.id}:mail-${fx.id('n')}`;
    const messageId = `${threadId}.${fx.id('m')}`;
    const snippet = args.body.replace(/\s+/g, ' ').slice(0, 140);
    const labels = [
      ...new Set([...(prev?.labels.filter(l => !/:(TRASH|SPAM)$/.test(l)) ?? []), `${a.id}:INBOX`]),
    ];
    fx.bodies[messageId] = args.body;
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Message', {
        id: messageId,
        threadId,
        accountId: a.id,
        rev: 0,
        from: { address: args.from, name: args.fromName },
        to: [me],
        cc: [],
        subject: args.subject,
        snippet,
        date: fx.now,
        seen: false,
        flagged: false,
        answered: false,
        fromMe: false,
        labels,
        attachments: [],
        bodyState: 'present',
        bodyKind: 'text',
      });
      tx.put('Thread', {
        ...(prev ?? {
          id: threadId,
          accountId: a.id,
          rev: 0,
          subject: args.subject,
          messageCount: 0,
          unreadCount: 0,
          partial: false,
          flagged: false,
          hasAttachments: false,
          participants: [
            { name: args.fromName, address: args.from },
            { ...me, me: true },
          ],
          summary: { state: 'none' },
          unsubscribe: false,
          fromLater: false,
          workflow: {
            status: 'new',
            bookmarked: false,
            hiddenFromHome: false,
            replyStatus: 'none',
          },
          rank: {
            lane: args.lane ?? 'update',
            importance: 'normal',
            source: 'heuristic',
            dueBand: 3,
          },
        }),
        snippet,
        fromName: args.fromName,
        lastDate: fx.now,
        lastInboundDate: fx.now,
        messageCount: (prev?.messageCount ?? 0) + 1,
        unreadCount: (prev?.unreadCount ?? 0) + 1,
        unread: true,
        labels,
        fromLater: false,
        workflow: {
          ...(prev?.workflow ?? {
            bookmarked: false,
            hiddenFromHome: false,
            replyStatus: 'none',
          }),
          status: 'new',
        },
        ...(args.lane && prev
          ? { rank: { ...prev.rank, lane: args.lane, source: 'heuristic' } }
          : {}),
      });
    });
    fx.notifications.push({
      id: fx.id('note'),
      kind: 'mail',
      accountId: a.id,
      threadId,
      title: args.fromName,
      body: args.subject.slice(0, 1_000),
      at: fx.now,
    });
    fx.emit({ frame: 'host', event: { type: 'notify', pending: fx.notifications.length } });
    return { threadId, messageId };
  },
  rerank: (fx, args) => {
    const t = must(fx.store, 'Thread', args.threadId, 'No such thread.');
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put('Thread', {
        ...t,
        rank: {
          ...t.rank,
          ...(args.lane ? { lane: args.lane } : {}),
          ...(args.importance ? { importance: args.importance } : {}),
          source: 'ai',
          rankedAt: fx.now,
        },
      }),
    );
    return ok;
  },
  setUsage: (fx, args) => {
    const cap = must(fx.store, 'Settings', 'settings').ai.dailyCap;
    const spent = cap.enabled && args.backgroundTokens >= cap.tokens;
    fx.write({ kind: 'Fixture/control' }, tx =>
      tx.put('Meta', {
        ...meta(fx),
        usage: clean({
          backgroundTokens: args.backgroundTokens,
          pausedUntil: spent ? nextMidnight(fx) : undefined,
        }),
      }),
    );
    return ok;
  },
  snapshot: fx => ({
    now: fx.now,
    dbEpoch: fx.store.dbEpoch,
    seq: fx.store.seq,
    floor: fx.store.floor,
    windows: fx.windows.size,
  }),
};

/** The fixture's side of `Fixture/control`: each knob forces one awkward state, through the same commits real changes use. */
export function controlHandler(fx: Fixture) {
  return async (args: ControlArgs): Promise<unknown> => {
    const handler = knobs[args?.knob as Knob] as
      ((fx: Fixture, args: ControlArgs) => unknown) | undefined;
    if (!handler)
      throw new ContractError({
        type: 'validation',
        message: 'Unknown control knob.',
        path: ['knob'],
      });
    return handler(fx, args);
  };
}
