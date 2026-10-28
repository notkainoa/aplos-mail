/**
 * Gmail API quota units, from the 2026 usage-limits page (proto-google.md section 1.1).
 * `base` is the price for minimal and metadata reads, `full` the price for full, raw and html.
 */
export interface CostEntry {
  base: number;
  full?: number;
}

export const GMAIL_UNIT_COSTS: Readonly<Record<string, CostEntry>> = {
  'gmail.users.getProfile': { base: 1 },
  'gmail.users.watch': { base: 100 },
  'gmail.users.labels.list': { base: 1 },
  'gmail.users.labels.get': { base: 1 },
  'gmail.users.labels.create': { base: 5 },
  'gmail.users.history.list': { base: 2 },
  'gmail.users.messages.list': { base: 5 },
  'gmail.users.messages.get': { base: 20, full: 60 },
  'gmail.users.messages.modify': { base: 5 },
  'gmail.users.messages.batchModify': { base: 50 },
  'gmail.users.messages.trash': { base: 20 },
  'gmail.users.messages.untrash': { base: 20 },
  'gmail.users.messages.delete': { base: 10 },
  'gmail.users.messages.insert': { base: 25 },
  'gmail.users.messages.send': { base: 100 },
  'gmail.users.messages.attachments.get': { base: 20 },
  'gmail.users.threads.list': { base: 10 },
  'gmail.users.threads.get': { base: 40, full: 120 },
  'gmail.users.threads.modify': { base: 10 },
  'gmail.users.threads.trash': { base: 20 },
  'gmail.users.threads.untrash': { base: 20 },
  'gmail.users.drafts.create': { base: 10 },
  'gmail.users.drafts.get': { base: 20, full: 60 },
  'gmail.users.drafts.list': { base: 5 },
  'gmail.users.drafts.update': { base: 15 },
  'gmail.users.drafts.delete': { base: 10 },
  'gmail.users.drafts.send': { base: 100 },
  'gmail.users.settings.filters.create': { base: 5 },
  'gmail.users.settings.filters.list': { base: 1 },
  'gmail.users.settings.filters.get': { base: 1 },
  'gmail.users.settings.filters.delete': { base: 5 },
  'gmail.users.settings.sendAs.list': { base: 1 },
};

/** The "old" column: projects that used the API between November 2025 and April 2026 keep these. */
export const GMAIL_UNIT_COSTS_GRANDFATHERED: Readonly<Record<string, CostEntry>> = {
  'gmail.users.messages.get': { base: 5, full: 5 },
  'gmail.users.messages.attachments.get': { base: 5 },
  'gmail.users.messages.trash': { base: 5 },
  'gmail.users.messages.untrash': { base: 5 },
  'gmail.users.threads.get': { base: 10, full: 10 },
  'gmail.users.threads.trash': { base: 10 },
  'gmail.users.threads.untrash': { base: 10 },
  'gmail.users.drafts.get': { base: 5, full: 5 },
};

/**
 * Units one call costs. `format` defaults to 'full', which is the API's own default, so a call that
 * forgot to ask for metadata is priced the way Google prices it.
 */
export function costOf(apiMethod: string, format?: string | null, grandfathered = false): number {
  const entry =
    (grandfathered ? GMAIL_UNIT_COSTS_GRANDFATHERED[apiMethod] : undefined) ??
    GMAIL_UNIT_COSTS[apiMethod];
  if (!entry) throw new Error(`No unit cost for ${apiMethod}`);
  const effective = format ?? 'full';
  const expensive = effective === 'full' || effective === 'raw' || effective === 'html';
  return expensive && entry.full !== undefined ? entry.full : entry.base;
}
