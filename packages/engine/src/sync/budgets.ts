import type { BudgetSpec, Lane } from './types';

/** ARCH 4.1: lanes, highest priority first. Queued requests are admitted in this order. */
export const LANES: readonly Lane[] = ['interactive', 'opFlush', 'incremental', 'prefetch', 'backfill', 'enrichment'];

/** Lanes that may use the reserved in-flight slot. */
export const PRIORITY_LANES: ReadonlySet<Lane> = new Set<Lane>(['interactive', 'opFlush']);

/**
 * Gmail: 6,000 units per user per minute on a sliding window (proto-google 1.1). The primary
 * device targets 4,500 and every other device 1,500, so three Macs cannot sum past 6,000 (ARCH 6.5).
 */
export const gmailBudget: BudgetSpec = {
  id: 'gmail',
  unit: 'units',
  windowMs: 60_000,
  ceiling: 6_000,
  targets: { primary: 4_500, secondary: 1_500 },
  floor: 1_000,
  laneShare: { interactive: 1, opFlush: 1, incremental: 0.9, prefetch: 0.2, backfill: 0.75, enrichment: 0.5 },
  inFlight: 3,
  reservedInteractive: 1,
  regrowPerMinute: 250,
};

/** Google Calendar: 600 requests per user per minute; Aplos uses half (ARCH 6.2), two in flight. */
export const gcalBudget: BudgetSpec = {
  id: 'gcal',
  unit: 'requests',
  windowMs: 60_000,
  ceiling: 600,
  targets: { primary: 300, secondary: 300 },
  floor: 60,
  laneShare: { interactive: 1, opFlush: 1, incremental: 0.9, prefetch: 0.2, backfill: 0.75, enrichment: 0.5 },
  inFlight: 2,
  reservedInteractive: 1,
  regrowPerMinute: 25,
};

export const defaultBudgets: readonly BudgetSpec[] = [gmailBudget, gcalBudget];
