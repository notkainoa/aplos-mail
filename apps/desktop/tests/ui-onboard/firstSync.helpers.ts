// Shared fixtures for the first-sync tests (WP8.3; DESIGN 7.12). Split out of firstSync.model.test.ts so each file
// stays under the line cap. `firstSync.states.test.ts` holds the renders, keys and announcements.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SetupAccount, SetupStatus } from '../../src/renderer/data';
import {
  buildFirstSyncView,
  keyIntent,
  screenStrings,
  type AccountFacts,
  type FirstSyncInput,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import { ProgressSegments } from '../../src/renderer/ui/status';
import type { SyncCheckpoint } from '../../src/renderer/ui/props';

export const NOW = new Date(2026, 9, 29, 10, 0).getTime();
export const at = (h: number, m = 0, day = 0) => new Date(2026, 9, 29 + day, h, m).getTime();
export const A: AccountFacts = { id: 'a', address: 'jordan@example.com', colorTag: 'sky' };
export const B: AccountFacts = { id: 'b', address: 'jordan@studio.example.org', colorTag: 'hill' };

export function acct(id: string, patch: Partial<SetupAccount> = {}): SetupAccount {
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
export const ready = (id: string, sorted = 40, total = 40, patch: Partial<SetupAccount> = {}) =>
  acct(id, {
    state: 'ready',
    firstWindow: { read: 50, total: 50, done: true },
    ai: { sorted, total, capped: 0, failed: 0 },
    ...patch,
  });
export function status(accounts: SetupAccount[], patch: Partial<SetupStatus> = {}): SetupStatus {
  return { setupId: 's1', accounts, done: false, partial: false, errors: [], ...patch };
}
export function view(
  s: SetupStatus | undefined,
  patch: Partial<FirstSyncInput> = {},
): FirstSyncView {
  return buildFirstSyncView({
    status: s,
    accounts: [A, B],
    aiProvider: 'Groq',
    consentStored: true,
    now: NOW,
    ...patch,
  });
}
export const cp = <S extends SyncCheckpoint['step']>(v: FirstSyncView, row: number, step: S) =>
  v.rows[row].checkpoints.find(c => c.step === step) as
    Extract<SyncCheckpoint, { step: S }> | undefined;

/** The checklist and status copy ProgressSegments writes for a view, plus the screen's own strings. */
export function allText(v: FirstSyncView): string {
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

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────── the never-backwards property walk ───────── */

/** What one generated run remembers across its steps, for the property test's invariants. */
export interface RunTrack {
  previous?: FirstSyncView;
  fwDoneSeen: boolean;
  totalsSeen: Set<number>;
  maxRead: number;
  maxSorted: number;
  sortDoneSeen: boolean;
  lastOfWhileReading: number;
  lastPhase: string;
  lastAnnouncement: string;
}

export function newRun(): RunTrack {
  return {
    fwDoneSeen: false,
    totalsSeen: new Set<number>(),
    maxRead: 0,
    maxSorted: 0,
    sortDoneSeen: false,
    lastOfWhileReading: 0,
    lastPhase: '',
    lastAnnouncement: '',
  };
}

/**
 * Every honesty invariant for one generated status in one run (F5, F8, F10, F11): counters never move backwards,
 * nothing claims completion early, no auto-open unless every fact is clean, Esc always opens, the live region
 * changes only with the phase, and no banned copy. `step` samples the rendered checklist to keep the run short.
 */
export function assertHonestStep(
  v: FirstSyncView,
  a: SetupAccount,
  s: SetupStatus,
  provider: string | null,
  consent: boolean,
  track: RunTrack,
  now: number,
  step: number,
): void {
  const read = cp(v, 0, 'read')!;
  const sort = cp(v, 0, 'sort');
  track.fwDoneSeen ||= a.firstWindow.done;

  // Counters never decrease within the run.
  assert.ok(read.read >= track.maxRead, `read went ${track.maxRead} → ${read.read}`);
  track.maxRead = read.read;
  if (sort) {
    assert.ok(sort.sorted >= track.maxSorted, `sorted went ${track.maxSorted} → ${sort.sorted}`);
    track.maxSorted = sort.sorted;
  }
  // No Done, and no full count, before it is true.
  if (read.state === 'done')
    assert.ok(track.fwDoneSeen, 'read done before the engine committed the window');
  else {
    assert.ok(
      read.of === 0 || read.read < read.of,
      `running read shows ${read.read} of ${read.of}`,
    );
    assert.ok(read.of >= track.lastOfWhileReading, 'the first-window total shrank while reading');
    track.lastOfWhileReading = read.of;
  }
  // The total is the first window: a value the engine gave as firstWindow.total, or the count itself once done.
  assert.ok(
    track.totalsSeen.has(read.of) || (read.state === 'done' && read.of === read.read),
    `of ${read.of}`,
  );
  assert.notEqual(read.of, 4_800);
  if (sort) {
    assert.ok(provider && consent, 'sort shown without a provider and consent');
    const ai = a.ai!;
    const trueNow =
      ai.sorted >= ai.total &&
      ai.total > 0 &&
      ai.capped === 0 &&
      ai.failed === 0 &&
      a.state !== 'sorting' &&
      track.fwDoneSeen;
    if (sort.state === 'done') {
      assert.ok(trueNow || track.sortDoneSeen, 'sort done before it was ever true in this run');
      track.sortDoneSeen = true;
    } else
      assert.ok(
        sort.of === 0 || sort.sorted < sort.of || sort.state === 'failed',
        `running sort shows ${sort.sorted} of ${sort.of}`,
      );
    if (ai.capped > 0 && !track.sortDoneSeen && sort.state !== 'failed' && sort.state !== 'pending')
      assert.equal(sort.state, 'partial');
  }
  // Never auto-open unless every fact is clean.
  if (v.autoOpen) {
    assert.equal(a.state, 'ready');
    assert.ok(s.done && !s.partial && s.errors.every(e => e.phase === 'backfill'));
    assert.ok(!(a.pausedUntil && a.pausedUntil > now));
    assert.equal(a.reasonCode, undefined);
    assert.ok(!a.ai || !provider || !consent || (a.ai.capped === 0 && a.ai.failed === 0));
  }
  if (v.outcome === 'paused' || v.outcome === 'failed' || v.outcome === 'partial')
    assert.equal(v.autoOpen, false);
  // Esc always opens; the live region changes only with the phase.
  assert.equal(keyIntent(v, 'Escape'), 'open');
  if (v.announcement !== track.lastAnnouncement)
    assert.notEqual(v.phase, track.lastPhase, 'announcement changed within a phase');
  track.lastPhase = v.phase;
  track.lastAnnouncement = v.announcement;
  // No banned words on the pass (the rendered checklist, sampled to keep the run short).
  for (const line of screenStrings(v)) assert.doesNotMatch(line, /\bDone\b|100%|4,?800/);
  if (step % 10 === 9) assert.doesNotMatch(allText(v), /\bDone\b|100%|4,?800/);
}
