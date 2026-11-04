/**
 * Preview fixtures for the first-sync screen and the key drill (DESIGN 7.12; onboarding-sync.html progress, paused,
 * ready, partial, failed; onboarding-drill.html step1, step3, done). Each is a contract-typed `SetupStatus` run through
 * the model and drawn by the presentational screen with no-op callbacks. Invented accounts on example domains only.
 * The onboarding preview gallery imports `firstSyncStates`.
 */
import type { JSX } from 'react';
import type { SetupAccount, SetupStatus } from '../../data';
import { FirstSync } from './FirstSync';
import { drillPreset, type DrillState } from './drill.model';
import { buildFirstSyncView, type AccountFacts } from './model';
import { WINDOW_COPY } from '../copy';

// The gallery runs under Vite, which loads the screen's layout CSS; node tests import this file too and skip it.
if (import.meta.env) void import('./firstSync.css');

/** The harness clock: 2026-10-29 10:00 local. */
export const FIXTURE_NOW = new Date(2026, 9, 29, 10, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 29 + dayOffset, h, m).getTime();

const ALEX: AccountFacts = { id: 'acc-alex', address: 'alex.moreno@example.com', colorTag: 'sky' };
const STUDIO: AccountFacts = {
  id: 'acc-studio',
  address: 'alex@studio.example.org',
  colorTag: 'hill',
};
const ACCOUNTS = [ALEX, STUDIO];

function account(id: string, patch: Partial<SetupAccount> = {}): SetupAccount {
  return {
    accountId: id,
    state: 'reading',
    firstWindow: { read: 24, total: 50, done: false },
    ai: {
      sorted: 0,
      total: 0,
      capped: 0,
      failed: 0,
      model: { provider: 'groq', model: 'llama-3.3-70b' },
    },
    backfill: { read: 0, target: 0 },
    runId: `${id}-run-1`,
    ...patch,
  };
}

const ready = (
  id: string,
  sorted: number,
  of: number,
  patch: Partial<SetupAccount> = {},
): SetupAccount =>
  account(id, {
    state: 'ready',
    firstWindow: { read: 50, total: 50, done: true },
    ai: { sorted, total: of, capped: 0, failed: 0 },
    ...patch,
  });

function status(accounts: SetupAccount[], patch: Partial<SetupStatus> = {}): SetupStatus {
  return { setupId: 'setup-fixture', accounts, done: false, partial: false, errors: [], ...patch };
}

interface Scene {
  readonly status: SetupStatus | undefined;
  readonly aiProvider?: string | null;
  readonly consentStored?: boolean;
  readonly drill?: DrillState;
  /** The window's failed handoff, drawn on the screen. */
  readonly handoffFailed?: boolean;
}

const noop = () => undefined;

function render(scene: Scene): JSX.Element {
  const view = buildFirstSyncView({
    status: scene.status,
    accounts: ACCOUNTS,
    aiProvider: scene.aiProvider === undefined ? 'Groq' : scene.aiProvider,
    consentStored: scene.consentStored ?? true,
    now: FIXTURE_NOW,
  });
  return (
    <FirstSync
      view={view}
      drill={scene.drill ?? null}
      now={FIXTURE_NOW}
      onOpen={noop}
      onRetry={noop}
      onReconnect={noop}
      onOpenSettings={noop}
      onTryKeys={noop}
      onLeaveDrill={noop}
      onDrillKey={noop}
      onDrillPick={noop}
      {...(scene.handoffFailed
        ? { notice: { text: WINDOW_COPY.handoffFailed, onRetry: noop } }
        : {})}
    />
  );
}

const twoReading = status([
  account(ALEX.id, { firstWindow: { found: 214, read: 24, total: 50, done: false } }),
  account(STUDIO.id, { firstWindow: { read: 38, total: 50, done: false } }),
]);

/** The scenes, by state name. Exported for the model tests, which check every scene's copy and decisions. */
export const firstSyncScenes: Record<string, { title: string; scene: Scene }> = {
  starting: { title: 'Starting: no status yet', scene: { status: undefined } },
  progress: {
    title: 'Progress: reading 24 of 50, no estimate (quiet Find)',
    scene: { status: status([account(ALEX.id)]) },
  },
  'progress-estimate': {
    title: 'Progress: found about 214, reading 24 of 50',
    scene: {
      status: status([
        account(ALEX.id, { firstWindow: { found: 214, read: 24, total: 50, done: false } }),
      ]),
    },
  },
  finding: {
    title: 'Finding recent mail (indeterminate)',
    scene: {
      status: status([
        account(ALEX.id, { state: 'finding', firstWindow: { read: 0, total: 50, done: false } }),
      ]),
    },
  },
  paused: {
    title: 'Paused after the first window (Google slow-down, resumes 2:14 PM)',
    scene: {
      status: status([
        account(ALEX.id, {
          state: 'paused',
          firstWindow: { found: 214, read: 50, total: 50, done: true },
          ai: { sorted: 40, total: 40, capped: 0, failed: 0 },
          backfill: { read: 120, target: 500 },
          pausedUntil: at(14, 14),
          reasonCode: 'rate.minute',
        }),
        ready(STUDIO.id, 8, 40, { state: 'sorting' }),
      ]),
    },
  },
  'paused-before-first-window': {
    title: 'Paused before the first batch (resumes 2:14 PM)',
    scene: {
      status: status([
        account(ALEX.id, {
          state: 'paused',
          firstWindow: { found: 214, read: 0, total: 50, done: false },
          pausedUntil: at(14, 14),
          reasonCode: 'rate.minute',
        }),
      ]),
    },
  },
  'paused-mid-window': {
    title: 'Paused at 24 of 50 while the second account sorts',
    scene: {
      status: status([
        account(ALEX.id, {
          state: 'paused',
          firstWindow: { found: 214, read: 24, total: 50, done: false },
          pausedUntil: at(14, 14),
          reasonCode: 'rate.minute',
        }),
        ready(STUDIO.id, 8, 40, { state: 'sorting' }),
      ]),
    },
  },
  'paused-daily': {
    title: 'Paused for the daily limit (resumes tomorrow)',
    scene: {
      status: status([
        account(ALEX.id, {
          state: 'paused',
          firstWindow: { read: 24, total: 50, done: false },
          pausedUntil: at(0, 0, 1),
          reasonCode: 'quota.daily',
        }),
      ]),
    },
  },
  ready: {
    title: 'Ready: clean finish, opens by itself',
    scene: { status: status([ready(ALEX.id, 40, 40), ready(STUDIO.id, 20, 20)], { done: true }) },
  },
  partial: {
    title: 'Partial: sorting capped at 12 of 40',
    scene: {
      status: status(
        [
          ready(ALEX.id, 12, 40, { ai: { sorted: 12, total: 40, capped: 28, failed: 0 } }),
          ready(STUDIO.id, 20, 20),
        ],
        { done: true, partial: true },
      ),
    },
  },
  'ai-failed': {
    title: 'Sorting failed: Groq refused the key',
    scene: {
      status: status(
        [
          ready(ALEX.id, 0, 40, {
            ai: { sorted: 0, total: 40, capped: 0, failed: 40, reasonCode: 'ai.missingKey' },
          }),
        ],
        {
          done: true,
          partial: true,
          errors: [{ accountId: ALEX.id, phase: 'ai', reasonCode: 'ai.missingKey', at: at(9, 58) }],
        },
      ),
    },
  },
  'no-ai': {
    title: 'No AI provider: Sort is left out (3 segments)',
    scene: { status: status([account(ALEX.id, { ai: undefined })]), aiProvider: null },
  },
  'no-consent': {
    title: 'No consent stored: Sort is left out',
    scene: { status: status([account(ALEX.id)]), consentStored: false },
  },
  'small-mailbox': {
    title: 'A 12-thread inbox: read 12 of 12, sorting',
    scene: {
      status: status([
        account(ALEX.id, {
          state: 'sorting',
          firstWindow: { read: 12, total: 12, done: true },
          ai: { sorted: 3, total: 12, capped: 0, failed: 0 },
        }),
      ]),
    },
  },
  failed: {
    title: 'Failed: one account stopped, one ready',
    scene: {
      status: status(
        [
          account(ALEX.id, {
            state: 'failed',
            firstWindow: { found: 214, read: 24, total: 50, done: false },
            reasonCode: 'server.unavailable',
          }),
          ready(STUDIO.id, 20, 20),
        ],
        {
          partial: true,
          errors: [
            {
              accountId: ALEX.id,
              phase: 'firstWindow',
              reasonCode: 'server.unavailable',
              at: at(9, 59),
            },
          ],
        },
      ),
    },
  },
  'failed-reconnect': {
    title: 'Failed: Google needs sign-in again (Reconnect)',
    scene: {
      status: status(
        [
          account(ALEX.id, {
            state: 'failed',
            firstWindow: { read: 0, total: 50, done: false },
            reasonCode: 'auth.expired',
          }),
        ],
        {
          errors: [
            { accountId: ALEX.id, phase: 'connect', reasonCode: 'auth.expired', at: at(9, 59) },
          ],
        },
      ),
    },
  },
  'failed-admin': {
    title: 'Failed: blocked by an administrator (no action)',
    scene: {
      status: status(
        [
          account(ALEX.id, {
            state: 'failed',
            firstWindow: { read: 0, total: 50, done: false },
            reasonCode: 'auth.adminPolicy',
          }),
        ],
        {
          errors: [
            { accountId: ALEX.id, phase: 'connect', reasonCode: 'auth.adminPolicy', at: at(9, 59) },
          ],
        },
      ),
    },
  },
  'not-connected': {
    title: 'Not connected: a skipped account, Try again',
    scene: {
      status: status([
        account(ALEX.id),
        account(STUDIO.id, {
          state: 'notConnected',
          firstWindow: { read: 0, total: 0, done: false },
        }),
      ]),
    },
  },
  'multi-account': {
    title: 'Two accounts: one in, one reading (Open Aplos enabled)',
    scene: {
      status: status([
        ready(ALEX.id, 8, 40, {
          state: 'sorting',
          firstWindow: { found: 214, read: 50, total: 50, done: true },
        }),
        account(STUDIO.id, { firstWindow: { read: 38, total: 50, done: false } }),
      ]),
    },
  },
  'drill-step1': {
    title: 'Try the keys: step 1 (J/K)',
    scene: { status: twoReading, drill: drillPreset('step1') },
  },
  'drill-step3': {
    title: 'Try the keys: step 3 (E)',
    scene: { status: twoReading, drill: drillPreset('step3') },
  },
  'handoff-failed': {
    title: 'Open Aplos, the mail window did not open (Try again; review1)',
    scene: { status: status([ready(ALEX.id, 40, 40)], { done: true }), handoffFailed: true },
  },
  'failed-after-window': {
    title:
      'Sign-in expired after the newest mail and sorting were in: Reconnect, never blames the AI (review1)',
    scene: {
      status: status([ready(ALEX.id, 40, 40, { state: 'failed', reasonCode: 'auth.expired' })], {
        done: true,
        errors: [
          { accountId: ALEX.id, phase: 'backfill', reasonCode: 'auth.expired', at: at(9, 55) },
        ],
      }),
    },
  },
  'ai-rate-limited': {
    title: 'Paused: the AI provider asked to slow down (names Groq, never Google; review1)',
    scene: {
      status: status([
        ready(ALEX.id, 12, 40, {
          state: 'paused',
          reasonCode: 'ai.rateLimited',
          pausedUntil: at(10, 20),
        }),
      ]),
    },
  },
  'drill-done': {
    title: 'Try the keys: done',
    scene: { status: twoReading, drill: drillPreset('done') },
  },
};

/** The preview gallery's entries: every state of the first-sync screen and the drill. */
export const firstSyncStates: Record<string, { title: string; render: () => JSX.Element }> =
  Object.fromEntries(
    Object.entries(firstSyncScenes).map(([name, { title, scene }]) => [
      name,
      { title, render: () => render(scene) },
    ]),
  );
