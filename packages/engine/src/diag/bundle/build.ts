import type { DiagnosticsBundle } from '@aplos/contract';
import { cleanCode, hashAddress } from '../redact';
import type { EngineServices } from '../../runtime/services';

/**
 * The content-free diagnostics bundle (ARCH 11, eng-host's host-6): previewed before saving, never uploaded. Every
 * field a strict parse could refuse is cleaned on the way in — a stored status or reason that is not a catalog code
 * becomes 'unknown', an account is only ever the 16-hex salted hash of its id — so the host's own
 * `parseDiagnosticsBundle` check (FR-32) sees what it expects. The shape alone is the defence: no query reads a
 * subject, a body, an address or a token, so nothing can leak through a field the schema forgot.
 *
 * Honest gaps (nothing fabricates them): `errors` stays empty until a classified-error buffer exists (host-6's
 * ring buffers are later work), `walBytes` is 0 (no engine-side way to size the WAL; a host file-stat port is the
 * follow-up), `crashes` is 0 (main owns the crash dumps) and `eventLoopP99Ms`/`parkedReason` are host facts the
 * engine never sees.
 */

const API_VERSION = 1;

/** A catalog code that fits the field's bound, or 'unknown': a stored value outside the pattern must never fail the parse. */
const code = (value: unknown, max: number): string => {
  const clean = cleanCode(value);
  return clean !== undefined && clean.length <= max ? clean : 'unknown';
};

/** A `line` field: one line within the bound, always. */
const line = (value: unknown, max: number): string =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max) || 'unknown';

interface AccountRow {
  [key: string]: string | number | null;
  id: string;
  provider: string;
  status: string;
  status_reason_code: string | null;
  refresh_expires_at: number | null;
  last_sync_at: number | null;
}

interface BudgetRow {
  [key: string]: string | number | null;
  account_id: string;
  budget: string;
  target: number | null;
  cooldown_until: number | null;
  daily_block_until: number | null;
}

/** Builds the bundle in one store read; `startedAt` is the compose stamp (`services.diagStartedAt`) for uptimeMs. */
export function buildBundle(services: EngineServices, now: number): DiagnosticsBundle {
  const { store, host } = services;
  return store.read(q => {
    const salt =
      q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'install_salt'")?.value ?? '';

    const accounts = q.all<AccountRow>(
      `SELECT a.id, a.provider, a.status, a.status_reason_code, a.refresh_expires_at,
              (SELECT MAX(s.updated_at) FROM sync_state s WHERE s.account_id = a.id) AS last_sync_at
       FROM accounts a ORDER BY a.id`,
    );
    const budgets = q.all<BudgetRow>(
      `SELECT account_id, budget, target, cooldown_until, daily_block_until
       FROM governor_state WHERE account_id != '*' ORDER BY account_id, budget`,
    );
    const budgetsByAccount = new Map<string, BudgetRow[]>();
    for (const row of budgets) {
      const list = budgetsByAccount.get(row.account_id) ?? [];
      list.push(row);
      budgetsByAccount.set(row.account_id, list);
    }

    const queues = q.get<{ ops: number; jobs: number; submissions: number; failed: number }>(
      `SELECT
         (SELECT COUNT(*) FROM ops WHERE state = 'queued') AS ops,
         (SELECT COUNT(*) FROM jobs WHERE state = 'queued') AS jobs,
         (SELECT COUNT(*) FROM submissions WHERE state IN ('queued', 'scheduled')) AS submissions,
         (SELECT COUNT(*) FROM ops WHERE state = 'failed') +
           (SELECT COUNT(*) FROM jobs WHERE state = 'failed') +
           (SELECT COUNT(*) FROM submissions WHERE state = 'failed') AS failed`,
    ) ?? { ops: 0, jobs: 0, submissions: 0, failed: 0 };

    const pageCount = q.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0;
    const pageSize = q.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0;
    const ftsBacklog =
      q.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE (parts & 8) = 0')?.n ?? 0;
    const bodyBytes =
      q.get<{ n: number }>('SELECT COALESCE(SUM(raw_size), 0) AS n FROM bodies')?.n ?? 0;
    const attachmentBytes =
      q.get<{ n: number }>(
        'SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE path IS NOT NULL',
      )?.n ?? 0;
    const sqlite = q.get<{ v: string }>('SELECT sqlite_version() AS v')?.v;

    return {
      generatedAt: now,
      versions: {
        app: line(host.appVersion, 100),
        api: API_VERSION,
        schema: store.schemaVersion,
        ...(sqlite ? { sqlite: line(sqlite, 40) } : {}),
      },
      engine: {
        state: 'ready',
        uptimeMs:
          services.diagStartedAt === undefined ? 0 : Math.max(0, now - services.diagStartedAt),
      },
      accounts: accounts.map(a => ({
        accountHash: hashAddress(salt, a.id),
        provider: code(a.provider, 30),
        state: code(a.status, 40),
        ...(a.status_reason_code ? { reasonCode: code(a.status_reason_code, 60) } : {}),
        ...(a.last_sync_at !== null
          ? { cursorAgeMs: Math.max(0, now - a.last_sync_at), lastSyncAt: a.last_sync_at }
          : {}),
        ...(a.refresh_expires_at !== null ? { reconnectBy: a.refresh_expires_at } : {}),
        budgets: (budgetsByAccount.get(a.id) ?? []).map(b => ({
          budget: code(b.budget, 60),
          ...(b.target !== null ? { target: b.target } : {}),
          ...(b.cooldown_until !== null ? { cooldownUntil: b.cooldown_until } : {}),
          ...(b.daily_block_until !== null ? { dailyBlockUntil: b.daily_block_until } : {}),
        })),
      })),
      queues,
      errors: [],
      storage: {
        dbBytes: pageCount * pageSize,
        walBytes: 0,
        ftsBacklog,
        bodyBytes,
        attachmentBytes,
      },
      crashes: { count: 0 },
    };
  });
}
