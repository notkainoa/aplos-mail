import type { Account } from '@aplos/contract';
import type { Fixture } from '../engine';
import type { ConnectOutcome } from '../control-types';
import { demoData } from '../data/demo';
import { accountRows, insert, loadDemo } from '../scenarios';
import type { SetupRecord, Tx } from '../store';
import { clean, fail, getRows, must, type Part } from './util';

const week = 7 * 86_400_000;
/** One tick of first-sync progress on the engine clock. */
export const setupTickMs = 400;

/**
 * One step of an account's first sync: connecting → finding → reading (six threads a tick land in the mailbox) →
 * sorting (only with consent) → ready. Returns false once there is nothing left to do.
 */
export function setupTick(fx: Fixture, accountId: string, to?: SetupRecord['state']): boolean {
  const rec = fx.store.get('Setup', accountId);
  const account = fx.store.get('Account', accountId);
  if (!rec || !account || rec.state === 'ready' || rec.state === 'failed') return false;
  const pending = fx.pendingMail.get(accountId) ?? [];
  const consent = !!fx.store.get('Consent', 'background')?.granted;
  fx.write({ kind: 'Setup/progress' }, tx => {
    let next: SetupRecord = { ...rec };
    const land = (n: number) => {
      const batch = pending.splice(0, n);
      for (const put of batch) put(tx);
      next.read += batch.length;
    };
    const firstWindowIn = () => {
      next.done = true;
      next.state = consent ? 'sorting' : 'ready';
      if (consent) next.ai = { sorted: 0, total: next.read, capped: 0, failed: 0 };
    };
    if (to === 'ready') {
      land(Infinity);
      next = {
        ...next,
        state: 'ready',
        done: true,
        ...(next.ai ? { ai: { ...next.ai, sorted: next.ai.total } } : {}),
      };
    } else if (to === 'sorting') {
      land(Infinity);
      firstWindowIn();
    } else if (to) next.state = to;
    else
      switch (rec.state) {
        case 'connecting':
          next.state = 'finding';
          break;
        case 'finding':
          next = {
            ...next,
            state: 'reading',
            found: fx.pendingThreads.get(accountId) ?? pending.length,
          };
          break;
        case 'reading':
        case 'paused':
          land(6);
          if (pending.length) next.state = 'reading';
          else firstWindowIn();
          break;
        case 'sorting': {
          const ai = next.ai ?? { sorted: 0, total: next.read, capped: 0, failed: 0 };
          next.ai = { ...ai, sorted: Math.min(ai.total, ai.sorted + 6) };
          if (next.ai.sorted >= next.ai.total) next.state = 'ready';
          break;
        }
        default:
          next.state = 'ready';
      }
    next.backfill = { read: next.read, target: Math.max(next.read, next.found ?? 0) };
    if (next.state !== 'paused') delete next.pausedUntil;
    tx.put('Setup', next);
    const now = tx.get('Account', accountId)!;
    if (next.done && !now.baselineDoneAt)
      tx.put('Account', {
        ...now,
        baselineDoneAt: fx.now,
        calendarListedAt: now.calendarListedAt ?? fx.now,
      });
    if (next.state === 'ready')
      tx.put('Account', {
        ...tx.get('Account', accountId)!,
        health: clean({
          ...now.health,
          status: { state: 'ok' as const },
          lastSyncAt: fx.now,
          reasonCode: undefined,
        }),
      });
  });
  return fx.store.get('Setup', accountId)?.state !== 'ready';
}

/** Accounts, connecting and reconnecting with `connect` frames, sync requests, setup, and the demo on request. */
export function account(fx: Fixture) {
  const accountOf = (id: string) =>
    must(fx.store, 'Account', id, 'This account is no longer connected.');
  const sendingIn = (accountId: string) =>
    fx.store.all('Submission').some(s => s.accountId === accountId && s.state === 'sending');
  /**
   * A connect flow: `waiting` now, then the outcome after the browser step, all as `connect` frames. A reconnect or
   * permission grant names its account on every frame and every frame keeps the flow's mode (freeze FR-23). The outcome
   * is `connected` after 800 ms unless the `resolveConnect` knob scripted another.
   */
  const flow = (
    mode: 'new' | 'reconnect' | 'grantPermissions',
    accountId: string | undefined,
    done: () => string,
  ) => {
    const connectId = fx.id('connect');
    const frame = (state: string, extra: { accountId?: string; reasonCode?: string } = {}) =>
      fx.emit({
        frame: 'connect',
        connectId,
        mode,
        state,
        ...(accountId ? { accountId } : {}),
        ...extra,
      });
    const finish = (o: ConnectOutcome) => {
      if (!fx.connects.delete(connectId)) return;
      fx.runs.get(connectId)?.();
      fx.runs.delete(connectId);
      if (o.outcome === 'connected') frame('connected', { accountId: done() });
      else frame(o.outcome, o.reasonCode ? { reasonCode: o.reasonCode } : {});
    };
    fx.connects.set(connectId, { finish });
    frame('waiting');
    const script = fx.connectScripts.shift();
    fx.runs.set(
      connectId,
      fx.clock.after(script?.delayMs ?? 800, () => finish(script ?? { outcome: 'connected' })),
    );
    return { connectId };
  };
  const ticking = (accountId: string) => {
    const tick = () => {
      if (setupTick(fx, accountId))
        fx.runs.set(`setup:${accountId}`, fx.clock.after(setupTickMs, tick));
      else fx.runs.delete(`setup:${accountId}`);
    };
    fx.runs.set(`setup:${accountId}`, fx.clock.after(setupTickMs, tick));
  };
  const demoIds = () =>
    fx.store
      .all('Account')
      .filter(a => a.demo)
      .map(a => a.id);
  const drop = (accountId: string) =>
    fx.write({ kind: 'Account/remove' }, tx => {
      for (const r of accountRows(fx.store, accountId)) tx.del(r.table, r.id);
    });

  return {
    'Account/get': ({ ids }) =>
      ids
        ? getRows(fx.store, 'Account', ids)
        : { state: fx.store.state, list: fx.store.all('Account'), notFound: [] },
    'Account/discover': ({ address, domain }) => {
      const host = (domain ?? address!.split('@')[1] ?? '').toLowerCase();
      if (/^(gmail|googlemail)\.com$/.test(host)) return { provider: 'google', preset: 'gmail' };
      if (/^(outlook|hotmail|live|msn)\.com$/.test(host))
        return {
          provider: 'microsoft',
          preset: 'outlook',
          reasonCode: 'config.clientMissing',
          message: 'Outlook arrives in a later version.',
        };
      if (/^(icloud|me|mac)\.com$/.test(host))
        return {
          provider: 'icloud',
          preset: 'icloud',
          message: 'iCloud arrives in a later version.',
        };
      if (/^fastmail\.(com|fm)$/.test(host))
        return {
          provider: 'fastmail',
          preset: 'fastmail',
          sessionUrl: 'https://api.fastmail.com/jmap/session',
          message: 'Fastmail arrives in a later version.',
        };
      if (/^(yahoo|ymail)\.com$/.test(host))
        return { provider: 'yahoo', preset: 'yahoo', message: 'Yahoo arrives in a later version.' };
      // An unknown domain: the fixture pretends it is hosted by Google Workspace, so the practice flow has somewhere to go.
      return { provider: 'google', preset: 'gmail' };
    },
    'Account/connect': ({ provider, loginHint, name }) => {
      if (provider !== 'google')
        fail('unsupported', 'Only Gmail accounts can be connected in this version.');
      return flow('new', undefined, () => {
        const id = fx.id('acct');
        const address = (loginHint ?? `you.${id}@practice.example`).toLowerCase();
        const acct: Account = {
          id,
          rev: 0,
          provider: 'google',
          address,
          name: name ?? 'Practice account',
          demo: false,
          health: { status: { state: 'syncing' }, reconnectBy: fx.now + week },
          capabilities: {
            labels: true,
            folders: false,
            drafts: true,
            serverSearch: true,
            calendar: true,
            filters: true,
            push: false,
            sendAs: true,
            unsubscribeHeaders: true,
            importance: true,
          },
          grantedScopes: ['gmail.modify', 'gmail.settings.basic', 'calendar.events'],
          aiAllowed: true,
          notifications: true,
          lease: {
            role: 'primary',
            holderDeviceId: 'fixture-device',
            holderDeviceName: 'Fixture Mac',
          },
          identities: [{ address, name: name ?? 'Practice account', default: true }],
          preset: 'gmail',
          createdAt: fx.now,
          pendingChanges: 0,
        };
        // The practice mailbox is the demo's, under one account, landing during `reading`.
        const data = demoData(fx.now, fx.zone, { work: id, personal: id });
        data.drafts = [];
        const puts: ((tx: Tx) => void)[] = [];
        const threads = [...data.threads].sort((a, b) => b.lastDate - a.lastDate);
        for (const t of threads)
          puts.push(tx => {
            tx.put('Thread', t);
            for (const m of data.messages.filter(m => m.threadId === t.id)) tx.put('Message', m);
          });
        fx.pendingMail.set(id, puts);
        fx.pendingThreads.set(id, threads.length);
        fx.write({ kind: 'Account/connect' }, tx => {
          tx.put('Account', acct);
          insert(
            fx,
            { ...data, accounts: [], threads: [], messages: [] },
            (table, row) => {
              tx.put(table, row);
            },
            false,
          );
          tx.put('Setup', {
            id,
            state: 'connecting',
            read: 0,
            total: 50,
            done: false,
            backfill: { read: 0, target: 0 },
            runId: fx.id('run'),
            errors: [],
          });
        });
        ticking(id);
        return id;
      });
    },
    'Account/reconnect': ({ accountId }) => {
      accountOf(accountId);
      return flow('reconnect', accountId, () => {
        const a = accountOf(accountId);
        fx.write({ kind: 'Account/reconnect' }, tx =>
          tx.put('Account', {
            ...a,
            health: clean({
              status: { state: 'ok' as const },
              lastSyncAt: fx.now,
              reconnectBy: a.provider === 'google' ? fx.now + week : undefined,
            }),
          }),
        );
        return accountId;
      });
    },
    'Account/updateSecret': ({ accountId }) => {
      const a = accountOf(accountId);
      // Only app-password and API-token accounts take a pasted secret (FR-25); Google signs in again in the browser.
      if (a.provider === 'google')
        fail('unsupported', 'Google accounts sign in again in the browser. Use Reconnect.');
      if (a.provider !== 'imap' && a.provider !== 'jmap')
        fail('unsupported', 'This account has no password to update.');
      return flow('reconnect', accountId, () => accountId);
    },
    'Account/grantPermissions': ({ accountId }) => {
      accountOf(accountId);
      return flow('grantPermissions', accountId, () => {
        const { missingPermissions: _, ...a } = accountOf(accountId);
        fx.write({ kind: 'Account/grantPermissions' }, tx =>
          tx.put('Account', {
            ...a,
            health:
              a.health.status.state === 'needsPermission'
                ? { ...a.health, status: { state: 'ok' as const } }
                : a.health,
          }),
        );
        return accountId;
      });
    },
    'Account/cancelConnect': ({ connectId }) => {
      const live = fx.connects.get(connectId);
      if (!live) return { cancelled: false };
      live.finish({ outcome: 'cancelled' });
      return { cancelled: true };
    },
    'Account/set': ({ opId, accountId, name, colorTag, aiAllowed, notifications }) => {
      const a = accountOf(accountId);
      const { value, receipt } = fx.write({ opId, kind: 'Account/set' }, tx =>
        tx.put(
          'Account',
          clean({
            ...a,
            name: name ?? a.name,
            colorTag: colorTag ?? a.colorTag,
            aiAllowed: aiAllowed ?? a.aiAllowed,
            notifications: notifications ?? a.notifications,
          }),
        ),
      );
      return { account: value, receipt };
    },
    'Account/lease': ({ accountId, pin }) => {
      const list = accountId ? [accountOf(accountId)] : fx.store.all('Account');
      const lease = {
        role: 'primary',
        holderDeviceId: 'fixture-device',
        holderDeviceName: 'Fixture Mac',
        pinned: pin,
      };
      fx.write({ kind: 'Account/lease' }, tx => {
        for (const a of list) tx.put('Account', { ...a, lease });
      });
      return { leases: list.map(a => ({ accountId: a.id, lease })) };
    },
    'Account/disconnect': ({ opId, accountId }) => {
      accountOf(accountId);
      if (sendingIn(accountId))
        fail('conflict', 'A message from this account is sending. Wait a moment, then try again.');
      fx.runs.get(`setup:${accountId}`)?.();
      return fx.write({ opId, kind: 'Account/disconnect', undoable: false }, tx => {
        for (const r of accountRows(fx.store, accountId)) tx.del(r.table, r.id);
      }).receipt;
    },

    'Sync/request': ({ accountId, force }) => {
      const list = accountId ? [accountOf(accountId)] : fx.store.all('Account');
      return {
        accounts: list.map(a => {
          const s = a.health.status;
          if (s.state === 'paused' && s.until > fx.now && !force)
            return {
              accountId: a.id,
              accepted: false,
              reasonCode: a.health.reasonCode ?? 'rate.minute',
              resumeAt: s.until,
            };
          if (s.state === 'offline')
            return { accountId: a.id, accepted: false, reasonCode: 'net.offline' };
          if (s.state === 'needsReauth')
            return {
              accountId: a.id,
              accepted: false,
              reasonCode: a.health.reasonCode ?? 'auth.expired',
            };
          if (s.state !== 'ok' && s.state !== 'paused')
            return {
              accountId: a.id,
              accepted: s.state === 'syncing' || s.state === 'backfilling',
            };
          fx.write({ kind: 'Sync/request' }, tx =>
            tx.put('Account', { ...a, health: { ...a.health, status: { state: 'syncing' } } }),
          );
          fx.clock.after(500, () => {
            const now = fx.store.get('Account', a.id);
            if (now?.health.status.state === 'syncing')
              fx.write({ kind: 'Sync/done' }, tx =>
                tx.put('Account', {
                  ...now,
                  health: clean({
                    ...now.health,
                    status: { state: 'ok' as const },
                    reasonCode: undefined,
                    lastSyncAt: fx.now,
                  }),
                }),
              );
          });
          return { accountId: a.id, accepted: true };
        }),
      };
    },

    'Setup/begin': () => {
      fx.setupId = fx.id('setup');
      return { setupId: fx.setupId };
    },
    'Setup/end': ({ reason }) => {
      const meta = must(fx.store, 'Meta', 'meta');
      const setup =
        reason === 'skipped'
          ? { ...meta.setup, skippedAt: meta.setup.skippedAt ?? fx.now }
          : reason === 'closed'
            ? meta.setup
            : { ...meta.setup, completedAt: meta.setup.completedAt ?? fx.now };
      if (setup !== meta.setup)
        fx.write({ kind: 'Setup/end' }, tx => tx.put('Meta', { ...meta, setup }));
      fx.setupId = undefined;
      return { ok: true as const };
    },
    'Setup/retry': ({ accountId }) => {
      accountOf(accountId);
      const r = must(fx.store, 'Setup', accountId, 'This account has no first sync to resume.');
      // Resume from the checkpoint: a paused or failed run goes back to reading; a running or finished one is left alone.
      if (r.state === 'paused' || r.state === 'failed') {
        const { pausedUntil: _, ...rest } = r;
        fx.write({ kind: 'Setup/retry' }, tx =>
          tx.put('Setup', {
            ...rest,
            state: r.done ? (r.ai && r.ai.sorted < r.ai.total ? 'sorting' : 'ready') : 'reading',
            runId: fx.id('run'),
          }),
        );
      }
      if (!fx.runs.has(`setup:${accountId}`) && fx.store.get('Setup', accountId)?.state !== 'ready')
        ticking(accountId);
      return { ok: true as const };
    },
    'Setup/status': ({ setupId }) => {
      const consent = fx.store.get('Consent', 'background')?.granted;
      const accounts = fx.store.all('Account').flatMap(a => {
        const r = fx.store.get('Setup', a.id);
        if (!r) return [];
        return [
          clean({
            accountId: a.id,
            state: r.state,
            firstWindow: clean({ found: r.found, read: r.read, total: r.total, done: r.done }),
            ai:
              consent && r.ai
                ? clean({
                    ...r.ai,
                    model: fx.store.get('Settings', 'settings')!.ai.features.summaries,
                  })
                : undefined,
            backfill: r.backfill,
            pausedUntil: r.pausedUntil,
            reconnectBy: a.health.reconnectBy,
            reasonCode: r.reasonCode,
            runId: r.runId,
          }),
        ];
      });
      const records = fx.store.all('Account').flatMap(a => fx.store.get('Setup', a.id) ?? []);
      return clean({
        setupId: setupId ?? fx.setupId,
        accounts,
        done: records.every(
          r => r.done && r.state !== 'sorting' && r.state !== 'connecting' && r.state !== 'finding',
        ),
        partial: records.some(
          r =>
            r.state === 'paused' ||
            r.state === 'failed' ||
            (r.ai?.capped ?? 0) > 0 ||
            (r.ai?.failed ?? 0) > 0,
        ),
        errors: records.flatMap(r => r.errors.map(e => ({ accountId: r.id, ...e }))),
      });
    },

    'Demo/load': () => {
      const existing = demoIds();
      if (existing.length)
        return {
          accountIds: existing,
          receipt: { opId: fx.id('op'), appliedState: fx.store.state, undoable: false },
        };
      const { value, receipt } = fx.write({ kind: 'Demo/load', undoable: false }, tx =>
        loadDemo(fx, tx),
      );
      return { accountIds: value, receipt };
    },
    'Demo/reset': () => {
      if (demoIds().some(sendingIn))
        fail('conflict', 'A demo message is sending. Wait a moment, then try again.');
      const { value, receipt } = fx.write({ kind: 'Demo/reset', undoable: false }, tx => {
        for (const id of demoIds())
          for (const r of accountRows(fx.store, id)) tx.del(r.table, r.id);
        return loadDemo(fx, tx);
      });
      return { accountIds: value, receipt };
    },
    'Demo/remove': () => {
      const ids = demoIds();
      for (const id of ids) drop(id);
      return { opId: fx.id('op'), appliedState: fx.store.state, undoable: false };
    },
  } satisfies Part;
}
