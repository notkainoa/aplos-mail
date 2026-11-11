/**
 * Settings' Help section, the pure layer: the sync queue as readable rows and the diagnostics bundle as readable
 * sections. Split out of settings.model.ts (which re-exports it) to keep each module small.
 */
import type { BundleInfo, QueueEntry } from './settings.model';

const REASON_SENTENCES: Record<string, string> = {
  'rate.minute': 'Google asked us to slow down.',
  'rate.concurrency': 'Google asked us to slow down.',
  'quota.daily': 'Google’s daily limit is reached.',
  'auth.expired': 'Google needs you to sign in again.',
  'auth.revoked': 'Access to this account was turned off.',
  'net.offline': 'You’re offline.',
  'server.unavailable': 'Google isn’t answering right now.',
  'ai.noProvider': 'No AI provider is set up.',
  'ai.missingKey': 'The AI key was refused.',
  'ai.unreachable': 'The AI provider didn’t answer.',
  'ai.dailyCap': 'Today’s AI limit is reached.',
  'ai.rateLimited': 'The AI provider asked us to slow down.',
  'ai.noConsent': 'Waiting for you to allow background AI.',
  'send.overdue': 'The send missed its time while this Mac was off.',
};

/** One plain sentence for a queue item's reason code. The item's own message is never shown. */
export function queueProblem(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return REASON_SENTENCES[code] ?? 'Something went wrong. Retry it, or discard it.';
}

const QUEUE_KIND: Record<string, string> = { op: 'Change', job: 'AI job', submission: 'Message' };
const STATE_WORDS: Record<string, string> = {
  queued: 'Waiting',
  running: 'Running',
  failed: 'Failed',
  dead: 'Gave up',
  pending: 'Waiting',
  applied: 'Applied',
  syncing: 'Syncing',
  sending: 'Sending',
  scheduled: 'Scheduled',
  uncertain: 'Needs a look',
};
export interface QueueRow {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly state: string;
  readonly detail: string;
  readonly problem?: string;
  readonly canRetry: boolean;
  readonly canDiscard: boolean;
  /** A discarded message stops a send, so it asks first. */
  readonly confirmDiscard: boolean;
}
export function queueRows(items: readonly QueueEntry[] | undefined): readonly QueueRow[] {
  return (items ?? []).map(i => ({
    id: i.id,
    kind: QUEUE_KIND[i.kind] ?? i.kind,
    label: i.label,
    state: STATE_WORDS[i.state] ?? i.state,
    detail:
      i.attempts === 0
        ? 'Not tried yet'
        : i.attempts === 1
          ? 'Tried once'
          : `Tried ${i.attempts} times`,
    problem: queueProblem(i.problem?.reasonCode),
    canRetry: i.canRetry,
    canDiscard: i.canDiscard,
    confirmDiscard: i.kind === 'submission',
  }));
}

export interface BundleSection {
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

function bytesText(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The content-free diagnostics bundle as readable sections for the preview dialog (ARCH 11). Only fields the schema
 * allows exist; addresses are salted hashes and are shown short. Nothing here comes from mail.
 */
export function bundleSections(bundle: BundleInfo): readonly BundleSection[] {
  const sections: BundleSection[] = [
    {
      title: 'Versions',
      rows: [
        { label: 'Aplos', value: bundle.versions.app },
        { label: 'Interface', value: String(bundle.versions.api) },
        { label: 'Database', value: String(bundle.versions.schema) },
        ...(bundle.versions.os ? [{ label: 'macOS', value: bundle.versions.os }] : []),
      ],
    },
    {
      title: 'Engine',
      rows: [
        { label: 'State', value: bundle.engine.state },
        { label: 'Running for', value: `${Math.round(bundle.engine.uptimeMs / 60_000)} min` },
      ],
    },
    {
      title: 'Accounts',
      rows: bundle.accounts.map(a => ({
        label: `${a.provider} · ${a.accountHash.slice(0, 8)}`,
        value: a.reasonCode ? `${a.state} · ${a.reasonCode}` : a.state,
      })),
    },
    {
      title: 'Queues',
      rows: [
        { label: 'Changes', value: String(bundle.queues.ops) },
        { label: 'AI jobs', value: String(bundle.queues.jobs) },
        { label: 'Messages', value: String(bundle.queues.submissions) },
        { label: 'Failed', value: String(bundle.queues.failed) },
      ],
    },
    {
      title: 'Storage',
      rows: [
        { label: 'Database', value: bytesText(bundle.storage.dbBytes) },
        { label: 'Message text', value: bytesText(bundle.storage.bodyBytes) },
        { label: 'Attachments', value: bytesText(bundle.storage.attachmentBytes) },
      ],
    },
    {
      title: 'Crashes and errors',
      rows: [
        { label: 'Crashes', value: String(bundle.crashes.count) },
        { label: 'Recent errors', value: String(bundle.errors.length) },
      ],
    },
  ];
  return sections.filter(s => s.rows.length > 0);
}

/**
 * A queue action, then a reload of the inspector's rows. The reload is best-effort: it failing must never report
 * the action itself as failed ("Couldn't retry that item" when the retry worked). The action's error still
 * propagates, so Retry means the write, not the reload.
 */
export async function actThenList(
  act: () => Promise<void>,
  list: () => Promise<readonly QueueEntry[]>,
): Promise<readonly QueueEntry[] | undefined> {
  await act();
  try {
    return await list();
  } catch {
    return undefined;
  }
}

/** The diagnostics note above the preview: what it holds and what it never does. */
export const DIAGNOSTICS_NOTE =
  'This report holds versions, counts and error codes. It holds no mail, no addresses and no keys, and it is never uploaded. Save report writes it to a file; Copy report puts it on your clipboard.';

/** Verbose logging is on while the engine's switch-off time is still ahead (no time given: until it is turned off). */
export function verboseOn(verbose: { readonly until?: number } | undefined, now: number): boolean {
  return verbose !== undefined && (verbose.until === undefined || verbose.until > now);
}

/** The engine's answer as the screen keeps it: a switch-off time means on; no time means off. */
export function verboseFrom(answer: {
  readonly until?: number;
}): { readonly until?: number } | undefined {
  return answer.until === undefined ? undefined : { until: answer.until };
}

/** The verbose-logging row's sentence: what it does, and when it turns itself off. */
export function verboseLine(verbose: { readonly until?: number } | undefined, now: number): string {
  if (!verboseOn(verbose, now)) return 'Headers only, never mail. Turns off in 15 minutes.';
  if (verbose?.until === undefined) return 'On. Headers only, never mail.';
  const at = new Date(verbose.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `On until ${at}. Headers only, never mail.`;
}

export const DATA_EXPORT_LINE = 'Accounts, settings, drafts, Ask conversations. No keys.';
export const DATA_EXPORTED_LINE = 'Saved. It holds no passwords, keys or tokens.';
