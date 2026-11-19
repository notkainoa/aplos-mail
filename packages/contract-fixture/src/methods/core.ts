import type { QueueItem, Settings } from '@aplos/contract';
import type { Fixture } from '../engine';
import type { Bytes } from '../data/demo';
import { capabilities } from '../data/defaults';
import { addDays, atLocal, localDay, weekday } from '../time';
import { principalOf, requireOriginating, requireScope, type Caller } from '@aplos/contract/access';
import { consentKey } from './ai';
import { clean, fail, must, type Part } from './util';

const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0').repeat(2);
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));

/** Stores a blob for `caller` under an id with 128 random bits (seeded, so a run repeats), never a counter (FR-6). */
export function blobOf(fx: Fixture, caller: Caller, bytes: Bytes, mime: string, name?: string) {
  const bits = Array.from({ length: 4 }, () =>
    ((fx.random() * 2 ** 32) >>> 0).toString(16).padStart(8, '0'),
  ).join('');
  const blobId = `blob-${bits}`;
  fx.blobs.set(blobId, { bytes, mime, ...(name ? { name } : {}), owner: principalOf(caller) });
  return blobId;
}

/** The caller's own blob, else `notFound`: another caller's id reads as unknown, never as forbidden. */
export function ownBlob(fx: Fixture, caller: Caller, blobId: string, message: string) {
  const b = fx.blobs.get(blobId);
  return b && b.owner === principalOf(caller) ? b : fail('notFound', message);
}

/** Session, settings, the outbox summary, Later presets, reminders, notifications and the admin areas. */
export function core(fx: Fixture) {
  const meta = () => must(fx.store, 'Meta', 'meta');
  const settings = () => must(fx.store, 'Settings', 'settings');
  return {
    'Session/get': () => {
      const m = meta();
      return {
        apiVersion: 1,
        appVersion: '0.3.0-fixture',
        schemaVersion: 1,
        dbEpoch: fx.store.dbEpoch,
        state: fx.store.state,
        engine: clean({ state: m.engine.state, parked: m.engine.parked, resident: false }),
        capabilities: { ...capabilities, workflowSync: false },
        providers: [
          { kind: 'google', available: true },
          {
            kind: 'microsoft',
            available: false,
            unavailableReason: 'Outlook arrives in a later version.',
          },
          {
            kind: 'imap',
            available: false,
            unavailableReason: 'iCloud and other mail servers arrive in a later version.',
          },
          {
            kind: 'jmap',
            available: false,
            unavailableReason: 'Fastmail arrives in a later version.',
          },
        ],
        hasAccounts: fx.store.all('Account').length > 0,
        setup: clean({ ...m.setup }),
        now: fx.now,
        device: { id: 'fixture-device', name: 'Fixture Mac' },
      };
    },
    'Session/changes': ({ since, types, maxChanges = 500 }) => {
      const s = fx.store;
      if (since.dbEpoch !== s.dbEpoch || since.seq < s.floor || since.seq > s.seq)
        fail('cannotCalculateChanges', 'Aplos needs to reload this view.');
      const entries = s.log.filter(e => e.seq > since.seq && (!types || types.includes(e.type)));
      // Whole commits only, so `newState` never claims half of one; the first commit always fits.
      let upto = s.seq;
      const unique = new Set<string>();
      for (const e of entries) {
        const key = `${e.type}\u0000${e.id}`;
        if (!unique.has(key) && unique.size >= maxChanges && e.seq > (entries[0]?.seq ?? 0)) {
          upto = e.seq - 1;
          break;
        }
        unique.add(key);
      }
      const latest = new Map<string, { type: string; id: string; op: 'u' | 'd' }>();
      for (const e of entries)
        if (e.seq <= upto) {
          const key = `${e.type}\u0000${e.id}`;
          latest.delete(key);
          latest.set(key, { type: e.type, id: e.id, op: e.op });
        }
      return {
        oldState: { dbEpoch: since.dbEpoch, seq: since.seq },
        newState: { dbEpoch: s.dbEpoch, seq: upto },
        hasMore: upto < s.seq,
        changes: [...latest.values()],
      };
    },

    'Settings/get': () => {
      const { id: _, ...rest } = settings();
      return rest;
    },
    'Settings/set': ({ opId, patch, ifInState }) => {
      const lastSeq =
        [...fx.store.log].reverse().find(e => e.type === 'Settings')?.seq ?? fx.store.floor;
      if (ifInState && (ifInState.dbEpoch !== fx.store.dbEpoch || ifInState.seq < lastSeq))
        fail('stateMismatch', 'Settings changed in another window. Reopen them and try again.');
      const current = settings();
      const next = { ...current } as Settings & { id: 'settings' };
      for (const section of Object.keys(patch) as (keyof Settings)[])
        (next as Record<string, unknown>)[section] = { ...current[section], ...patch[section] };
      const { receipt } = fx.write({ opId, kind: 'Settings/set' }, tx => {
        tx.put('Settings', next);
        // Another provider, model or address host for a background feature needs consent again (FR-5, R2B-4).
        const c = tx.get('Consent', 'background');
        if (c?.granted && consentKey(current.ai) !== consentKey(next.ai))
          tx.put('Consent', { ...c, currentVersion: c.currentVersion + 1, needsReconsent: true });
      });
      if (patch.ui?.theme && patch.ui.theme !== current.ui.theme)
        fx.emit({ frame: 'host', event: { type: 'appearance', theme: patch.ui.theme } });
      const { id: _, ...out } = next;
      return { settings: out, receipt };
    },

    'Outbox/pending': () => {
      const subs = fx.store.all('Submission');
      const scheduled = subs.filter(s => s.state === 'queued' || s.state === 'scheduled');
      const reminders = fx.store
        .all('Thread')
        .filter(
          t =>
            t.workflow.reminderAt && t.workflow.reminderAt > fx.now && !t.workflow.reminderFiredAt,
        );
      const times = [
        ...scheduled.map(s => s.notBefore),
        ...reminders.map(t => t.workflow.reminderAt!),
      ];
      return clean({
        scheduledSends: scheduled.length,
        reminders: reminders.length,
        uncertain: subs.filter(s => s.state === 'uncertain').length,
        nextAt: times.length ? Math.min(...times) : undefined,
      });
    },

    'Later/presets': () => {
      const today = localDay(fx.now, fx.zone),
        wd = weekday(today);
      const at = (day: string, h: number) => atLocal(day, h, 0, fx.zone);
      const presets: { key: string; label: string; until?: number }[] = [];
      if (fx.now < at(today, 17))
        presets.push({ key: 'evening', label: 'This evening', until: at(today, 18) });
      presets.push({ key: 'tomorrow', label: 'Tomorrow', until: at(addDays(today, 1), 8) });
      if (wd >= 1 && wd <= 4)
        presets.push({
          key: 'weekend',
          label: 'This weekend',
          until: at(addDays(today, 6 - wd), 8),
        });
      // Next week starts on the owner's first day (`ui.calendar.weekStart`; absent follows the locale, Monday here).
      const first = settings().ui.calendar.weekStart ?? 1;
      presets.push({
        key: 'nextWeek',
        label: 'Next week',
        until: at(addDays(today, (first - wd + 7) % 7 || 7), 8),
      });
      presets.push({ key: 'someday', label: 'Someday' });
      return { now: fx.now, presets };
    },

    'Reminder/list': () => ({
      items: fx.store
        .all('Thread')
        .filter(t => t.workflow.reminderAt !== undefined)
        .map(t =>
          clean({
            threadId: t.id,
            at: t.workflow.reminderAt!,
            firedAt:
              t.workflow.reminderFiredAt ??
              (t.workflow.reminderAt! <= fx.now ? t.workflow.reminderAt : undefined),
            ifNoReply: !!t.workflow.reminderIfNoReply,
            title: t.subject,
          }),
        ),
    }),
    'Reminder/ack': ({ opId, threadIds }) =>
      fx.write({ opId, kind: 'Reminder/ack', targets: threadIds }, tx => {
        for (const id of threadIds) {
          const t = tx.get('Thread', id);
          if (t?.workflow.reminderAt !== undefined && t.workflow.reminderAt <= fx.now) {
            const {
              reminderAt: _,
              reminderFiredAt: __,
              reminderIfNoReply: ___,
              ...workflow
            } = t.workflow;
            tx.put('Thread', { ...t, workflow });
          }
        }
      }).receipt,

    'Notification/claim': ({ max = 10 }) => ({ items: fx.notifications.splice(0, max) }),
    'Notification/ack': () => ({ ok: true as const }),

    'Workflow/status': () => ({
      enabled: meta().workflowSync,
      available: false,
      message: 'Syncing Done and Later between Macs arrives in a later version.',
    }),
    'Workflow/enable': ({ code }) => {
      fx.write({ kind: 'Workflow/enable' }, tx =>
        tx.put('Meta', { ...meta(), workflowSync: true }),
      );
      return { code: code ?? 'FIXT-4821-7730' };
    },
    'Workflow/code': () => ({ code: 'FIXT-4821-7730' }),
    'Workflow/disable': () => {
      fx.write({ kind: 'Workflow/disable' }, tx =>
        tx.put('Meta', { ...meta(), workflowSync: false }),
      );
      return { enabled: false as const };
    },

    'Listener/get': () =>
      meta().listener.enabled
        ? { enabled: true, socketPath: 'run/engine.sock', port: 47_120 }
        : { enabled: false },
    'Listener/set': ({ enabled }) => {
      fx.write({ kind: 'Listener/set' }, tx =>
        tx.put('Meta', { ...meta(), listener: { enabled } }),
      );
      return enabled
        ? { enabled: true, socketPath: 'run/engine.sock', port: 47_120 }
        : { enabled: false };
    },

    'Clients/list': () => ({ list: fx.store.all('Client') }),
    'Clients/grant': ({ name, kind, scopes }) => {
      const id = fx.id('client');
      const client = {
        id,
        name,
        kind,
        scopes: [...new Set(scopes)],
        createdAt: fx.now,
        tokenPath: `run/clients/${id}.token`,
      };
      fx.write({ kind: 'Clients/grant' }, tx => tx.put('Client', client));
      return { client };
    },
    'Clients/revoke': ({ id }) => {
      const client = must(fx.store, 'Client', id, 'This tool is no longer allowed.');
      fx.write({ kind: 'Clients/revoke' }, tx =>
        tx.put('Client', { ...client, revokedAt: fx.now }),
      );
      return { ok: true as const };
    },
    'Clients/audit': () => ({ list: [] }),

    'Data/export': (_args, cx) => {
      const bytes = encode({
        exportedAt: fx.now,
        settings: settings(),
        accounts: fx.store
          .all('Account')
          .map(a => ({ id: a.id, provider: a.provider, address: a.address, name: a.name })),
        workflow: fx.store.all('Thread').map(t => ({ id: t.id, workflow: t.workflow })),
        drafts: fx.store.all('Draft'),
        conversations: fx.store.all('Conversation'),
      });
      return {
        blobId: blobOf(fx, cx.caller, bytes, 'application/json', 'aplos-data.json'),
        name: 'aplos-data.json',
        size: bytes.length,
      };
    },

    'Diagnostics/preview': () => diagnostics(fx),
    'Diagnostics/export': (_args, cx) => {
      const bytes = encode(diagnostics(fx));
      return {
        blobId: blobOf(fx, cx.caller, bytes, 'application/json', 'aplos-diagnostics.json'),
        name: 'aplos-diagnostics.json',
        size: bytes.length,
      };
    },
    'Diagnostics/verbose': ({ on }) => {
      // No `on` is a pure read of the stored deadline, as in the real engine: nothing is written, an elapsed one reads off.
      if (on === undefined) {
        const stored = meta().verboseUntil;
        return stored !== undefined && stored > fx.now ? { until: stored } : {};
      }
      const until = on ? fx.now + 15 * 60_000 : undefined;
      fx.write({ kind: 'Diagnostics/verbose' }, tx =>
        tx.put('Meta', clean({ ...meta(), verboseUntil: until })),
      );
      return clean({ until });
    },

    'Queue/list': ({ kinds }) => ({
      list: queue(fx).filter(item => !kinds || kinds.includes(item.kind as 'op')),
    }),
    // Each queue action needs the scope of whatever made the item, as well as admin (FR-3): a send is `send`, a job `ai`.
    'Queue/retry': ({ id }, cx) => {
      const op = fx.ops.get(id);
      if (op) {
        requireOriginating(cx.caller, op);
        if (op.operation.state !== 'failed')
          fail('conflict', 'Only a failed change can be retried.');
        fx.handlers['Operation/retry']({ opId: id }, cx);
        return { ok: true as const };
      }
      const job = fx.store.get('AiJob', id);
      if (job) {
        requireScope(cx.caller, 'ai');
        fx.write({ kind: 'Queue/retry' }, tx =>
          tx.put('AiJob', { ...job, state: 'queued', attempts: job.attempts + 1, nextAt: fx.now }),
        );
        return { ok: true as const };
      }
      const sub = fx.store.get('Submission', id);
      if (sub?.state === 'failed') {
        requireScope(cx.caller, 'send');
        fx.handlers['Submission/set'](
          { opId: fx.id('retry'), action: { type: 'retry', submissionId: id } },
          cx,
        );
        return { ok: true as const };
      }
      return fail('notFound', 'This item is no longer in the queue.');
    },
    'Queue/discard': ({ id }, cx) => {
      const op = fx.ops.get(id);
      if (op) {
        requireOriginating(cx.caller, op);
        op.operation = { ...op.operation, state: 'cancelled' };
        fx.emit({ frame: 'operation', operation: op.operation });
        return { ok: true as const };
      }
      if (fx.store.get('AiJob', id)) {
        requireScope(cx.caller, 'ai');
        fx.write({ kind: 'Queue/discard' }, tx => tx.del('AiJob', id));
        return { ok: true as const };
      }
      const sub = fx.store.get('Submission', id);
      if (sub && !['sent', 'cancelled'].includes(sub.state)) {
        requireScope(cx.caller, 'send');
        // Discarding a send is undo or cancel, so the draft comes back unlocked.
        const type = sub.state === 'queued' || sub.state === 'scheduled' ? 'undo' : 'cancel';
        fx.handlers['Submission/set'](
          { opId: fx.id('discard'), action: { type, submissionId: id } },
          cx,
        );
        return { ok: true as const };
      }
      return fail('notFound', 'This item is no longer in the queue.');
    },
  } satisfies Part;
}

function queue(fx: Fixture): QueueItem[] {
  const ops = [...fx.ops.values()]
    .filter(o => o.operation.state === 'queued' || o.operation.state === 'failed')
    .map(({ operation: o, scope }) =>
      clean({
        id: o.opId,
        kind: 'op',
        label: `${o.kind.split('/')[1] ?? o.kind} ${o.targets.length} item${o.targets.length === 1 ? '' : 's'}`,
        state: o.state,
        attempts: 1,
        createdAt: o.createdAt,
        problem: o.error
          ? { reasonCode: o.error.reasonCode ?? 'unknown', message: o.error.message }
          : undefined,
        canRetry: o.state === 'failed',
        canDiscard: true,
        scope,
      }),
    );
  const jobs = fx.store
    .all('AiJob')
    .filter(j => j.state === 'queued' || j.state === 'running' || j.state === 'failed')
    .map(j =>
      clean({
        id: j.id,
        kind: 'job',
        label: j.kind === 'summary' ? 'Summary' : j.kind,
        accountId: j.threadId?.split(':')[0],
        state: j.state,
        attempts: j.attempts,
        nextAt: j.nextAt,
        createdAt: fx.now,
        problem: j.problem
          ? { reasonCode: j.problem.reasonCode, message: j.problem.message }
          : undefined,
        canRetry: j.state === 'failed',
        canDiscard: true,
        scope: 'ai',
      }),
    );
  const subs = fx.store
    .all('Submission')
    .filter(s =>
      ['queued', 'scheduled', 'sending', 'uncertain', 'failed', 'suspended'].includes(s.state),
    )
    .map(s =>
      clean({
        id: s.id,
        kind: 'submission',
        label: 'Send 1 message',
        accountId: s.accountId,
        state: s.state,
        attempts: s.attemptAt ? 1 : 0,
        nextAt: s.notBefore,
        createdAt: s.notBefore,
        problem: s.problem
          ? { reasonCode: s.problem.reasonCode, message: s.problem.message }
          : undefined,
        canRetry: s.state === 'failed',
        canDiscard: s.state !== 'sending',
        scope: 'send',
      }),
    );
  return [...ops, ...jobs, ...subs];
}

function diagnostics(fx: Fixture) {
  const m = fx.store.get('Meta', 'meta')!;
  const ops = [...fx.ops.values()].map(o => o.operation);
  return {
    generatedAt: fx.now,
    versions: { app: '0.3.0-fixture', api: 1, schema: 1 },
    engine: clean({
      state: m.engine.state,
      uptimeMs: 0,
      parkedReason: m.engine.parked?.reasonCode,
    }),
    accounts: fx.store.all('Account').map(a =>
      clean({
        accountHash: hash(a.id),
        provider: a.provider,
        state: a.health.status.state,
        reasonCode: a.health.reasonCode,
        lastSyncAt: a.health.lastSyncAt,
        reconnectBy: a.health.reconnectBy,
        budgets: [],
      }),
    ),
    queues: {
      ops: ops.filter(o => o.state === 'queued').length,
      jobs: fx.store.all('AiJob').filter(j => j.state === 'queued').length,
      submissions: fx.store
        .all('Submission')
        .filter(s => s.state === 'queued' || s.state === 'scheduled').length,
      failed: ops.filter(o => o.state === 'failed').length,
    },
    errors: [],
    storage: {
      dbBytes: 0,
      walBytes: 0,
      ftsBacklog: 0,
      bodyBytes: Object.values(fx.bodies).reduce((n, b) => n + b.length, 0),
      attachmentBytes: Object.values(fx.files).reduce((n, f) => n + f.bytes.length, 0),
    },
    crashes: { count: 0 },
  };
}
