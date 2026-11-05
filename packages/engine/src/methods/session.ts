import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `session` area, owned by lane `eng-contract`: the handshake every window reads first (`Session/get`) and the
 * catch-up after a reconnect (`Session/changes`). Arguments arrive validated.
 */

const API_VERSION = 1;

/** The account kinds this build connects: Google today; the others say when they arrive. */
const PROVIDERS = [
  { kind: 'google', available: true },
  { kind: 'microsoft', available: false, unavailableReason: 'Outlook arrives in a later version.' },
  {
    kind: 'imap',
    available: false,
    unavailableReason: 'iCloud and other mail servers arrive in a later version.',
  },
  { kind: 'jmap', available: false, unavailableReason: 'Fastmail arrives in a later version.' },
] as const;

/** What the engine itself can do today; the host adds the desktop's (`HostFacts.capabilities`). */
const ENGINE_CAPABILITIES: Readonly<Record<string, boolean>> = {
  mailFrame: true,
  calendar: true,
  calendarWrite: false,
  remoteSearch: false,
  listener: false,
  clients: false,
  mcp: false,
  diagnostics: false,
  queueInspector: false,
  transcribe: false,
  workflowSync: false,
  unsubscribeOneClick: false,
  eventFollowingScope: false,
};

/** `setup.completedAt` and `setup.skippedAt` in `meta`: written by `Setup/end` (eng-ai), read here, absent until then. */
function setupFacts(ctx: MethodContext): { completedAt?: number; skippedAt?: number } {
  const rows = ctx.services.store.read(q =>
    q.all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key IN ('setup.completedAt', 'setup.skippedAt')",
    ),
  );
  const out: { completedAt?: number; skippedAt?: number } = {};
  for (const { key, value } of rows) {
    const at = Number(value);
    if (!Number.isSafeInteger(at) || at < 0) continue;
    if (key === 'setup.completedAt') out.completedAt = at;
    else out.skippedAt = at;
  }
  return out;
}

function getSession(_args: Input<'Session/get'>, ctx: MethodContext): Output<'Session/get'> {
  const { store, clock, host } = ctx.services;
  const hasAccounts = store.read(q => q.get('SELECT 1 AS one FROM accounts LIMIT 1') !== undefined);
  return {
    apiVersion: API_VERSION,
    appVersion: host.appVersion,
    schemaVersion: store.schemaVersion,
    dbEpoch: store.dbEpoch,
    state: { dbEpoch: store.dbEpoch, seq: store.seq() },
    // A running engine is ready: a parked app is main's to report, with no engine to answer this call.
    engine: { state: 'ready', resident: host.resident },
    capabilities: { ...ENGINE_CAPABILITIES, ...host.capabilities },
    providers: PROVIDERS.map(provider => ({ ...provider })),
    hasAccounts,
    setup: setupFacts(ctx),
    now: clock.now(),
    device: { id: host.device.id, name: host.device.name },
  };
}

const DEFAULT_MAX_CHANGES = 500;

function sessionChanges(
  args: Input<'Session/changes'>,
  ctx: MethodContext,
): Output<'Session/changes'> {
  const { store } = ctx.services;
  const { since, types, maxChanges = DEFAULT_MAX_CHANGES } = args;
  const page =
    since.dbEpoch === store.dbEpoch
      ? store.changesSince(since.seq, { limit: maxChanges })
      : undefined;
  if (!page || page.status !== 'ok')
    throw new ContractError({
      type: 'cannotCalculateChanges',
      message: 'Aplos needs to reload this view.',
    });
  // Several rows can name one thing: the last one is what the client needs.
  const latest = new Map<string, { type: string; id: string; op: 'u' | 'd' | '*' }>();
  for (const change of page.changes) {
    if (types && !types.includes(change.type)) continue;
    const key = `${change.type}\u0000${change.id}`;
    latest.delete(key);
    latest.set(key, { type: change.type, id: change.id, op: change.op });
  }
  return {
    oldState: { dbEpoch: since.dbEpoch, seq: since.seq },
    newState: { dbEpoch: store.dbEpoch, seq: page.toSeq },
    hasMore: page.hasMore,
    changes: [...latest.values()],
  };
}

export const handlers: AreaHandlers<'session'> = {
  'Session/get': getSession,
  'Session/changes': sessionChanges,
};
