import { ContractError } from '@aplos/contract/contract-error';
import type { Fixture } from './engine';
import type { ControlArgs } from './control-types';
import { setupTick } from './methods/account';
import { nextMidnight } from './methods/ai';
import { clean, must } from './methods/util';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The fixture's side of `Fixture/control`: each knob forces one awkward state, through the same commits real changes use. */
export function controlHandler(fx: Fixture) {
  const meta = () => must(fx.store, 'Meta', 'meta');
  const ok = { ok: true as const };
  return async (args: ControlArgs): Promise<unknown> => {
    switch (args?.knob) {
      case 'setAccountStatus': {
        const a = must(fx.store, 'Account', args.accountId, 'No such account.');
        fx.write({ kind: 'Fixture/control' }, tx => tx.put('Account', { ...a, health: clean({ ...a.health, status: args.status, reasonCode: args.reasonCode, reconnectBy: args.reconnectBy ?? a.health.reconnectBy }) }));
        return ok;
      }
      case 'pauseAccount': {
        const a = must(fx.store, 'Account', args.accountId, 'No such account.');
        const until = fx.now + args.forMs;
        const reasonCode = args.reasonCode ?? 'rate.minute';
        fx.write({ kind: 'Fixture/control' }, tx => {
          tx.put('Account', { ...a, health: { ...a.health, status: { state: 'paused', until, class: args.class ?? 'throttle', reason: args.reason ?? 'rateLimitExceeded' }, reasonCode } });
          const r = tx.get('Setup', a.id);
          if (r && r.state !== 'ready') tx.put('Setup', { ...r, state: 'paused', pausedUntil: until, reasonCode });
        });
        fx.clock.after(args.forMs, () => {
          const now = fx.store.get('Account', a.id);
          if (now?.health.status.state === 'paused' && now.health.status.until === until)
            fx.write({ kind: 'Fixture/resume' }, tx => tx.put('Account', { ...now, health: clean({ ...now.health, status: { state: 'ok' as const }, reasonCode: undefined }) }));
        });
        return ok;
      }
      case 'failNextWrite':
        fx.failures.push({ mode: args.mode ?? 'afterReceipt', type: args.type ?? 'providerError', message: args.message ?? 'Gmail did not accept this change. Try again.', reasonCode: args.reasonCode, afterMs: args.afterMs ?? 500 });
        return ok;
      case 'setSubmissionState': {
        const s = must(fx.store, 'Submission', args.submissionId, 'No such submission.');
        if (!['queued', 'scheduled', 'sending'].includes(args.state)) { fx.runs.get(s.id)?.(); fx.runs.delete(s.id); }
        const { problem: _, ...rest } = s;
        fx.write({ kind: 'Fixture/control' }, tx => tx.put('Submission', clean({ ...rest, state: args.state, problem: args.problem ? { ...args.problem, at: fx.now } : undefined })));
        return ok;
      }
      case 'nextSendOutcome': fx.sendOutcomes.push(args.outcome); return ok;
      case 'advanceSetup': {
        const ids = args.accountId ? [args.accountId] : fx.store.all('Setup').map(r => r.id);
        for (const id of ids) {
          if (args.to) { setupTick(fx, id, args.to); if (args.reasonCode) { const r = fx.store.get('Setup', id)!; fx.write({ kind: 'Fixture/control' }, tx => tx.put('Setup', { ...r, reasonCode: args.reasonCode })); } }
          else for (let i = 0; i < (args.steps ?? 1); i++) setupTick(fx, id);
        }
        return ok;
      }
      case 'setClock':
        fx.clock.set(args.now);
        fx.emit({ frame: 'host', event: { type: 'clock', now: fx.now } });
        await settle();
        return { now: fx.now };
      case 'advanceClock': fx.clock.advance(args.ms); await settle(); return { now: fx.now };
      case 'setOrdering': fx.ordering = { ...args.ordering }; return ok;
      case 'replay': for (const frame of args.frames) fx.emit(frame as never); return ok;
      case 'reset': fx.reset(args.reason); return ok;
      case 'compactLog': fx.store.compact(); return ok;
      case 'park': {
        const parked = { reasonCode: args.reasonCode, message: args.message, at: fx.now, canRetry: args.canRetry ?? true };
        fx.write({ kind: 'Fixture/control' }, tx => tx.put('Meta', { ...meta(), engine: { state: 'parked', parked } }));
        fx.emit({ frame: 'host', event: { type: 'parked', reasonCode: parked.reasonCode, message: parked.message, canRetry: parked.canRetry, at: parked.at } });
        return ok;
      }
      case 'unpark': fx.write({ kind: 'Fixture/control' }, tx => tx.put('Meta', { ...meta(), engine: { state: 'ready' } })); return ok;
      case 'hostEvent': fx.emit({ frame: 'host', event: args.event }); return ok;
      case 'draftChanged': {
        const d = must(fx.store, 'Draft', args.draftId, 'No such draft.');
        const revision = d.revision + 1;
        const { value } = fx.write({ kind: 'Fixture/control' }, tx => tx.put('Draft', args.conflict
          ? { ...d, conflict: { theirsRevision: revision, at: fx.now, device: 'MacBook Air' } }
          : { ...d, revision, updatedAt: fx.now, sync: 'synced' }));
        fx.emit({ frame: 'Draft/changed', draftId: d.id, revision: args.conflict ? d.revision : revision, conflict: args.conflict, draft: value });
        return ok;
      }
      case 'deliverMail': {
        const a = must(fx.store, 'Account', args.accountId, 'No such account.');
        const me = { address: a.address, name: a.name };
        const prev = args.threadId ? fx.store.get('Thread', args.threadId) : undefined;
        const threadId = prev?.id ?? `${a.id}:mail-${fx.id('n')}`;
        const messageId = `${threadId}.${fx.id('m')}`;
        const snippet = args.body.replace(/\s+/g, ' ').slice(0, 140);
        const labels = [...new Set([...(prev?.labels.filter(l => !/:(TRASH|SPAM)$/.test(l)) ?? []), `${a.id}:INBOX`])];
        fx.bodies[messageId] = args.body;
        fx.write({ kind: 'Fixture/control' }, tx => {
          tx.put('Message', { id: messageId, threadId, accountId: a.id, rev: 0, from: { address: args.from, name: args.fromName }, to: [me], cc: [], subject: args.subject, snippet, date: fx.now, seen: false, flagged: false, answered: false, fromMe: false, labels, attachments: [], bodyState: 'present', bodyKind: 'text' });
          tx.put('Thread', {
            ...(prev ?? {
              id: threadId, accountId: a.id, rev: 0, subject: args.subject, messageCount: 0, unreadCount: 0, partial: false, flagged: false, hasAttachments: false,
              participants: [{ name: args.fromName, address: args.from }, { ...me, me: true }], summary: { state: 'none' }, unsubscribe: false, fromLater: false,
              workflow: { status: 'new', bookmarked: false, hiddenFromHome: false, replyStatus: 'none' },
              rank: { lane: args.lane ?? 'update', importance: 'normal', source: 'heuristic', dueBand: 3 },
            }),
            snippet, fromName: args.fromName, lastDate: fx.now, lastInboundDate: fx.now, messageCount: (prev?.messageCount ?? 0) + 1, unreadCount: (prev?.unreadCount ?? 0) + 1,
            unread: true, labels, fromLater: false, workflow: { ...(prev?.workflow ?? { bookmarked: false, hiddenFromHome: false, replyStatus: 'none' }), status: 'new' },
            ...(args.lane && prev ? { rank: { ...prev.rank, lane: args.lane, source: 'heuristic' } } : {}),
          });
        });
        fx.notifications.push({ id: fx.id('note'), kind: 'mail', accountId: a.id, threadId, title: args.fromName, body: args.subject.slice(0, 1_000), at: fx.now });
        fx.emit({ frame: 'host', event: { type: 'notify', pending: fx.notifications.length } });
        return { threadId, messageId };
      }
      case 'rerank': {
        const t = must(fx.store, 'Thread', args.threadId, 'No such thread.');
        fx.write({ kind: 'Fixture/control' }, tx => tx.put('Thread', { ...t, rank: { ...t.rank, ...(args.lane ? { lane: args.lane } : {}), ...(args.importance ? { importance: args.importance } : {}), source: 'ai', rankedAt: fx.now } }));
        return ok;
      }
      case 'setUsage': {
        const cap = must(fx.store, 'Settings', 'settings').ai.dailyCap;
        const spent = cap.enabled && args.backgroundTokens >= cap.tokens;
        fx.write({ kind: 'Fixture/control' }, tx => tx.put('Meta', { ...meta(), usage: clean({ backgroundTokens: args.backgroundTokens, pausedUntil: spent ? nextMidnight(fx) : undefined }) }));
        return ok;
      }
      case 'snapshot': return { now: fx.now, dbEpoch: fx.store.dbEpoch, seq: fx.store.seq, floor: fx.store.floor, windows: fx.windows.size };
      default: throw new ContractError({ type: 'validation', message: 'Unknown control knob.', path: ['knob'] });
    }
  };
}
