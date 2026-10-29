import { devCases, type QualityCase } from './cases';
import { askDevCases, type AskCase } from './ask-cases';

/**
 * Dev and held-out splits for the AI evaluations (roadmap 5.1c): prompt attempts are scored on the
 * dev cases and must not regress on the held-out cases, which the attempts never see. Membership in
 * a held-out file is the whole assignment, so it is deterministic and pinned by the offline test.
 * Only the dev modules are imported statically; the held-out modules are loaded dynamically inside
 * the loaders below, and only when the chosen split needs them, so a dev run also works in a
 * worktree where the held-out files are stripped.
 */

export type Split = 'dev' | 'heldout' | 'all';

/**
 * The original whole-list order (ids only, no bodies). 'all' and --only=N keep this indexing, so
 * the split work did not renumber the cases. Update only deliberately, together with the case files
 * and the offline test.
 */
export const ORDER: Record<'quality' | 'ask', readonly string[]> = {
  quality: [
    'summary-explicit-deadline-and-injection',
    'summary-does-not-invent-deadline',
    'calendar-exact-time-and-injection',
    'calendar-ambiguous-date-stays-empty',
    'ask-facts-citations-and-injection',
    'ask-missing-evidence',
    'ask-tools-injected-triage-yields-nothing',
    'ask-tools-event-proposal-from-mail',
    'draft-unknown-recipient-and-no-extra-commitments',
    'polish-preserves-facts-and-does-not-obey-body',
  ],
  ask: [
    'ask-summarize-open',
    'ask-invoice-facts',
    'ask-week-plans',
    'ask-book-lunch',
    'ask-triage-done',
  ],
};

const rank = new Map([...ORDER.quality, ...ORDER.ask].map((id, i) => [id, i]));
const devIds = new Set([...devCases, ...askDevCases].map(c => c.id));

/**
 * Reads --split=dev|heldout|all from argv; no flag means all, so existing runs are unchanged. Any
 * malformed or repeated --split option is an error, never silently ignored.
 */
export function parseSplit(argv: string[]): Split {
  const malformed = argv.find(a => a.startsWith('--split') && !a.startsWith('--split='));
  if (malformed)
    throw new Error(
      `Malformed option ${malformed}; use --split=dev, --split=heldout or --split=all.`,
    );
  const flags = argv.filter(a => a.startsWith('--split='));
  if (flags.length > 1) throw new Error(`Pass --split= only once, got: ${flags.join(', ')}.`);
  if (!flags.length) return 'all';
  const value = flags[0].slice('--split='.length);
  if (value === 'dev' || value === 'heldout' || value === 'all') return value;
  throw new Error(`Unknown --split=${value}; use dev, heldout or all.`);
}

/**
 * Filters a case list to the chosen split: 'dev' is membership in the dev modules (which are always
 * present), 'heldout' is everything else, and 'all' restores the pinned original order.
 */
export function selectCases<T extends { id: string }>(cases: T[], split: Split): T[] {
  if (split === 'all')
    return [...cases].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return cases.filter(c => devIds.has(c.id) === (split === 'dev'));
}

/** Loads the quality cases for a split; the held-out module is imported only when it is needed. */
export async function loadQualityCases(split: Split): Promise<QualityCase[]> {
  if (split === 'dev') return [...devCases];
  const { heldOutCases } = await import('./heldout-cases');
  return selectCases([...devCases, ...heldOutCases], split);
}

/** Loads the Ask live cases for a split; the held-out module is imported only when it is needed. */
export async function loadAskCases(split: Split): Promise<AskCase[]> {
  if (split === 'dev') return [...askDevCases];
  const { askHeldOutCases } = await import('./ask-heldout-cases');
  return selectCases([...askDevCases, ...askHeldOutCases], split);
}

/** Keeps the 1-based --only=N pick in the list's order; a miss is an error, not an empty score. */
export function pickOnly<T>(list: T[], only: string | undefined): T[] {
  if (only === undefined) return list;
  const n = Number(only);
  if (!Number.isInteger(n) || n < 1 || n > list.length)
    throw new Error(`--only=${only} picks no case; use 1..${list.length}.`);
  return [list[n - 1]];
}

export interface ScoreResult {
  id: string;
  passed: boolean;
  error?: string;
}

/**
 * Builds the single scorer line {"score": passed/total, "details": up to 5 first-per-case
 * failures}. The denominator is the whole result list, so with --runs>1 every run counts. An empty
 * list is a harness error, never score 0.
 */
export function scoreLine(results: ScoreResult[]): {
  score: number;
  details: { id: string; message: string }[];
} {
  if (!results.length) throw new Error('Nothing was selected to score.');
  const failures = new Map<string, string>();
  let passed = 0;
  for (const r of results) {
    if (r.passed) {
      passed++;
      continue;
    }
    if (!failures.has(r.id)) failures.set(r.id, r.error ?? 'failed');
  }
  const details = [...failures].slice(0, 5).map(([id, message]) => ({ id, message }));
  return { score: passed / results.length, details };
}
