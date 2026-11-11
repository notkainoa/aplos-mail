/**
 * The one Gmail price list (proto-google 1.1, the 2026 "new" column). Every governed Gmail call is priced here and
 * nowhere else; `prov-gov`'s governor reuses it. A method missing from the table is a bug, so `gmailCost` throws
 * instead of guessing a default price.
 */

/** `base` is the minimal/metadata price; `full` the price for `format=full` (and `raw` for messages). */
export interface GmailPrice {
  base: number;
  full?: number;
}

export type GmailCostTable = Readonly<Record<string, GmailPrice>>;

/** Catalog method ids, as the ports name them (`gmail.threads.get`, not the REST `gmail.users.threads.get`). */
export const GMAIL_COSTS = {
  'gmail.getProfile': { base: 1 },
  'gmail.labels.list': { base: 1 },
  'gmail.labels.get': { base: 1 },
  'gmail.labels.create': { base: 5 },
  'gmail.settings.filters.list': { base: 1 },
  'gmail.settings.sendAs.list': { base: 1 },
  'gmail.settings.filters.create': { base: 5 },
  'gmail.settings.filters.delete': { base: 5 },
  'gmail.history.list': { base: 2 },
  'gmail.messages.list': { base: 5 },
  'gmail.threads.list': { base: 10 },
  'gmail.drafts.list': { base: 5 },
  'gmail.messages.get': { base: 20, full: 60 },
  'gmail.threads.get': { base: 40, full: 120 },
  'gmail.drafts.get': { base: 20, full: 60 },
  'gmail.messages.attachments.get': { base: 20 },
  'gmail.messages.modify': { base: 5 },
  'gmail.threads.modify': { base: 10 },
  'gmail.messages.batchModify': { base: 50 },
  'gmail.messages.trash': { base: 20 },
  'gmail.threads.trash': { base: 20 },
  'gmail.messages.untrash': { base: 20 },
  'gmail.threads.untrash': { base: 20 },
  'gmail.messages.delete': { base: 10 },
  'gmail.messages.insert': { base: 25 },
  'gmail.messages.send': { base: 100 },
  'gmail.drafts.create': { base: 10 },
  'gmail.drafts.update': { base: 15 },
  'gmail.drafts.delete': { base: 10 },
  'gmail.drafts.send': { base: 100 },
  'gmail.watch': { base: 100 },
} as const satisfies GmailCostTable;

export type GmailMethod = keyof typeof GMAIL_COSTS;

/**
 * Projects that used the API between November 2025 and April 2026 keep the old reads (proto-google 1.1). Only the
 * price changes; pacing follows it through the governor, nothing else does.
 */
export const GMAIL_COSTS_GRANDFATHERED: GmailCostTable = {
  ...GMAIL_COSTS,
  'gmail.messages.get': { base: 5, full: 5 },
  'gmail.threads.get': { base: 10, full: 10 },
  'gmail.drafts.get': { base: 5, full: 5 },
  'gmail.messages.attachments.get': { base: 5 },
  'gmail.messages.trash': { base: 5 },
  'gmail.messages.untrash': { base: 5 },
  'gmail.threads.trash': { base: 10 },
  'gmail.threads.untrash': { base: 10 },
};

export type GmailFormat = 'minimal' | 'metadata' | 'full' | 'raw';

/** Units one call costs. Gmail's own default format is `full`, so a call that names none is priced as full. */
export function gmailCost(
  method: string,
  format?: GmailFormat,
  table: GmailCostTable = GMAIL_COSTS,
): number {
  const price = table[method];
  if (!price) throw new Error(`No Gmail price for ${method}`);
  const expensive = format === undefined || format === 'full' || format === 'raw';
  return expensive && price.full !== undefined ? price.full : price.base;
}

/**
 * The Calendar price list (`gcal` budget, `requests` units): one request is one unit, the same rule as Gmail's —
 * a method missing here is a bug, not a default price.
 */
export const GCAL_COSTS = {
  'gcal.calendarList.list': { base: 1 },
  'gcal.calendarList.get': { base: 1 },
  'gcal.events.list': { base: 1 },
  'gcal.events.get': { base: 1 },
  'gcal.events.instances': { base: 1 },
  'gcal.events.insert': { base: 1 },
  'gcal.events.patch': { base: 1 },
  'gcal.events.delete': { base: 1 },
} as const satisfies GmailCostTable;

export type GcalMethod = keyof typeof GCAL_COSTS;

/** Units one Calendar call costs. */
export function gcalCost(method: string, table: GmailCostTable = GCAL_COSTS): number {
  const price = table[method];
  if (!price) throw new Error(`No Calendar price for ${method}`);
  return price.base;
}
