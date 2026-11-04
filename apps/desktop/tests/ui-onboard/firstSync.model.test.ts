// WP8.3: the first-sync screen tells the truth under Gmail's quota (DESIGN 7.12; plan 30 U8 "What ready means",
// acceptance 4; Appendix C F5, F8, F10, F11). Pure logic in node, plus static renders of the preview fixtures.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/firstSync.model.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../src/renderer/commands/internal';
import type { SetupStatus } from '../../src/renderer/data';
import {
  AUTO_OPEN_DELAY_MS,
  COPY,
  buildFirstSyncView,
  keyIntent,
  pauseLede,
  screenStrings,
  shouldSendRetry,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import {
  FIXTURE_NOW,
  firstSyncScenes,
  firstSyncStates,
} from '../../src/renderer/onboarding/firstSync/states';
import {
  A,
  NOW,
  acct,
  allText,
  assertHonestStep,
  at,
  cp,
  newRun,
  prng,
  ready,
  status,
  view,
} from './firstSync.helpers';

/* ───────────────────────── checkpoints ───────────────────────── */

describe('first sync: checkpoints follow the engine, never a fake percentage', () => {
  test('sync-found-estimate – "about N" only with an estimate; without one, Find is a quiet indeterminate step', () => {
    const withEstimate = view(
      status([acct('a', { firstWindow: { found: 214, read: 24, total: 50, done: false } })]),
    );
    assert.deepEqual(cp(withEstimate, 0, 'find'), { step: 'find', state: 'done', estimate: 214 });
    assert.match(allText(withEstimate), /Found about 214 recent emails/);

    const without = view(status([acct('a')]));
    assert.deepEqual(cp(without, 0, 'find'), { step: 'find', state: 'done' });
    assert.match(allText(without), /Found recent mail/);
    assert.doesNotMatch(allText(without), /about/);

    const finding = view(
      status([acct('a', { state: 'finding', firstWindow: { read: 0, total: 50, done: false } })]),
    );
    assert.deepEqual(cp(finding, 0, 'find'), { step: 'find', state: 'current' });
    assert.equal(cp(finding, 0, 'read')?.state, 'pending');
    assert.doesNotMatch(allText(finding), /\d+ of \d+/, 'no count while finding');
  });

  test('read counts n of the first window, never the mailbox or the backfill target', () => {
    const v = view(
      status([
        acct('a', {
          firstWindow: { found: 214, read: 24, total: 50, done: false },
          backfill: { read: 0, target: 4_800 },
        }),
      ]),
    );
    assert.deepEqual(cp(v, 0, 'read'), { step: 'read', state: 'current', read: 24, of: 50 });
    assert.doesNotMatch(allText(v), /4,?800/);
  });

  test('sync-small-mailbox – a 12-thread inbox reaches ready and reads "12 of 12", never "of 50"', () => {
    const running = view(
      status([acct('a', { firstWindow: { read: 12, total: 50, done: false } })]),
    );
    const done = view(
      status(
        [ready('a', 0, 0, { firstWindow: { read: 12, total: 12, done: true }, ai: undefined })],
        { done: true },
      ),
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
      [
        'ai.noConsent',
        view(
          status([
            acct('a', {
              ai: { sorted: 0, total: 40, capped: 0, failed: 0, reasonCode: 'ai.noConsent' },
            }),
          ]),
        ),
      ],
      [
        'ai.accountExcluded',
        view(
          status([
            acct('a', {
              ai: { sorted: 0, total: 40, capped: 0, failed: 0, reasonCode: 'ai.accountExcluded' },
            }),
          ]),
        ),
      ],
    ];
    for (const [name, v] of cases) {
      assert.deepEqual(
        v.rows[0].checkpoints.map(c => c.step),
        ['connect', 'find', 'read'],
        name,
      );
      assert.equal(v.rows[0].failure, undefined, name);
      assert.equal(v.rows[0].sortFailed, false, name);
    }
  });

  test('onb-skip-ai-no-errors – no AI: three segments, and a clean finish still opens by itself', () => {
    const v = view(status([ready('a', 0, 0, { ai: undefined })], { done: true }), {
      aiProvider: null,
    });
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
      [
        'paused after window',
        status(
          [
            ready('a', 40, 40, {
              state: 'paused',
              pausedUntil: at(14, 14),
              reasonCode: 'rate.minute',
            }),
            clean[1],
          ],
          { done: true },
        ),
      ],
      [
        'pause time still ahead',
        status([ready('a', 40, 40, { pausedUntil: at(14, 14) }), clean[1]], { done: true }),
      ],
      [
        'capped',
        status(
          [ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } }), clean[1]],
          { done: true, partial: true },
        ),
      ],
      [
        'capped but engine says not partial',
        status(
          [ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } }), clean[1]],
          { done: true },
        ),
      ],
      [
        'ai failed',
        status(
          [
            ready('a', 0, 40, {
              ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' },
            }),
            clean[1],
          ],
          { done: true },
        ),
      ],
      [
        'account failed',
        status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' }), clean[1]], {
          done: true,
        }),
      ],
      ['not connected', status([acct('a', { state: 'notConnected' }), clean[1]], { done: true })],
      ['engine partial flag', status(clean, { done: true, partial: true })],
      ['engine not done', status(clean, { done: false })],
      [
        'an error recorded',
        status(clean, {
          done: true,
          errors: [{ accountId: 'a', phase: 'firstWindow', reasonCode: 'rate.minute', at: at(9) }],
        }),
      ],
      ['ready but sort short', status([ready('a', 30, 40), clean[1]], { done: true })],
      [
        'still sorting',
        status([ready('a', 30, 40, { state: 'sorting' }), clean[1]], { done: true }),
      ],
      [
        'row reason code',
        status([ready('a', 40, 40, { reasonCode: 'rate.minute' }), clean[1]], { done: true }),
      ],
      [
        'unknown state',
        status([ready('a', 40, 40, { state: 'importing' }), clean[1]], { done: true }),
      ],
    ];
    for (const [name, s] of cases) {
      const v = view(s);
      assert.equal(v.autoOpen, false, name);
      assert.notEqual(v.outcome, 'ready', name);
    }
  });

  test('sync-paused-before-window – Esc enters; the button waits; the lede never says the mail is ready', () => {
    const v = view(
      status([
        acct('a', {
          state: 'paused',
          firstWindow: { found: 214, read: 0, total: 50, done: false },
          pausedUntil: at(14, 14),
          reasonCode: 'rate.minute',
        }),
      ]),
    );
    assert.equal(v.outcome, 'paused');
    assert.equal(v.canOpen, false);
    assert.equal(keyIntent(v, 'Escape'), 'open');
    assert.equal(keyIntent(v, 'Enter'), 'none');
    assert.equal(v.continueAnyway, true);
    assert.equal(
      v.lede,
      'Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first.',
    );
    assert.doesNotMatch(v.lede, /ready now/);
    assert.equal(cp(v, 0, 'read')?.state, 'paused');
    assert.ok(v.rows[0].pausedUntil?.startsWith('2026-10-29T14:14'));
  });

  test('sync-paused-after-window – Open Aplos works, no mailbox total, the lede says the newest mail is ready', () => {
    const v = view(
      status(
        [
          ready('a', 40, 40, {
            state: 'paused',
            pausedUntil: at(14, 14),
            reasonCode: 'rate.minute',
            backfill: { read: 120, target: 500 },
          }),
        ],
        { done: true },
      ),
    );
    assert.equal(v.outcome, 'paused');
    assert.equal(v.canOpen, true);
    assert.equal(v.autoOpen, false);
    assert.equal(v.title, COPY.titleIn);
    assert.equal(
      v.lede,
      'Google asked us to slow down. Resuming at 2:14 PM. Your newest mail is ready now; older mail will follow.',
    );
    assert.doesNotMatch(allText(v), /500/);
  });

  test('pause copy: daily limit says tomorrow once; no resume time falls back to DESIGN 7.12; a past time is never shown', () => {
    assert.equal(
      pauseLede('quota.daily', at(0, 0, 1), NOW, false),
      'Google’s daily limit is reached. Resuming tomorrow. Your newest mail will appear first.',
    );
    assert.equal(
      pauseLede('rate.minute', undefined, NOW, true),
      `${COPY.pauseFallback} ${COPY.pauseAfterWindow}`,
    );
    assert.equal(
      pauseLede(undefined, undefined, NOW, false),
      `${COPY.pauseFallback} ${COPY.pauseBeforeWindow}`,
    );
    assert.equal(
      pauseLede('rate.minute', at(9, 0, 1), NOW, false),
      'Google asked us to slow down. Resuming tomorrow at 9:00 AM. Your newest mail will appear first.',
    );
    const stale = view(
      status([acct('a', { state: 'paused', pausedUntil: at(9, 30), reasonCode: 'rate.minute' })]),
    );
    assert.equal(stale.rows[0].pausedUntil, undefined);
    assert.doesNotMatch(stale.lede, /9:30/);
    const tomorrow = view(
      status([acct('a', { state: 'paused', pausedUntil: at(0, 0, 1), reasonCode: 'quota.daily' })]),
    );
    assert.equal(
      tomorrow.rows[0].pausedUntil,
      undefined,
      'the row never says "Paused until 12:00 AM" for tomorrow',
    );
  });
});

/* ───────────────────────── honest outcomes [F10] ───────────────────────── */

describe('first sync: honest outcomes [F10]', () => {
  test('F10 capped or failed sort never says Done; partial and failed copy shown', () => {
    const partial = view(
      status([ready('a', 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } })], {
        done: true,
        partial: true,
      }),
    );
    assert.equal(partial.outcome, 'partial');
    assert.deepEqual(cp(partial, 0, 'sort'), {
      step: 'sort',
      state: 'partial',
      sorted: 12,
      of: 40,
    });
    assert.match(allText(partial), /Sorted 12 of 40\. The rest continue in the background\./);
    assert.equal(partial.title, 'Your newest mail is in');
    assert.equal(partial.lede, 'Aplos waits for you. Older mail follows after you open it.');
    assert.doesNotMatch(allText(partial), /\bDone\b|100%/);

    const failed = view(
      status(
        [
          ready('a', 0, 40, {
            ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' },
          }),
        ],
        { done: true, partial: true },
      ),
    );
    assert.equal(cp(failed, 0, 'sort')?.state, 'failed');
    assert.deepEqual(failed.rows[0].failure, {
      kind: 'sortFailed',
      provider: 'Groq',
      cause: 'keyRefused',
    });
    assert.equal(failed.rows[0].sortFailed, true);
    assert.equal(failed.canOpen, true, 'mail is ready even though sorting failed');
    assert.doesNotMatch(allText(failed), /\bDone\b/);
  });

  test('sync-ai-failure-copy – "Couldn\'t sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings', () => {
    const v = view(
      status([
        ready('a', 0, 40, {
          ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' },
        }),
      ]),
    );
    assert.match(
      allText(v).replace(/&#x27;|’/g, "'"),
      /Couldn't sort with Groq: the key was refused\. Mail is ready; sorting will retry\./,
    );
    const markup = renderToStaticMarkup(firstSyncStates['ai-failed'].render());
    assert.match(markup, /Open Settings/);
  });

  test('failed: each account says its plain reason (copy.ts), with Try again, Reconnect, or nothing for an admin block', () => {
    const v = view(
      status([
        acct('a', { state: 'failed', reasonCode: 'server.unavailable' }),
        acct('b', {
          state: 'failed',
          firstWindow: { read: 0, total: 50, done: false },
          reasonCode: 'auth.expired',
        }),
      ]),
    );
    assert.equal(v.outcome, 'failed');
    assert.equal(v.title, 'Some mail didn’t come through');
    assert.deepEqual(v.primary, { label: 'Continue to Aplos', enabled: true });
    assert.equal(v.rows[0].action, 'retry');
    assert.deepEqual(v.rows[0].failure, {
      kind: 'reason',
      text: 'Google isn’t answering right now. Aplos will try again.',
      retryable: true,
    });
    assert.equal(v.rows[1].action, 'reconnect');
    assert.equal(
      cp(v, 1, 'connect')?.state,
      'failed',
      'with no sign of a connection, Connected is never claimed',
    );
    const lapsed = view(
      status(
        [
          acct('a', {
            state: 'failed',
            firstWindow: { read: 0, total: 50, done: false },
            reasonCode: 'auth.expired',
          }),
        ],
        {
          errors: [{ accountId: 'a', phase: 'firstWindow', reasonCode: 'auth.expired', at: at(9) }],
        },
      ),
    );
    assert.equal(
      cp(lapsed, 0, 'connect')?.state,
      'done',
      'a sign-in that lapsed while finding still shows Connected',
    );
    assert.equal(lapsed.rows[0].action, 'reconnect');

    const admin = view(
      status([
        acct('a', {
          state: 'failed',
          firstWindow: { read: 0, total: 50, done: false },
          reasonCode: 'auth.adminPolicy',
        }),
      ]),
    );
    assert.equal(admin.rows[0].action, 'none');
    assert.match((admin.rows[0].failure as { text: string }).text, /administrator/);

    const connectFail = view(
      status(
        [
          acct('a', {
            state: 'failed',
            firstWindow: { read: 0, total: 50, done: false },
            reasonCode: 'net.offline',
          }),
        ],
        {
          errors: [{ accountId: 'a', phase: 'connect', reasonCode: 'net.offline', at: at(9) }],
        },
      ),
    );
    assert.equal(cp(connectFail, 0, 'connect')?.state, 'failed');
  });

  test('sync-not-connected-row – a skipped account shows "Not connected · Try again", never "Waiting"', () => {
    const v = view(
      status([
        acct('a'),
        acct('b', { state: 'notConnected', firstWindow: { read: 0, total: 0, done: false } }),
      ]),
    );
    const row = v.rows[1];
    assert.equal(row.notConnected, true);
    assert.equal(row.action, 'retry');
    assert.ok(
      row.checkpoints.every(c => c.state === 'pending'),
      'no spinner on a row that is not running',
    );
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
      for (const line of screenStrings(v))
        assert.equal(copyProblem(line), null, `${name}: ${line}`);
      if (!scene.drill)
        assert.doesNotMatch(allText(v), /\bDone\b|100%|Testing mode|verification/, name);
      assert.doesNotMatch(allText(v), /\b500\b|4,?800/, `${name}: no backfill or mailbox total`);
    }
  });
});

/* ───────────────────────── counters [F5] ───────────────────────── */

describe('first sync: counters never move backwards [F5]', () => {
  test('within a run, a lower count from the engine never lowers the screen', () => {
    const v1 = view(
      status([acct('a', { firstWindow: { read: 30, total: 50, done: false }, ai: undefined })]),
    );
    const v2 = view(
      status([acct('a', { firstWindow: { read: 22, total: 50, done: false }, ai: undefined })]),
      { previous: v1 },
    );
    assert.equal(cp(v2, 0, 'read')?.read, 30);
    const v3 = view(
      status([acct('a', { firstWindow: { read: 31, total: 40, done: false }, ai: undefined })]),
      { previous: v2 },
    );
    assert.deepEqual(
      cp(v3, 0, 'read'),
      { step: 'read', state: 'current', read: 31, of: 50 },
      'the total never shrinks while reading',
    );
  });

  test('F5 Retry twice during a running pass: one run per click, no collision, counters never decrease', () => {
    const failed = view(
      status([
        acct('a', {
          state: 'failed',
          firstWindow: { read: 24, total: 50, done: false },
          reasonCode: 'server.unavailable',
        }),
      ]),
    );
    // Two presses while the first is in flight send once.
    const inFlight = new Set<string>();
    assert.equal(shouldSendRetry(failed, 'a', inFlight), true);
    inFlight.add('a');
    assert.equal(shouldSendRetry(failed, 'a', inFlight), false);
    assert.equal(shouldSendRetry(failed, 'missing', new Set()), false);

    // The retry starts run 2; a late update from run 1 must not drag the screen back.
    const r2a = view(
      status([acct('a', { runId: 'a-2', firstWindow: { read: 26, total: 50, done: false } })]),
      { previous: failed },
    );
    assert.equal(cp(r2a, 0, 'read')?.read, 26);
    const stale = view(
      status([
        acct('a', {
          runId: 'a-1',
          state: 'failed',
          firstWindow: { read: 10, total: 50, done: false },
          reasonCode: 'server.unavailable',
        }),
      ]),
      {
        previous: r2a,
      },
    );
    assert.equal(stale.outcome, 'progress', 'a superseded run cannot flip the screen to failed');
    assert.equal(cp(stale, 0, 'read')?.read, 26);
    const r2b = view(
      status([acct('a', { runId: 'a-2', firstWindow: { read: 25, total: 50, done: false } })]),
      { previous: stale },
    );
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
      const track = newRun();
      const aiOn = rand() < 0.7;
      const provider = rand() < 0.85 ? 'Groq' : null;
      const consent = rand() < 0.85;
      for (let step = 0; step < STEPS; step++) {
        const total = pick([50, 50, 50, 12, 40, 0]);
        track.totalsSeen.add(total);
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
                reasonCode:
                  rand() < 0.1
                    ? pick(['ai.missingKey', 'ai.rateLimited', 'ai.noConsent'] as const)
                    : undefined,
              }
            : undefined,
          backfill: { read: Math.floor(rand() * 900), target: 4_800 },
          pausedUntil: rand() < 0.2 ? NOW + Math.floor(rand() * 7_200_000) - 1_800_000 : undefined,
          reasonCode: rand() < 0.15 ? pick(['rate.minute', 'quota.daily'] as const) : undefined,
        });
        const s = status([a], { done: rand() < 0.5, partial: rand() < 0.3 });
        const v = buildFirstSyncView({
          status: s,
          accounts: [A],
          aiProvider: provider,
          consentStored: consent,
          now: NOW,
          previous: track.previous,
        });
        assertHonestStep(v, a, s, provider, consent, track, NOW, step);
        track.previous = v;
        checked++;
      }
    }
    assert.equal(checked, RUNS * STEPS);
  });
});
