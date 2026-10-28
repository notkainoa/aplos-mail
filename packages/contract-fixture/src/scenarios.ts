import type { Fixture, Scenario } from './engine';
import { demoAccountIds, demoData, type Dataset } from './data/demo';
import { defaultSettings } from './data/defaults';
import { addDays, atLocal, localDay } from './time';
import type { SetupRecord, Store, Table, Tables, Tx } from './store';

type Put = <T extends Table>(table: T, row: Tables[T]) => void;
const day = 86_400_000;

/** Every row an account owns, for disconnect and the demo's reset and remove. */
export function accountRows(store: Store, accountId: string): { table: Table; id: string }[] {
  const owns = (row: { accountId?: string; threadId?: string; id: string }) =>
    row.accountId === accountId ||
    row.threadId?.startsWith(`${accountId}:`) ||
    row.id.startsWith(`${accountId}:`);
  const tables: Table[] = [
    'Thread',
    'Message',
    'Draft',
    'Submission',
    'Event',
    'Calendar',
    'Folder',
    'Plan',
    'Followup',
    'AiJob',
    'SenderRule',
  ];
  return [
    ...tables.flatMap(table =>
      store
        .all(table)
        .filter(r => owns(r as never))
        .map(r => ({ table, id: (r as { id: string }).id })),
    ),
    { table: 'Setup', id: accountId },
    { table: 'Account', id: accountId },
  ];
}

/** A finished first sync for an account that holds `threads` threads (`firstWindow.total` is the ~50 target, never the mailbox size). */
export function readySetup(accountId: string, threads: number, withAi: boolean): SetupRecord {
  return {
    id: accountId,
    state: 'ready',
    found: threads,
    read: Math.min(threads, 50),
    total: 50,
    done: true,
    ...(withAi
      ? {
          ai: { sorted: Math.min(threads, 50), total: Math.min(threads, 50), capped: 0, failed: 0 },
        }
      : {}),
    backfill: { read: threads, target: threads },
    runId: `run-${accountId}`,
    errors: [],
  };
}

/** Loads a dataset's rows, bodies and files, through a transaction or straight into the store. */
export function insert(fx: Fixture, data: Dataset, put: Put, withAi: boolean) {
  for (const a of data.accounts) put('Account', a);
  for (const f of data.folders) put('Folder', f);
  for (const t of data.threads) put('Thread', t);
  for (const m of data.messages) put('Message', m);
  for (const c of data.calendars) put('Calendar', c);
  for (const e of data.events) put('Event', e);
  for (const p of data.plans) put('Plan', p);
  for (const d of data.drafts) put('Draft', d);
  for (const a of data.accounts)
    put('Setup', readySetup(a.id, data.threads.filter(t => t.accountId === a.id).length, withAi));
  Object.assign(fx.bodies, data.bodies);
  Object.assign(fx.files, data.files);
  // The Follow up nudge the background job would have written for the sent thread.
  for (const t of data.threads)
    if (t.follow && withAi)
      put('Followup', {
        id: t.id,
        threadId: t.id,
        basedOnMessageId: `${t.id}.m1`,
        model: { provider: 'groq', model: 'openai/gpt-oss-120b' },
        createdAt: fx.now,
        html: '<p>Hi all,</p><p>Just checking in on the questions from our session. Anything to add before Thursday?</p>',
      });
}

export const loadDemo = (fx: Fixture, tx: Tx) => {
  const consent = fx.store.get('Consent', 'background');
  insert(
    fx,
    demoData(fx.now, fx.zone),
    (table, row) => {
      tx.put(table, row);
    },
    !!consent?.granted,
  );
  return Object.values(demoAccountIds);
};

const notYet = (scenario: string) =>
  new Error(`Scenario ${scenario} arrives in Phase 1 (eng-contract); use empty or demo.`);

/** Forces one scenario's awkward state onto the demo rows: health, setup, a stuck submission, a parked engine. */
function forceScenario(fx: Fixture, put: Put, scenario: Scenario) {
  const s = fx.store,
    now = fx.now;
  const work = demoAccountIds.work,
    personal = demoAccountIds.personal;
  const account = (id: string) => s.get('Account', id)!;
  const health = (id: string, h: Tables['Account']['health']) =>
    put('Account', { ...account(id), health: { ...h, lastSyncAt: now - 10 * 60_000 } });
  const setup = (id: string, patch: Partial<SetupRecord>) =>
    put('Setup', { ...s.get('Setup', id)!, ...patch });
  const submission = (state: 'uncertain' | 'suspended') => {
    const draft = s.get('Draft', `${work}:draft-welcome`)!;
    put('Draft', { ...draft, submissionId: 'sub-demo' });
    put('Submission', {
      id: 'sub-demo',
      rev: 1,
      draftId: draft.id,
      accountId: work,
      threadId: draft.threadId,
      internetId: '<sub-demo@fixture.example>',
      revision: draft.revision,
      state,
      queuedAt: now - 3_610_000,
      notBefore: now - 3_600_000,
      attemptAt: now - 3_600_000,
      toNames: ['Jordan Park'],
      subject: draft.subject,
      problem:
        state === 'uncertain'
          ? {
              reasonCode: 'net.offline',
              message: 'We could not confirm this was sent. Check Sent, or Send anyway.',
              at: now - 3_600_000,
            }
          : {
              reasonCode: 'send.overdue',
              message: 'This was due while your Mac was off. Send it now, or choose a new time.',
              at: now - 3_600_000,
            },
    });
  };
  switch (scenario) {
    case 'offline':
      for (const id of [work, personal])
        health(id, {
          status: { state: 'offline', since: now - 10 * 60_000 },
          reasonCode: 'net.offline',
        });
      break;
    case 'needs-reauth':
      health(work, {
        status: { state: 'needsReauth', reason: 'invalid_grant' },
        reasonCode: 'auth.testingModeExpiry',
        reconnectBy: now - 3_600_000,
      });
      break;
    case 'backfilling':
      for (const id of [work, personal]) {
        health(id, { status: { state: 'backfilling', done: 120, of: 2_400 } });
        setup(id, { backfill: { read: 120, target: 2_400 } });
      }
      break;
    case 'rate-limited':
      health(work, {
        status: {
          state: 'paused',
          until: now + 60_000,
          class: 'throttle',
          reason: 'rateLimitExceeded',
        },
        reasonCode: 'rate.minute',
      });
      setup(work, { pausedUntil: now + 60_000, reasonCode: 'rate.minute' });
      break;
    case 'partial-threads':
      for (const t of s.all('Thread').slice(0, 4)) put('Thread', { ...t, partial: true });
      break;
    case 'send-uncertain':
    case 'send-suspended':
      submission(scenario === 'send-uncertain' ? 'uncertain' : 'suspended');
      break;
    case 'ai-off':
      for (const t of s.all('Thread')) put('Thread', { ...t, summary: { state: 'none' } });
      break;
    case 'ai-budget-spent': {
      const midnight = atLocal(addDays(localDay(now, fx.zone), 1), 0, 0, fx.zone);
      put('Meta', {
        ...s.get('Meta', 'meta')!,
        usage: { backgroundTokens: 150_000, pausedUntil: midnight },
      });
      for (const id of [work, personal]) {
        const r = s.get('Setup', id)!;
        setup(id, {
          ai: { ...r.ai!, capped: 3, sorted: r.ai!.sorted - 3, reasonCode: 'ai.dailyCap' },
        });
      }
      break;
    }
    case 'setup-partial':
      put('Meta', { ...s.get('Meta', 'meta')!, setup: {} });
      health(work, {
        status: {
          state: 'paused',
          until: now + 60_000,
          class: 'throttle',
          reason: 'rateLimitExceeded',
        },
        reasonCode: 'rate.minute',
      });
      setup(work, {
        state: 'paused',
        read: 6,
        done: false,
        pausedUntil: now + 60_000,
        reasonCode: 'rate.minute',
        ai: { sorted: 5, total: 6, capped: 0, failed: 1 },
        backfill: { read: 0, target: 9 },
        errors: [
          { phase: 'firstWindow', reasonCode: 'rate.minute', at: now },
          { phase: 'ai', reasonCode: 'ai.failed', at: now },
        ],
      });
      break;
    case 'parked':
      put('Meta', {
        ...s.get('Meta', 'meta')!,
        engine: {
          state: 'parked',
          parked: {
            reasonCode: 'crashLoop',
            message: 'Aplos stopped after repeated crashes.',
            at: now,
            canRetry: true,
          },
        },
      });
      break;
  }
}

/** Fills the store for a scenario. `empty` and `demo` are the C1 pair; most others are `demo` with one thing forced. */
export function buildScenario(fx: Fixture, scenario: Scenario) {
  const s = fx.store,
    now = fx.now;
  const put: Put = (table, row) => s.seed(table, row);
  if (scenario === 'small-10k' || scenario === 'large-100k') throw notYet(scenario);
  const withDemo = scenario !== 'empty';
  const aiOn = scenario !== 'ai-off';
  put('Meta', {
    id: 'meta',
    setup: withDemo ? { completedAt: now - 30 * day } : {},
    engine: { state: 'ready' },
    listener: { enabled: false },
    workflowSync: false,
    usage: { backgroundTokens: withDemo ? 12_400 : 0 },
    keys: { groq: aiOn ? { keySource: 'env' } : { keySource: 'none' } },
  });
  const settings = defaultSettings();
  if (!aiOn) settings.ai.background = false;
  put('Settings', { ...settings, id: 'settings' });
  const granted = withDemo && aiOn;
  put('Consent', {
    id: 'background',
    scope: 'background',
    granted,
    version: granted ? 1 : 0,
    currentVersion: 1,
    needsReconsent: false,
    ...(granted
      ? { provider: 'groq', model: 'openai/gpt-oss-120b', grantedAt: now - 30 * day }
      : {}),
  });
  if (!withDemo) return;
  insert(fx, demoData(now, fx.zone), put, granted);
  forceScenario(fx, put, scenario);
}
