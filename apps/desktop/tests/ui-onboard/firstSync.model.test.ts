// WP8.3: the first-sync screen tells the truth under Gmail's quota (DESIGN 7.12; plan 30 U8 "What ready means",
// acceptance 4; Appendix C F5, F8, F10, F11). Pure logic in node, plus static renders of the preview fixtures.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/firstSync.model.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_KEY_PREFS, createAppRegistry, type CommandContext, type ContextName } from '../../src/renderer/commands';
import { copyProblem } from '../../src/renderer/commands/internal';
import type { SetupAccount, SetupStatus } from '../../src/renderer/data';
import {
  AUTO_OPEN_DELAY_MS,
  COPY,
  buildFirstSyncView,
  firstSyncCommands,
  keyIntent,
  pauseLede,
  screenStrings,
  shouldSendRetry,
  tagColor,
  type AccountFacts,
  type FirstSyncInput,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import {
  DRILL_LETTERS,
  DRILL_START,
  drillCount,
  drillPick,
  drillPreset,
  drillReduce,
  type DrillState,
} from '../../src/renderer/onboarding/firstSync/drill.model';
import { FIXTURE_NOW, firstSyncScenes, firstSyncStates } from '../../src/renderer/onboarding/firstSync/states';
import { ProgressSegments } from '../../src/renderer/ui/status';
import type { SyncCheckpoint } from '../../src/renderer/ui/props';

/* ───────────────────────── helpers ───────────────────────── */

const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const at = (h: number, m = 0, day = 0) => new Date(2026, 9, 29 + day, h, m).getTime();
const A: AccountFacts = { id: 'a', address: 'jordan@example.com', colorTag: 'sky' };
const B: AccountFacts = { id: 'b', address: 'jordan@studio.example.org', colorTag: 'hill' };

function acct(id: string, patch: Partial<SetupAccount> = {}): SetupAccount {
  return {
    accountId: id,
    state: 'reading',
    firstWindow: { read: 24, total: 50, done: false },
    ai: { sorted: 0, total: 0, capped: 0, failed: 0 },
    backfill: { read: 0, target: 0 },
    runId: `${id}-1`,
    ...patch,
  };
}
const ready = (id: string, sorted = 40, total = 40, patch: Partial<SetupAccount> = {}) =>
  acct(id, {
    state: 'ready',
    firstWindow: { read: 50, total: 50, done: true },
    ai: { sorted, total, capped: 0, failed: 0 },
    ...patch,
  });
function status(accounts: SetupAccount[], patch: Partial<SetupStatus> = {}): SetupStatus {
  return { setupId: 's1', accounts, done: false, partial: false, errors: [], ...patch };
}
function view(s: SetupStatus | undefined, patch: Partial<FirstSyncInput> = {}): FirstSyncView {
  return buildFirstSyncView({ status: s, accounts: [A, B], aiProvider: 'Groq', consentStored: true, now: NOW, ...patch });
}
const cp = <S extends SyncCheckpoint['step']>(v: FirstSyncView, row: number, step: S) =>
  v.rows[row].checkpoints.find(c => c.step === step) as Extract<SyncCheckpoint, { step: S }> | undefined;

/** The checklist and status copy ProgressSegments writes for a view, plus the screen's own strings. */
function allText(v: FirstSyncView): string {
  const rows = v.rows
    .map(r =>
      renderToStaticMarkup(
        createElement(ProgressSegments, {
          variant: 'checkpoints',
          account: r.account,
          checkpoints: r.checkpoints,
          pausedUntil: r.pausedUntil,
          failure: r.failure,
          notConnected: r.notConnected,
          onRetry: r.action === 'retry' ? () => undefined : undefined,
        }),
      ),
    )
    .join('\n');
  return `${screenStrings(v).join('\n')}\n${rows.replace(/<[^>]+>/g, '\n')}`;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────── checkpoints ───────────────────────── */

describe('first sync: checkpoints follow the engine, never a fake percentage', () => {
  test('sync-found-estimate – "about N" only with an estimate; without one, Find is a quiet indeterminate step', () => {
    const withEstimate = view(status([acct('a', { firstWindow: { found: 214, read: 24, total: 50, done: false } })]));
    assert.deepEqual(cp(withEstimate, 0, 'find'), { step: 'find', state: 'done', estimate: 214 });
    assert.match(allText(withEstimate), /Found about 214 recent emails/);

    const without = view(status([acct('a')]));
    assert.deepEqual(cp(without, 0, 'find'), { step: 'find', state: 'done' });
    assert.match(allText(without), /Found recent mail/);
    assert.doesNotMatch(allText(without), /about/);

    const finding = view(status([acct('a', { state: 'finding', firstWindow: { read: 0, total: 50, done: false } })]));
    assert.deepEqual(cp(finding, 0, 'find'), { step: 'find', state: 'current' });
    assert.equal(cp(finding, 0, 'read')?.state, 'pending');
    assert.doesNotMatch(allText(finding), /\d+ of \d+/, 'no count while finding');
  });

  test('read counts n of the first window, never the mailbox or the backfill target', () => {
    const v = view(status([acct('a', { firstWindow: { found: 214, read: 24, total: 50, done: false }, backfill: { read: 0, target: 4_800 } })]));
    assert.deepEqual(cp(v, 0, 'read'), { step: 'read', state: 'current', read: 24, of: 50 });
    assert.doesNotMatch(allText(v), /4,?800/);
  });

  test('sync-small-mailbox – a 12-thread inbox reaches ready and reads "12 of 12", never "of 50"', () => {
    const running = view(status([acct('a', { firstWindow: { read: 12, total: 50, done: false } })]));
    const done = view(
      status([ready('a', 0, 0, { firstWindow: { read: 12, total: 12, done: true }, ai: undefined })], { done: true }),
      { previous: running },
    );
    assert.deepEqual(cp(done, 0, 'read'), { step: 'read', state: 'done', read: 12, of: 12 });
    assert.doesNotMatch(allText(done), /of 50/);
    assert.equal(done.canOpen, true);
  });

  test('a step still running never shows its full count (no 100% before the engine commits the window)', () => {
    const v = view(status([acct('a', { firstWindow: { read: 50, total: 50, done: false } })]));
    const read = cp(v, 0, 'read')!;
    assert.equal(read.state, 'current');
    assert.ok(read.read < read.of, `${read.read} of ${read.of}`);
    assert.equal(v.canOpen, false);
  });

  test('sort is omitted, never failed, with no provider, no consent, or an omission code', () => {
    const cases: [string, FirstSyncView][] = [
      ['no provider', view(status([acct('a')]), { aiProvider: null })],
      ['no consent', view(status([acct('a')]), { consentStored: false })],
      ['no ai block', view(status([acct('a', { ai: undefined })]))],
      ['ai.noConsent', view(status([acct('a', { ai: { sorted: 0, total: 40, capped: 0, failed: 0, reasonCode: 'ai.noConsent' } })]))],
      ['ai.accountExcluded', view(status([acct('a', { ai: { sorted: 0, total: 40, capped: 0, failed: 0, reasonCode: 'ai.accountExcluded' } })]))],
    ];
    for (const [name, v] of cases) {
      assert.deepEqual(v.rows[0].checkpoints.map(c => c.step), ['connect', 'find', 'read'], name);
      assert.equal(v.rows[0].failure, undefined, name);
      assert.equal(v.rows[0].sortFailed, false, name);
    }
  });

  test('onb-skip-ai-no-errors – no AI: three segments, and a clean finish still opens by itself', () => {
    const v = view(status([ready('a', 0, 0, { ai: undefined })], { done: true }), { aiProvider: null });
    assert.equal(v.rows[0].checkpoints.length, 3);
    assert.equal(v.outcome, 'ready');
    assert.equal(v.autoOpen, true);
  });
});

/* ───────────────────────── opening ───────────────────────── */

describe('first sync: when Aplos may open', () => {
  test('"Open Aplos" is enabled once one account\'s first window is in (sync-multi-open-early)', () => {
    const none = view(status([acct('a'), acct('b')]));
    assert.equal(none.canOpen, false);
    assert.deepEqual(none.primary, { label: 'Open Aplos', enabled: false });
    assert.equal(none.continueAnyway, true);

    const one = view(status([ready('a', 8, 40, { state: 'sorting' }), acct('b')]));
    assert.equal(one.canOpen, true);
    assert.deepEqual(one.primary, { label: 'Open Aplos', enabled: true });
    assert.equal(one.continueAnyway, false);
    assert.equal(one.autoOpen, false);
  });

  test('sync-autoenter-clean – auto-open only on a clean finish', () => {
    const v = view(status([ready('a'), ready('b', 20, 20)], { done: true }));
    assert.equal(v.outcome, 'ready');
    assert.equal(v.autoOpen, true);
    assert.deepEqual(v.primary, { label: 'Open now', enabled: true });
    assert.ok(AUTO_OPEN_DELAY_MS > 0);
  });

  test('sync-no-autoenter-unless-clean – never while paused, failed, capped, partial, erroring or still running', () => {
    const clean = [ready('a'), ready('b', 20, 20)];
    const cases: [string, SetupStatus][] = [
      ['paused after window', status([ready('a', 40, 40, { state: 'paused', pausedUntil: at(14, 14), reasonCode: 'rate.minute' }), clean[1]], { done: true })],
      ['pause time still ahead', status([ready('a', 40, 40, { pausedUntil: at(14, 14) }), clean[1]], { done: true })],
      ['capped', status([ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } }), clean[1]], { done: true, partial: true })],
      ['capped but engine says not partial', status([ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } }), clean[1]], { done: true })],
      ['ai failed', status([ready('a', 0, 40, { ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' } }), clean[1]], { done: true })],
      ['account failed', status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' }), clean[1]], { done: true })],
      ['not connected', status([acct('a', { state: 'notConnected' }), clean[1]], { done: true })],
      ['engine partial flag', status(clean, { done: true, partial: true })],
      ['engine not done', status(clean, { done: false })],
      ['an error recorded', status(clean, { done: true, errors: [{ accountId: 'a', phase: 'backfill', reasonCode: 'rate.minute', at: at(9) }] })],
      ['ready but sort short', status([ready('a', 30, 40), clean[1]], { done: true })],
      ['still sorting', status([ready('a', 30, 40, { state: 'sorting' }), clean[1]], { done: true })],
      ['row reason code', status([ready('a', 40, 40, { reasonCode: 'rate.minute' }), clean[1]], { done: true })],
      ['unknown state', status([ready('a', 40, 40, { state: 'importing' }), clean[1]], { done: true })],
    ];
    for (const [name, s] of cases) {
      const v = view(s);
      assert.equal(v.autoOpen, false, name);
      assert.notEqual(v.outcome, 'ready', name);
    }
  });

  test('sync-paused-before-window – Esc enters; the button waits; the lede never says the mail is ready', () => {
    const v = view(
      status([acct('a', { state: 'paused', firstWindow: { found: 214, read: 0, total: 50, done: false }, pausedUntil: at(14, 14), reasonCode: 'rate.minute' })]),
    );
    assert.equal(v.outcome, 'paused');
    assert.equal(v.canOpen, false);
    assert.equal(keyIntent(v, 'Escape'), 'open');
    assert.equal(keyIntent(v, 'Enter'), 'none');
    assert.equal(v.continueAnyway, true);
    assert.equal(v.lede, 'Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first.');
    assert.doesNotMatch(v.lede, /ready now/);
    assert.equal(cp(v, 0, 'read')?.state, 'paused');
    assert.ok(v.rows[0].pausedUntil?.startsWith('2026-10-29T14:14'));
  });

  test('sync-paused-after-window – Open Aplos works, no mailbox total, the lede says the newest mail is ready', () => {
    const v = view(
      status([ready('a', 40, 40, { state: 'paused', pausedUntil: at(14, 14), reasonCode: 'rate.minute', backfill: { read: 120, target: 500 } })], { done: true }),
    );
    assert.equal(v.outcome, 'paused');
    assert.equal(v.canOpen, true);
    assert.equal(v.autoOpen, false);
    assert.equal(v.title, COPY.titleIn);
    assert.equal(v.lede, 'Google asked us to slow down. Resuming at 2:14 PM. Your newest mail is ready now; older mail will follow.');
    assert.doesNotMatch(allText(v), /500/);
  });

  test('pause copy: daily limit says tomorrow once; no resume time falls back to DESIGN 7.12; a past time is never shown', () => {
    assert.equal(
      pauseLede('quota.daily', at(0, 0, 1), NOW, false),
      "Google's daily limit is reached. Resuming tomorrow. Your newest mail will appear first.",
    );
    assert.equal(pauseLede('rate.minute', undefined, NOW, true), `${COPY.pauseFallback} ${COPY.pauseAfterWindow}`);
    assert.equal(pauseLede(undefined, undefined, NOW, false), `${COPY.pauseFallback} ${COPY.pauseBeforeWindow}`);
    assert.equal(
      pauseLede('rate.minute', at(9, 0, 1), NOW, false),
      'Google asked us to slow down. Resuming tomorrow at 9:00 AM. Your newest mail will appear first.',
    );
    const stale = view(status([acct('a', { state: 'paused', pausedUntil: at(9, 30), reasonCode: 'rate.minute' })]));
    assert.equal(stale.rows[0].pausedUntil, undefined);
    assert.doesNotMatch(stale.lede, /9:30/);
    const tomorrow = view(status([acct('a', { state: 'paused', pausedUntil: at(0, 0, 1), reasonCode: 'quota.daily' })]));
    assert.equal(tomorrow.rows[0].pausedUntil, undefined, 'the row never says "Paused until 12:00 AM" for tomorrow');
  });
});

/* ───────────────────────── honest outcomes [F10] ───────────────────────── */

describe('first sync: honest outcomes [F10]', () => {
  test('F10 capped or failed sort never says Done; partial and failed copy shown', () => {
    const partial = view(
      status([ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } })], { done: true, partial: true }),
    );
    assert.equal(partial.outcome, 'partial');
    assert.deepEqual(cp(partial, 0, 'sort'), { step: 'sort', state: 'partial', sorted: 12, of: 40 });
    assert.match(allText(partial), /Sorted 12 of 40\. The rest continue in the background\./);
    assert.equal(partial.title, 'Your newest mail is in');
    assert.equal(partial.lede, 'Aplos waits for you. Older mail follows after you open it.');
    assert.doesNotMatch(allText(partial), /\bDone\b|100%/);

    const failed = view(
      status([ready('a', 0, 40, { ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' } })], { done: true, partial: true }),
    );
    assert.equal(cp(failed, 0, 'sort')?.state, 'failed');
    assert.deepEqual(failed.rows[0].failure, { kind: 'sortFailed', provider: 'Groq', cause: 'keyRefused' });
    assert.equal(failed.rows[0].sortFailed, true);
    assert.equal(failed.canOpen, true, 'mail is ready even though sorting failed');
    assert.doesNotMatch(allText(failed), /\bDone\b/);
  });

  test('sync-ai-failure-copy – "Couldn\'t sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings', () => {
    const v = view(status([ready('a', 0, 40, { ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' } })]));
    assert.match(allText(v).replace(/&#x27;|’/g, "'"), /Couldn't sort with Groq: the key was refused\. Mail is ready; sorting will retry\./);
    const markup = renderToStaticMarkup(firstSyncStates['ai-failed'].render());
    assert.match(markup, /Open Settings/);
  });

  test('failed: each account says its plain reason (copy.ts), with Try again, Reconnect, or nothing for an admin block', () => {
    const v = view(
      status([
        acct('a', { state: 'failed', reasonCode: 'server.unavailable' }),
        acct('b', { state: 'failed', firstWindow: { read: 0, total: 50, done: false }, reasonCode: 'auth.expired' }),
      ]),
    );
    assert.equal(v.outcome, 'failed');
    assert.equal(v.title, 'Some mail didn’t come through');
    assert.deepEqual(v.primary, { label: 'Continue to Aplos', enabled: true });
    assert.equal(v.rows[0].action, 'retry');
    assert.deepEqual(v.rows[0].failure, { kind: 'reason', text: "Google isn't answering right now. Aplos will try again.", retryable: true });
    assert.equal(v.rows[1].action, 'reconnect');
    assert.equal(cp(v, 1, 'connect')?.state, 'failed', 'with no sign of a connection, Connected is never claimed');
    const lapsed = view(
      status([acct('a', { state: 'failed', firstWindow: { read: 0, total: 50, done: false }, reasonCode: 'auth.expired' })], {
        errors: [{ accountId: 'a', phase: 'firstWindow', reasonCode: 'auth.expired', at: at(9) }],
      }),
    );
    assert.equal(cp(lapsed, 0, 'connect')?.state, 'done', 'a sign-in that lapsed while finding still shows Connected');
    assert.equal(lapsed.rows[0].action, 'reconnect');

    const admin = view(status([acct('a', { state: 'failed', firstWindow: { read: 0, total: 50, done: false }, reasonCode: 'auth.adminPolicy' })]));
    assert.equal(admin.rows[0].action, 'none');
    assert.match((admin.rows[0].failure as { text: string }).text, /administrator/);

    const connectFail = view(
      status([acct('a', { state: 'failed', firstWindow: { read: 0, total: 50, done: false }, reasonCode: 'net.offline' })], {
        errors: [{ accountId: 'a', phase: 'connect', reasonCode: 'net.offline', at: at(9) }],
      }),
    );
    assert.equal(cp(connectFail, 0, 'connect')?.state, 'failed');
  });

  test('sync-not-connected-row – a skipped account shows "Not connected · Try again", never "Waiting"', () => {
    const v = view(status([acct('a'), acct('b', { state: 'notConnected', firstWindow: { read: 0, total: 0, done: false } })]));
    const row = v.rows[1];
    assert.equal(row.notConnected, true);
    assert.equal(row.action, 'retry');
    assert.ok(row.checkpoints.every(c => c.state === 'pending'), 'no spinner on a row that is not running');
    const text = allText(v);
    assert.match(text, /Not connected/);
    assert.match(text, /Try again/);
    assert.doesNotMatch(text, /Waiting/i);
  });

  test('no copy on any fixture breaks DESIGN 10, says Done for the pass, or names a mailbox total', () => {
    for (const [name, { scene }] of Object.entries(firstSyncScenes)) {
      const v = buildFirstSyncView({
        status: scene.status,
        accounts: [
          { id: 'acc-alex', address: 'alex.moreno@example.com', colorTag: 'sky' },
          { id: 'acc-studio', address: 'alex@studio.example.org', colorTag: 'hill' },
        ],
        aiProvider: scene.aiProvider === undefined ? 'Groq' : scene.aiProvider,
        consentStored: scene.consentStored ?? true,
        now: FIXTURE_NOW,
      });
      for (const line of screenStrings(v)) assert.equal(copyProblem(line), null, `${name}: ${line}`);
      if (!scene.drill) assert.doesNotMatch(allText(v), /\bDone\b|100%|Testing mode|verification/, name);
      assert.doesNotMatch(allText(v), /\b500\b|4,?800/, `${name}: no backfill or mailbox total`);
    }
  });
});

/* ───────────────────────── counters [F5] ───────────────────────── */

describe('first sync: counters never move backwards [F5]', () => {
  test('within a run, a lower count from the engine never lowers the screen', () => {
    const v1 = view(status([acct('a', { firstWindow: { read: 30, total: 50, done: false }, ai: undefined })]));
    const v2 = view(status([acct('a', { firstWindow: { read: 22, total: 50, done: false }, ai: undefined })]), { previous: v1 });
    assert.equal(cp(v2, 0, 'read')?.read, 30);
    const v3 = view(status([acct('a', { firstWindow: { read: 31, total: 40, done: false }, ai: undefined })]), { previous: v2 });
    assert.deepEqual(cp(v3, 0, 'read'), { step: 'read', state: 'current', read: 31, of: 50 }, 'the total never shrinks while reading');
  });

  test('F5 Retry twice during a running pass: one run per click, no collision, counters never decrease', () => {
    const failed = view(status([acct('a', { state: 'failed', firstWindow: { read: 24, total: 50, done: false }, reasonCode: 'server.unavailable' })]));
    // Two presses while the first is in flight send once.
    const inFlight = new Set<string>();
    assert.equal(shouldSendRetry(failed, 'a', inFlight), true);
    inFlight.add('a');
    assert.equal(shouldSendRetry(failed, 'a', inFlight), false);
    assert.equal(shouldSendRetry(failed, 'missing', new Set()), false);

    // The retry starts run 2; a late update from run 1 must not drag the screen back.
    const r2a = view(status([acct('a', { runId: 'a-2', firstWindow: { read: 26, total: 50, done: false } })]), { previous: failed });
    assert.equal(cp(r2a, 0, 'read')?.read, 26);
    const stale = view(status([acct('a', { runId: 'a-1', state: 'failed', firstWindow: { read: 10, total: 50, done: false }, reasonCode: 'server.unavailable' })]), {
      previous: r2a,
    });
    assert.equal(stale.outcome, 'progress', 'a superseded run cannot flip the screen to failed');
    assert.equal(cp(stale, 0, 'read')?.read, 26);
    const r2b = view(status([acct('a', { runId: 'a-2', firstWindow: { read: 25, total: 50, done: false } })]), { previous: stale });
    assert.equal(cp(r2b, 0, 'read')?.read, 26, 'the same run never moves backwards');
    // A row with nothing to retry never sends.
    assert.equal(shouldSendRetry(r2b, 'a', new Set()), false);
  });

  test('sync-retry-idempotent-F5 – the retry of a running row is not offered and not sent', () => {
    const running = view(status([acct('a')]));
    assert.equal(running.rows[0].action, 'none');
    assert.equal(shouldSendRetry(running, 'a', new Set()), false);
  });

  test('sync-never-backwards – property: random engine sequences within one run never make the screen lie', () => {
    const rand = prng(20261029);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const STATES = ['connecting', 'finding', 'reading', 'sorting', 'ready', 'paused', 'importing'];
    const RUNS = 300;
    const STEPS = 30;
    let checked = 0;
    for (let run = 0; run < RUNS; run++) {
      let previous: FirstSyncView | undefined;
      let fwDoneSeen = false;
      const totalsSeen = new Set<number>();
      let maxRead = 0;
      let maxSorted = 0;
      let sortDoneSeen = false;
      let lastOfWhileReading = 0;
      let lastPhase = '';
      let lastAnnouncement = '';
      const aiOn = rand() < 0.7;
      const provider = rand() < 0.85 ? 'Groq' : null;
      const consent = rand() < 0.85;
      for (let step = 0; step < STEPS; step++) {
        const total = pick([50, 50, 50, 12, 40, 0]);
        totalsSeen.add(total);
        const done = rand() < 0.25;
        const aiTotal = pick([0, 20, 40]);
        const a = acct('a', {
          state: pick(STATES),
          firstWindow: {
            found: rand() < 0.4 ? pick([120, 214, 300]) : undefined,
            read: Math.floor(rand() * 60),
            total,
            done,
          },
          ai: aiOn
            ? {
                sorted: Math.floor(rand() * (aiTotal + 5)),
                total: aiTotal,
                capped: rand() < 0.15 ? 5 : 0,
                failed: rand() < 0.1 ? 3 : 0,
                reasonCode: rand() < 0.1 ? pick(['ai.missingKey', 'ai.rateLimited', 'ai.noConsent'] as const) : undefined,
              }
            : undefined,
          backfill: { read: Math.floor(rand() * 900), target: 4_800 },
          pausedUntil: rand() < 0.2 ? NOW + Math.floor(rand() * 7_200_000) - 1_800_000 : undefined,
          reasonCode: rand() < 0.15 ? pick(['rate.minute', 'quota.daily'] as const) : undefined,
        });
        const s = status([a], { done: rand() < 0.5, partial: rand() < 0.3 });
        const v = buildFirstSyncView({ status: s, accounts: [A], aiProvider: provider, consentStored: consent, now: NOW, previous });
        const read = cp(v, 0, 'read')!;
        const sort = cp(v, 0, 'sort');
        fwDoneSeen ||= done;

        // Counters never decrease within the run.
        assert.ok(read.read >= maxRead, `read went ${maxRead} → ${read.read}`);
        maxRead = read.read;
        if (sort) {
          assert.ok(sort.sorted >= maxSorted, `sorted went ${maxSorted} → ${sort.sorted}`);
          maxSorted = sort.sorted;
        }
        // No Done, and no full count, before it is true.
        if (read.state === 'done') assert.ok(fwDoneSeen, 'read done before the engine committed the window');
        else {
          assert.ok(read.of === 0 || read.read < read.of, `running read shows ${read.read} of ${read.of}`);
          assert.ok(read.of >= lastOfWhileReading, 'the first-window total shrank while reading');
          lastOfWhileReading = read.of;
        }
        // The total is the first window: a value the engine gave as firstWindow.total, or the count itself once done.
        assert.ok(totalsSeen.has(read.of) || (read.state === 'done' && read.of === read.read), `of ${read.of}`);
        assert.notEqual(read.of, 4_800);
        if (sort) {
          assert.ok(provider && consent, 'sort shown without a provider and consent');
          const ai = a.ai!;
          const trueNow =
            ai.sorted >= ai.total && ai.total > 0 && ai.capped === 0 && ai.failed === 0 && a.state !== 'sorting' && fwDoneSeen;
          if (sort.state === 'done') {
            assert.ok(trueNow || sortDoneSeen, 'sort done before it was ever true in this run');
            sortDoneSeen = true;
          } else assert.ok(sort.of === 0 || sort.sorted < sort.of || sort.state === 'failed', `running sort shows ${sort.sorted} of ${sort.of}`);
          if (ai.capped > 0 && !sortDoneSeen && sort.state !== 'failed' && sort.state !== 'pending') assert.equal(sort.state, 'partial');
        }
        // Never auto-open unless every fact is clean.
        if (v.autoOpen) {
          assert.equal(a.state, 'ready');
          assert.ok(s.done && !s.partial && s.errors.length === 0);
          assert.ok(!(a.pausedUntil && a.pausedUntil > NOW));
          assert.equal(a.reasonCode, undefined);
          assert.ok(!a.ai || !provider || !consent || (a.ai.capped === 0 && a.ai.failed === 0));
        }
        if (v.outcome === 'paused' || v.outcome === 'failed' || v.outcome === 'partial') assert.equal(v.autoOpen, false);
        // Esc always opens; the live region changes only with the phase.
        assert.equal(keyIntent(v, 'Escape'), 'open');
        if (v.announcement !== lastAnnouncement) assert.notEqual(v.phase, lastPhase, 'announcement changed within a phase');
        lastPhase = v.phase;
        lastAnnouncement = v.announcement;
        // No banned words on the pass (the rendered checklist, sampled to keep the run short).
        for (const line of screenStrings(v)) assert.doesNotMatch(line, /\bDone\b|100%|4,?800/);
        if (step % 10 === 9) assert.doesNotMatch(allText(v), /\bDone\b|100%|4,?800/);
        previous = v;
        checked++;
      }
    }
    assert.equal(checked, RUNS * STEPS);
  });
});

/* ───────────────────────── Esc [F8] and keys ───────────────────────── */

describe('first sync: Esc always opens Aplos [F8]', () => {
  const ctx = (stack: ContextName[]): CommandContext => ({
    stack,
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
  });
  const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });

  function wired(v: FirstSyncView, drill: DrillState | null) {
    const registry = createAppRegistry();
    const calls: string[] = [];
    let current = drill;
    const handlers = firstSyncCommands({
      view: () => v,
      drillOpen: () => current !== null,
      onOpen: () => calls.push('open'),
      onDrill: k => {
        calls.push(`drill:${k}`);
        if (current) current = drillReduce(current, k);
      },
      onLeaveDrill: () => {
        calls.push('leave');
        current = null;
      },
    });
    for (const [id, h] of Object.entries(handlers)) registry.attach(id, h);
    const press = (k: string, stack: ContextName[]) => {
      const c = ctx(stack);
      const r = registry.resolve(key(k), c);
      if (r) registry.run(r.commandId, c);
      return r?.commandId ?? null;
    };
    return { calls, press, state: () => current };
  }

  test('keys-sync-esc-every-state-F8 – Esc opens Aplos in every fixture state, including the failed screen and inside the drill', () => {
    for (const [name, { scene }] of Object.entries(firstSyncScenes)) {
      const v = buildFirstSyncView({
        status: scene.status,
        accounts: [A],
        aiProvider: 'Groq',
        consentStored: true,
        now: FIXTURE_NOW,
      });
      const stack: ContextName[] = scene.drill ? ['onboarding', 'firstSync', 'drill'] : ['onboarding', 'firstSync'];
      const w = wired(v, scene.drill ?? null);
      assert.equal(w.press('Escape', stack), 'onboarding.openAplos', name);
      assert.deepEqual(w.calls, ['open'], name);
    }
  });

  test('F8 failed screen: Esc continues to Aplos, and Return does too', () => {
    const v = view(status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' })]));
    assert.equal(v.primary.label, 'Continue to Aplos');
    const w = wired(v, null);
    w.press('Escape', ['onboarding', 'firstSync']);
    w.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(w.calls, ['open', 'open']);
  });

  test('Return opens Aplos only once the button is on; before that it does nothing', () => {
    const waiting = wired(view(status([acct('a')])), null);
    waiting.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(waiting.calls, []);
    const inn = wired(view(status([ready('a', 8, 40, { state: 'sorting' })])), null);
    inn.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(inn.calls, ['open']);
  });

  test('keys-drill-letters – J/K, Space, E, A advance the drill through the registry; Return goes back to progress', () => {
    const w = wired(view(status([acct('a')])), DRILL_START);
    const drill: ContextName[] = ['onboarding', 'firstSync', 'drill'];
    for (const k of ['j', ' ', 'e', 'a']) w.press(k, drill);
    assert.equal(w.state()?.step, 4);
    w.press('Enter', drill);
    assert.deepEqual(w.calls, ['drill:next', 'drill:suggested', 'drill:done', 'drill:ask', 'leave']);
    assert.equal(w.press('e', ['onboarding', 'firstSync']), null, 'E outside the drill does nothing');
  });
});

/* ───────────────────────── one announcement per phase [F11] ───────────────────────── */

describe('first sync: one status announcement per phase [F11]', () => {
  test('F11 a full run announces connected, found, ready – and counting never re-announces', () => {
    const steps: SetupAccount[] = [
      acct('a', { state: 'connecting', firstWindow: { read: 0, total: 50, done: false } }),
      acct('a', { state: 'finding', firstWindow: { read: 0, total: 50, done: false } }),
      acct('a', { state: 'reading', firstWindow: { read: 0, total: 50, done: false } }),
      ...[5, 12, 24, 38, 49].map(n => acct('a', { firstWindow: { read: n, total: 50, done: false } })),
      ready('a', 0, 40, { state: 'sorting' }),
      ...[8, 20, 33].map(n => ready('a', n, 40, { state: 'sorting' })),
      ready('a', 40, 40),
    ];
    let previous: FirstSyncView | undefined;
    const said: string[] = [];
    for (const [i, a] of steps.entries()) {
      const v = view(status([a], { done: i === steps.length - 1 }), { previous });
      if (v.announcement !== (previous?.announcement ?? '')) said.push(v.announcement);
      previous = v;
    }
    assert.deepEqual(said, [
      'Connected. Finding your recent mail.',
      'Found your recent mail. Reading the newest first.',
      'Your newest mail is in. Aplos can open now.',
    ]);
    assert.equal(previous?.autoOpen, true);
  });

  test('a failure is announced once, and the region text depends on the phase only', () => {
    const v = view(status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' })]));
    assert.equal(v.phase, 'failed');
    assert.equal(v.announcement, 'Some mail didn’t come through.');
    const again = view(status([acct('a', { state: 'failed', firstWindow: { read: 30, total: 50, done: false }, reasonCode: 'server.unavailable' })]), {
      previous: v,
    });
    assert.equal(again.announcement, v.announcement);
  });

  test('the screen passes the announcement to the one OnboardingStep status region', () => {
    const markup = renderToStaticMarkup(firstSyncStates.progress.render());
    assert.match(markup, /<p class="ui-onboarding-step__sr" role="status">Found your recent mail\. Reading the newest first\.<\/p>/);
  });

  test.todo(
    'F11 exactly one live region on the screen – blocked: ProgressSegments renders its own role="status" per account and in the ready variant (REQUEST R2 to ui-foundation); dom + axe once the Playwright base exists',
  );
});

/* ───────────────────────── fixtures render ───────────────────────── */

describe('first sync: preview fixtures', () => {
  const REQUIRED = [
    'progress',
    'progress-estimate',
    'paused',
    'paused-before-first-window',
    'ready',
    'partial',
    'ai-failed',
    'no-ai',
    'failed',
    'not-connected',
    'multi-account',
    'drill-step1',
    'drill-step3',
    'drill-done',
  ];

  test('every required state exists with a title and renders', () => {
    for (const name of REQUIRED) assert.ok(firstSyncStates[name], `missing ${name}`);
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      assert.ok(entry.title.length > 0, name);
      const markup = renderToStaticMarkup(entry.render());
      assert.ok(markup.length > 0, name);
    }
  });

  test('design-one-filled-button – exactly one filled button in every state (a disabled Open Aplos still counts)', () => {
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      const markup = renderToStaticMarkup(entry.render());
      const filled = markup.match(/<button[^>]*data-variant="filled"/g) ?? [];
      assert.equal(filled.length, 1, `${name}: ${filled.length} filled buttons`);
    }
  });

  test('"Esc opens Aplos" is said on every state; bars are labelled "<address> sync"; no AI glyph', () => {
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      const markup = renderToStaticMarkup(entry.render());
      assert.match(markup, /<kbd[^>]*>Esc<\/kbd> opens Aplos/, name);
      for (const m of markup.matchAll(/role="progressbar"[^>]*aria-label="([^"]*)"/g)) assert.match(m[1], / sync$/, name);
      assert.doesNotMatch(markup, /sparkle|wand|lucide-star|brain|backdrop-filter|gradient/i, name);
    }
  });

  test('the ready state shows the drawn check and "Your mail is ready"; partial never does', () => {
    assert.match(renderToStaticMarkup(firstSyncStates.ready.render()), /Your mail is ready/);
    for (const name of ['partial', 'ai-failed', 'paused', 'failed']) {
      assert.doesNotMatch(renderToStaticMarkup(firstSyncStates[name].render()), /Your mail is ready|opens by itself/, name);
    }
  });

  test('tagColor maps colour names and falls back to sky', () => {
    assert.equal(tagColor('hill'), 'hill');
    assert.equal(tagColor('tag-dusk'), 'dusk');
    assert.equal(tagColor('--tag-ember'), 'ember');
    assert.equal(tagColor('purple'), 'sky');
    assert.equal(tagColor(undefined), 'sky');
  });

  test('starting and empty never wait forever: Esc and a pointer path open Aplos', () => {
    const starting = view(undefined);
    assert.equal(starting.outcome, 'starting');
    assert.equal(starting.continueAnyway, true);
    const empty = view(status([]));
    assert.equal(empty.outcome, 'empty');
    assert.deepEqual(empty.primary, { label: 'Continue to Aplos', enabled: true });
  });
});

/* ───────────────────────── the drill ───────────────────────── */

describe('first sync: Try the keys', () => {
  test('the drill walks J/K → Space → E → A, ignores keys out of turn, and Z brings a letter back', () => {
    let s = DRILL_START;
    assert.equal(drillCount(s), '1 of 4');
    s = drillReduce(s, 'suggested');
    assert.equal(s.step, 0, 'Space before moving does nothing');
    s = drillReduce(s, 'next');
    assert.deepEqual([s.step, s.cursor], [1, 1]);
    s = drillReduce(s, 'done');
    assert.equal(s.step, 1, 'E out of turn does nothing');
    s = drillReduce(s, 'suggested');
    assert.deepEqual([s.step, s.ran], [2, true]);
    s = drillReduce(s, 'done');
    assert.deepEqual([s.step, s.ids.length, s.ran], [3, 2, false]);
    const undone = drillReduce(s, 'undo');
    assert.deepEqual(undone.ids, DRILL_LETTERS.map(l => l.id));
    s = drillReduce(s, 'ask');
    assert.equal(s.step, 4);
    assert.equal(drillReduce(s, 'next'), s, 'keys do nothing after the end');
    assert.equal(drillPick(DRILL_START, 2).cursor, 2);
    assert.equal(drillPick(DRILL_START, 2).step, 1);
  });

  test('presets match the mockup states', () => {
    assert.equal(drillPreset('step1').step, 0);
    assert.deepEqual([drillPreset('step3').step, drillPreset('step3').ran], [2, true]);
    assert.deepEqual([drillPreset('done').step, drillPreset('done').ids.length], [4, 2]);
  });

  test('drill-no-engine-calls – the practice letters are invented and the drill files import no data hooks or api', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['Drill.tsx', 'drill.model.ts']) {
      const src = await readFile(new URL(`../../src/renderer/onboarding/firstSync/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /\buse(SetupStatus|Accounts|View|Row|Home|Consent|Settings)\b|\bapi\./, file);
    }
    for (const l of DRILL_LETTERS) assert.doesNotMatch(`${l.sender} ${l.subject} ${l.summary}`, /@(?!example)/);
  });

  test('no auto-open while the drill is open (UNCLEAR-10) – container behaviour, dom', { todo: 'needs the Playwright base' }, () => undefined);
});
