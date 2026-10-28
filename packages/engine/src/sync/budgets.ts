import type { BudgetSpec, SyncLane } from '../ports';

/** ARCH 4.1: lanes, highest priority first. Queued requests are admitted in this order. */
export const LANES: readonly SyncLane[] = [
  'interactive',
  'opFlush',
  'incremental',
  'prefetch',
  'backfill',
  'enrichment',
];

/** Lanes that may use the reserved in-flight slots. */
export const PRIORITY_LANES: ReadonlySet<SyncLane> = new Set<SyncLane>(['interactive', 'opFlush']);

/** Every lane at full share: budgets with no lane policy of their own (the token endpoint). */
const ALL_LANES: Record<SyncLane, number> = {
  interactive: 1,
  opFlush: 1,
  incremental: 1,
  prefetch: 1,
  backfill: 1,
  enrichment: 1,
};

/**
 * Gmail as ARCH 6.2 and the F3 `BudgetSpec` notes give it: 6,000 units per user per minute on a sliding window, a
 * primary target of 4,500 and 1,500 on every other device, so three Macs cannot sum past 6,000 while the secondaries
 * idle (ARCH 6.5). The live adapter supplies its own spec through `ProviderFactory.budgets`; this one is the default
 * the governor falls back to and what the fake-clock suites run against.
 */
export const gmailBudget: BudgetSpec = {
  id: 'gmail',
  unit: 'units',
  windowMs: 60_000,
  ceiling: 6_000,
  target: { primary: 4_500, secondary: 1_500 },
  floor: 1_000,
  laneShare: {
    interactive: 1,
    opFlush: 1,
    incremental: 0.9,
    prefetch: 0.2,
    backfill: 0.75,
    enrichment: 0.1,
  },
  inFlight: 3,
  reservedInteractive: 1,
  batch: { start: 10, min: 1, max: 25, growBy: 5 },
};

/** Google Calendar: 600 requests per user per minute; Aplos uses half (ARCH 6.2), two in flight. */
export const gcalBudget: BudgetSpec = {
  id: 'gcal',
  unit: 'requests',
  windowMs: 60_000,
  ceiling: 600,
  target: { primary: 300, secondary: 300 },
  floor: 60,
  laneShare: {
    interactive: 1,
    opFlush: 1,
    incremental: 0.9,
    prefetch: 0.2,
    backfill: 0.75,
    enrichment: 0.5,
  },
  inFlight: 2,
  reservedInteractive: 1,
};

/**
 * The token endpoint (`oauth`): every refresh and the connect-time code exchange run here. A design choice, since no
 * factory supplies it: one call in flight per account (refreshes are serialized anyway, D21) and a modest minute cap,
 * far above what one account needs, so a refresh loop bug cannot hammer Google.
 */
export const oauthBudget: BudgetSpec = {
  id: 'oauth',
  unit: 'requests',
  windowMs: 60_000,
  ceiling: 60,
  target: { primary: 30, secondary: 30 },
  floor: 10,
  laneShare: ALL_LANES,
  inFlight: 1,
  reservedInteractive: 0,
};

export const defaultBudgets: readonly BudgetSpec[] = [gmailBudget, gcalBudget, oauthBudget];
