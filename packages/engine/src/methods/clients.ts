import type { Client, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { sha256Hex } from '../diag/sha256';
import { auditWrites } from '../host/audit';
import { isAbsent } from '../runtime/engine';
import { nonce, type AreaHandlers, type MethodContext } from './types';

/**
 * The `clients` area, owned by lane `eng-host`. `Clients/list` and `Clients/audit` read `clients` and `audit_log`;
 * `Clients/revoke` stamps `revoked_at` (open connections close within a second once a transport polls it).
 * `Clients/grant` mints a 256-bit token, stores only its SHA-256 in `clients`, and hands the plaintext to the
 * host's `clientTokens` port for the 0600 file — the token never crosses the contract, and without the port
 * there is no grant at all.
 */

type AuditEntry = Output<'Clients/audit'>['list'][number];

/** The audited methods whose target is a client id, safe to show to whoever reads the audit. */
const TARGET_IS_CLIENT: ReadonlySet<string> = new Set(['Clients/revoke', 'Clients/grant']);

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

interface ClientRow {
  [key: string]: string | number | null | Uint8Array;
  id: string;
  name: string;
  kind: string;
  scopes: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const toClient = (row: ClientRow): Client => {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter(s => typeof s === 'string');
  } catch {
    /* a damaged row lists no scopes */
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Client['kind'],
    scopes: scopes as Client['scopes'],
    createdAt: row.created_at,
    ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
};

function list(_args: Input<'Clients/list'>, ctx: MethodContext): Output<'Clients/list'> {
  const list = ctx.services.store.read(q =>
    q
      .all<ClientRow>(
        'SELECT id, name, kind, scopes, created_at, last_seen_at, revoked_at FROM clients ORDER BY created_at, id',
      )
      .map(toClient),
  );
  return { list };
}

function audit(args: Input<'Clients/audit'>, ctx: MethodContext): Output<'Clients/audit'> {
  const limit = args.limit ?? 200;
  const rows = ctx.services.store.read(q =>
    args.clientId
      ? q.all<{ id: number; at: number; client_id: string; method: string; target: string | null }>(
          'SELECT id, at, client_id, method, target FROM audit_log WHERE client_id = ? ORDER BY at DESC, id DESC LIMIT ?',
          args.clientId,
          limit,
        )
      : q.all<{ id: number; at: number; client_id: string; method: string; target: string | null }>(
          'SELECT id, at, client_id, method, target FROM audit_log ORDER BY at DESC, id DESC LIMIT ?',
          limit,
        ),
  );
  const list: AuditEntry[] = rows.map(r => ({
    id: String(r.id),
    at: r.at,
    clientId: r.client_id,
    method: r.method,
    // A target is shown only where it is a client id. Everywhere else it can be content (an allowed sender's address).
    ...(r.target !== null && TARGET_IS_CLIENT.has(r.method) ? { target: r.target } : {}),
  }));
  return { list };
}

async function revoke(
  args: Input<'Clients/revoke'>,
  ctx: MethodContext,
): Promise<Output<'Clients/revoke'>> {
  const known = ctx.services.store.read(
    q => q.get('SELECT 1 AS one FROM clients WHERE id = ?', args.id) !== undefined,
  );
  if (!known)
    throw new ContractError({ type: 'notFound', message: 'This tool is no longer allowed.' });
  ctx.services.store.commit({
    opId: `client-revoke-${args.id}-${nonce(ctx)}`,
    origin: 'local',
    writes: [
      { kind: 'client', id: args.id, revokedAt: ctx.services.clock.now() },
      ...auditWrites(ctx.caller, 'Clients/revoke', args.id),
    ],
  });
  // The row is revoked, so no transport authenticates the token again — the file can go. Removing it is
  // best effort: the revoke already happened, so a file that will not delete must never error the call.
  if (!isAbsent(ctx.services.clientTokens))
    try {
      await ctx.services.clientTokens.remove(args.id);
    } catch {
      ctx.services.log.event('client.token_remove_failed', { client: args.id, error: 'fs' });
    }
  return { ok: true };
}

async function grant(
  args: Input<'Clients/grant'>,
  ctx: MethodContext,
): Promise<Output<'Clients/grant'>> {
  if (isAbsent(ctx.services.clientTokens))
    throw new ContractError({
      type: 'unavailable',
      message: 'This part of Aplos is not running yet.',
    });
  // A retry of the same grant (a double-click or a lost response) returns the live row instead of minting a
  // duplicate tool — but only when name, kind AND the requested scopes all match (a wider or narrower ask
  // is a different tool) and its token file is still there (a row without its file could never authenticate).
  const scopes = [...new Set(args.scopes)] as Client['scopes'];
  const existing = ctx.services.store.read(q =>
    q.get<ClientRow>(
      'SELECT id, name, kind, scopes, created_at, last_seen_at, revoked_at FROM clients WHERE name = ? AND kind = ? AND revoked_at IS NULL',
      args.name,
      args.kind,
    ),
  );
  if (existing) {
    const same = toClient(existing);
    const asked = [...scopes].sort();
    const held = [...same.scopes].sort();
    if (
      held.length === asked.length &&
      held.every((s, i) => s === asked[i]) &&
      (await ctx.services.clientTokens.has(existing.id))
    )
      return { client: { ...same, tokenPath: ctx.services.clientTokens.pathOf(existing.id) } };
  }
  const id = `cl_${hex(ctx.services.randomBytes(16))}`;
  const token = hex(ctx.services.randomBytes(32));
  const createdAt = ctx.services.clock.now();
  // The token file lands first: a failed issue leaves no row, and a failed commit drops the file too.
  const { path } = await ctx.services.clientTokens.issue(id, token);
  try {
    ctx.services.store.commit({
      opId: `client-grant-${id}-${nonce(ctx)}`,
      origin: 'local',
      writes: [
        {
          kind: 'client',
          id,
          grant: {
            name: args.name,
            clientKind: args.kind,
            tokenHash: sha256Hex(token),
            scopes,
            createdAt,
          },
        },
        ...auditWrites(ctx.caller, 'Clients/grant', id),
      ],
    });
  } catch (error) {
    // A committed row must never lack its token file; a failed commit leaves only the file, so drop it —
    // but the caller's error is the commit's, never a cleanup failure.
    await ctx.services.clientTokens.remove(id).catch(() => undefined);
    throw error;
  }
  return {
    client: { id, name: args.name, kind: args.kind, scopes, createdAt, tokenPath: path },
  };
}

export const handlers: AreaHandlers<'clients'> = {
  'Clients/list': list,
  'Clients/grant': grant,
  'Clients/revoke': revoke,
  'Clients/audit': audit,
};
