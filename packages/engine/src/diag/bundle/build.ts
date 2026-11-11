import type { DiagnosticsBundle } from '@aplos/contract';
import { logAddressHashPattern, logCodePattern } from '@aplos/contract/log/events';
import { cleanCode, hashAddress } from '../redact';
import { contractError } from '../../runtime/errors';
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
    // No install salt means every accountHash below is an unsalted digest of a real id — refuse rather
    // than hand out derivable identifiers (FR-32's "only salted hashes" is a guarantee, not a format).
    if (salt === '') throw new Error('install_salt is unset');

    const accounts = q.all<AccountRow>(
      `SELECT a.id, a.provider, a.status, a.status_reason_code, a.refresh_expires_at,
              (SELECT MAX(s.updated_at) FROM sync_state s WHERE s.account_id = a.id
                AND s.scope NOT LIKE 'cal:%' AND s.scope NOT IN ('workflow', 'calendars')) AS last_sync_at
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

// ---- the production gate (FR-32): the bundle is checked on every call, not only in dev/tests ----

/** Version fields carry real strings ('macOS 26.1', '0.1.0 (build 42)'); every other string is a code. */
const FREE_TEXT = /^bundle\.versions\./;

/**
 * The keys the bundle may carry, per object. Anything the schema grows into is added here AND in
 * `StrictDiagnosticsBundle`; a key outside the list fails the gate, so a future field cannot smuggle
 * free text in under a name nobody checked.
 */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  '': new Set([
    'generatedAt',
    'versions',
    'engine',
    'accounts',
    'queues',
    'errors',
    'storage',
    'crashes',
  ]),
  versions: new Set(['app', 'api', 'schema', 'sqlite', 'os', 'electron']),
  engine: new Set(['state', 'uptimeMs', 'eventLoopP99Ms', 'parkedReason']),
  'accounts[]': new Set([
    'accountHash',
    'provider',
    'state',
    'reasonCode',
    'cursorAgeMs',
    'lastSyncAt',
    'reconnectBy',
    'budgets',
  ]),
  'budgets[]': new Set(['budget', 'target', 'unitsPerMinute', 'cooldownUntil', 'dailyBlockUntil']),
  'errors[]': new Set(['at', 'error']),
  error: new Set([
    'class',
    'provider',
    'method',
    'reason',
    'status',
    'code',
    'retryAfterMs',
    'resumeAt',
    'concurrency',
    'uncertain',
    'missingScopes',
  ]),
  queues: new Set(['ops', 'jobs', 'submissions', 'failed']),
  storage: new Set(['dbBytes', 'walBytes', 'ftsBacklog', 'bodyBytes', 'attachmentBytes']),
  crashes: new Set(['count', 'lastAt']),
};

/** Fields the schema types as any number (rates, percentages); everything else must be a safe int. */
const ANY_NUMBER = new Set([
  'eventLoopP99Ms',
  'target',
  'unitsPerMinute',
  'retryAfterMs',
  'resumeAt',
]);

const checkValue = (value: unknown, path: string, pathKey: string): void => {
  if (typeof value === 'string') {
    if (path.endsWith('.accountHash')) {
      if (!logAddressHashPattern.test(value)) throw new Error(`${path}: not a salted hash`);
    } else if (!FREE_TEXT.test(path) && !logCodePattern.test(value))
      throw new Error(`${path}: not a code`);
    return;
  }
  if (typeof value === 'number') {
    const key = path.slice(path.lastIndexOf('.') + 1);
    if (!Number.isFinite(value) || (!ANY_NUMBER.has(key) && !Number.isSafeInteger(value)))
      throw new Error(`${path}: not an allowed number`);
    // Everything the bundle carries is a count or an epoch — a negative is corruption, not data.
    if (!ANY_NUMBER.has(key) && (value as number) < 0) throw new Error(`${path}: negative`);
    return;
  }
  if (Array.isArray(value)) {
    const itemKey = `${pathKey}[]`;
    return value.forEach((v, i) => checkValue(v, `${path}[${i}]`, itemKey));
  }
  if (value && typeof value === 'object') {
    const allowed = ALLOWED[pathKey];
    if (!allowed) throw new Error(`${path}: unknown object`);
    for (const [key, v] of Object.entries(value)) {
      if (!allowed.has(key)) throw new Error(`${path}.${key}: not in the bundle`);
      checkValue(v, `${path}.${key}`, key);
    }
  }
};

/**
 * The production check `StrictDiagnosticsBundle` applies in the host, in a form the zod-free engine can run on
 * every call: the object's keys are exactly the bundle's, every string but `versions.app` is a catalog code,
 * account identities are 16-hex salted hashes, numbers are safe ints. Throws `internal` — a malformed bundle
 * must never leave in production either.
 */
export function checkBundle(bundle: DiagnosticsBundle): void {
  try {
    checkValue(bundle, 'bundle', '');
  } catch (error) {
    throw contractError({ type: 'internal', message: String(error) });
  }
}
