import { devCases } from './cases';
import { heldOutCases } from './heldout-cases';
import { askDevCases } from './ask-cases';
import { askHeldOutCases } from './ask-heldout-cases';

/**
 * Dev and held-out splits for the AI evaluations (roadmap 5.1c): prompt attempts are scored on the
 * dev cases and must not regress on the held-out cases, which the attempts never see. Membership in
 * a held-out file is the whole assignment, so it is deterministic and pinned by the offline test.
 */

export type Split = 'dev' | 'heldout' | 'all';

export const qualityCases = [...devCases, ...heldOutCases];
export const askCases = [...askDevCases, ...askHeldOutCases];

const heldOutIds = new Set([...heldOutCases, ...askHeldOutCases].map(c => c.id));

/** Reads --split=dev|heldout|all from argv; no flag means all, so existing runs are unchanged. */
export function parseSplit(argv: string[]): Split {
  const arg = argv.find(a => a.startsWith('--split='));
  if (!arg) return 'all';
  const value = arg.slice('--split='.length);
  if (value === 'dev' || value === 'heldout' || value === 'all') return value;
  throw new Error(`Unknown --split=${value}; use dev, heldout or all.`);
}

/** Filters a case list to the chosen split; 'all' returns a copy of the whole list. */
export function selectCases<T extends { id: string }>(cases: T[], split: Split): T[] {
  if (split === 'all') return [...cases];
  return cases.filter(c => heldOutIds.has(c.id) === (split === 'heldout'));
}
