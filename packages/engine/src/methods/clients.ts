import type { Client, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { notImplemented, type AreaHandlers, type MethodContext } from './types';

/**
 * The `clients` area, owned by lane `eng-host`. `Clients/list` and `Clients/audit` read `clients` and `audit_log`;
 * `Clients/revoke` stamps `revoked_at` (open connections close within a second once a transport polls it).
 * `Clients/grant` stays a stub: the token file is the host's write and has no path on the real engine yet.
 */

type AuditEntry = Output<'Clients/audit'>['list'][number];

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
    ...(r.target !== null ? { target: r.target } : {}),
  }));
  return { list };
}

function revoke(args: Input<'Clients/revoke'>, ctx: MethodContext): Output<'Clients/revoke'> {
  const known = ctx.services.store.read(
    q => q.get('SELECT 1 AS one FROM clients WHERE id = ?', args.id) !== undefined,
  );
  if (!known)
    throw new ContractError({ type: 'notFound', message: 'This tool is no longer allowed.' });
  ctx.services.store.commit({
    opId: `client-revoke-${args.id}`,
    origin: 'local',
    writes: [
      { kind: 'client', id: args.id, revokedAt: ctx.services.clock.now() },
      ...auditWrites(ctx.caller, 'Clients/revoke', args.id),
    ],
  });
  return { ok: true };
}

export const handlers: AreaHandlers<'clients'> = {
  'Clients/list': list,
  'Clients/grant': notImplemented('Clients/grant'),
  'Clients/revoke': revoke,
  'Clients/audit': audit,
};
