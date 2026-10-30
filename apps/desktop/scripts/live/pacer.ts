import { classify } from './guard';

/**
 * A run-level sliding window for Gmail quota units. Every run stays under 3,000 units in any 60 s
 * (the roadmap's budget for live runs, half of the per-user limit), so the agent test account is
 * never throttled. The budget is per run, so only one run may go at a time: run.ts holds the
 * run lock (run-lock.ts) while it makes requests. The real governor (plan 20 PV2) replaces this.
 */
export const WINDOW_MS = 60_000;
/** Strictly under 3,000, with a little room for the call that is in flight. */
export const RUN_UNIT_BUDGET = 2_900;

interface CostEntry {
  base: number;
  full?: number;
}

/**
 * Unit costs by API method, copied from the emulator's GMAIL_UNIT_COSTS (which follows Google's
 * 2026 usage-limits page) plus labels.delete. Kept as a small table here so the runner does not
 * import the test-only emulator package. `full` is the price of format full, raw and html.
 */
const UNIT_COSTS: Readonly<Record<string, CostEntry>> = {
  'gmail.users.getProfile': { base: 1 },
  'gmail.users.labels.list': { base: 1 },
  'gmail.users.labels.get': { base: 1 },
  'gmail.users.labels.create': { base: 5 },
  'gmail.users.labels.delete': { base: 5 },
  'gmail.users.history.list': { base: 2 },
  'gmail.users.messages.list': { base: 5 },
  'gmail.users.messages.get': { base: 20, full: 60 },
  'gmail.users.messages.modify': { base: 5 },
  'gmail.users.messages.batchModify': { base: 50 },
  'gmail.users.messages.send': { base: 100 },
  'gmail.users.messages.attachments.get': { base: 20 },
  'gmail.users.threads.list': { base: 10 },
  'gmail.users.threads.get': { base: 40, full: 120 },
  'gmail.users.threads.modify': { base: 10 },
  'gmail.users.drafts.create': { base: 10 },
  'gmail.users.drafts.get': { base: 20, full: 60 },
  'gmail.users.drafts.list': { base: 5 },
  'gmail.users.drafts.update': { base: 15 },
  'gmail.users.drafts.send': { base: 100 },
  'gmail.users.settings.filters.create': { base: 5 },
  'gmail.users.settings.filters.list': { base: 1 },
  'gmail.users.settings.filters.get': { base: 1 },
  'gmail.users.settings.filters.delete': { base: 5 },
  'gmail.users.settings.sendAs.list': { base: 1 },
};

export const GMAIL_COST_TABLE_KEYS: readonly string[] = Object.keys(UNIT_COSTS);

/** Units one request costs. Calendar and OAuth calls do not count against Gmail's window. */
export function unitCost(api: string, format: string | null): number {
  if (!api.startsWith('gmail.')) return 0;
  const entry = UNIT_COSTS[api];
  // Unknown Gmail calls cannot happen (the guard only lets known ones through); price them high anyway.
  if (!entry) return 100;
  // The API's own default format is full, so a call that forgot the format is priced as full.
  const effective = format ?? 'full';
  return ['full', 'raw', 'html'].includes(effective) && entry.full !== undefined
    ? entry.full
    : entry.base;
}

export interface PacerOptions {
  budget?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class UnitPacer {
  private readonly budget: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private charges: { at: number; units: number }[] = [];
  private readonly history: { at: number; units: number }[] = [];
  private peak = 0;
  /** Requests queue behind each other so two parallel callers cannot both squeeze into the same gap. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: PacerOptions = {}) {
    this.budget = options.budget ?? RUN_UNIT_BUDGET;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Resolves when `units` fit in the window, and charges them. */
  acquire(units: number): Promise<void> {
    if (units > this.budget)
      return Promise.reject(new Error('A single request is larger than the unit budget'));
    const turn = this.tail.then(() => this.take(units));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async take(units: number): Promise<void> {
    for (;;) {
      const now = this.now();
      this.charges = this.charges.filter(charge => charge.at > now - WINDOW_MS);
      const used = this.charges.reduce((sum, charge) => sum + charge.units, 0);
      if (used + units <= this.budget) {
        this.charges.push({ at: now, units });
        this.history.push({ at: now, units });
        this.peak = Math.max(this.peak, used + units);
        return;
      }
      // Wait until the oldest charge leaves the window, then check again.
      const oldest = this.charges[0]!;
      await this.sleep(Math.max(1, oldest.at + WINDOW_MS - now));
    }
  }

  /** The highest total the 60 s window ever held. */
  peakWindow(): number {
    return this.peak;
  }

  /** A position in the history, for measuring one probe. */
  mark(): number {
    return this.history.length;
  }

  /** Units per minute from `sinceMark`, counting minutes from the first charge in that range. */
  series(sinceMark = 0): number[] {
    const charges = this.history.slice(sinceMark);
    const first = charges[0];
    if (!first) return [];
    const minutes: number[] = [];
    for (const charge of charges) {
      const minute = Math.floor((charge.at - first.at) / WINDOW_MS);
      while (minutes.length <= minute) minutes.push(0);
      minutes[minute] = (minutes[minute] ?? 0) + charge.units;
    }
    return minutes;
  }
}

/** Wraps a fetch so each Gmail request waits for room in the window before it goes out. */
export function createPacedFetch(inner: typeof fetch, pacer: UnitPacer): typeof fetch {
  return async (input, init) => {
    // The guard above this layer only passes plain URL strings; anything else is simply not priced.
    if (typeof input === 'string') {
      const url = new URL(input);
      const rule = classify((init?.method ?? 'GET').toUpperCase(), url);
      if (rule) await pacer.acquire(unitCost(rule.api, url.searchParams.get('format')));
    }
    return inner(input, init);
  };
}
