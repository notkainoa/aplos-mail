import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { BLOB_FILE_LIMITS } from '../ports/content';
import { type AreaHandlers, type MethodContext } from './types';

/**
 * The `data` area, owned by lane `eng-store`. `Data/export` writes the owner's own data (accounts,
 * settings, workflow, drafts, conversations — the contract's list) to one JSON file blob. No credentials:
 * OAuth tokens and keys live in the vault, never in these tables, and the `clients` table's token_hash
 * stays out by exporting no client rows at all. The blob is bound to its caller like every other
 * (`runtime/blobs.ts`, FR-6): `uiOnly` keeps the method off the listener, and a blob the app made reads
 * `notFound` for any listener principal, guessed id or not.
 */

const NAME = 'aplos-data.json';

/** JSON columns are parsed into the export; an unreadable one rides along as its raw string, never dropped. */
const json = (raw: string | null): unknown => {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

function build(ctx: MethodContext): Uint8Array {
  const doc = ctx.services.store.read(q => {
    // Only these columns are exported: a credential-bearing column added later cannot leak through `SELECT *`.
    const accounts = q
      .all<Record<string, string | number | null>>(
        `SELECT id, provider, address, display_name, capabilities, granted_scopes, status,
                status_reason_code, baseline_done_at, token_granted_at, refresh_expires_at,
                remote_subject, ai_allowed, settings, color_tag, notifications, created_at
         FROM accounts ORDER BY id`,
      )
      .map(row => ({
        ...row,
        capabilities: json(row.capabilities as string | null),
        granted_scopes: json(row.granted_scopes as string | null),
        settings: json(row.settings as string | null),
      }));
    const workflow = q.all<Record<string, string | number | null>>(
      `SELECT w.thread_id, w.account_id, t.remote_id AS thread_remote_id, w.sync_key, w.status,
              w.later_until, w.due_date, w.due_source, w.reminder_at, w.reminder_fired_at,
              w.bookmarked, w.reply_status, w.todo, w.hidden_from_home, w.lane, w.importance,
              w.rank_source, w.ranked_at, w.due_band, w.last_date, w.edited_at, w.edit_gen
       FROM thread_workflow w JOIN threads t ON t.id = w.thread_id ORDER BY w.account_id, w.thread_id`,
    );
    const drafts = q
      .all<Record<string, string | number | null>>(
        `SELECT id, account_id, thread_id, revision, data, remote_draft_id, remote_message_id,
                remote_internet_id, synced_revision, origin, updated_at FROM drafts ORDER BY id`,
      )
      .map(row => ({ ...row, data: json(row.data as string | null) }));
    const conversations = q
      .all<Record<string, string | number | null>>(
        'SELECT id, pos, data FROM conversations ORDER BY pos, id',
      )
      .map(row => ({ ...row, data: json(row.data as string | null) }));
    const settings =
      json(q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data ?? null) ?? {};
    return {
      format: 'aplos-data-export',
      version: 1,
      exportedAt: ctx.services.clock.now(),
      notes: [
        'draft attachment blobIds are engine-local references; attachment bytes are not part of this export.',
      ],
      settings,
      accounts,
      workflow,
      drafts,
      conversations,
    };
  });
  // Stringify outside the read callback: the document stays a plain object while the store holds its lock.
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** One blob's ceiling (`ports/content.ts`); over it the export gzip-compresses and the name gains `.gz`. */
const MAX_BYTES = BLOB_FILE_LIMITS.maxBytes;

const gzip = (bytes: Uint8Array): Promise<Uint8Array> =>
  new Response(
    new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip')),
  )
    .arrayBuffer()
    .then(b => new Uint8Array(b));

async function dataExport(
  _args: Input<'Data/export'>,
  ctx: MethodContext,
): Promise<Output<'Data/export'>> {
  const raw = build(ctx);
  const big = raw.byteLength > MAX_BYTES;
  const bytes = big ? await gzip(raw) : raw;
  if (bytes.byteLength > MAX_BYTES)
    throw new ContractError({
      type: 'tooLarge',
      message: 'Your data is too large to export as one file.',
    });
  const name = big ? `${NAME}.gz` : NAME;
  const put = await ctx.services.blobs.put({
    caller: ctx.caller,
    connectionId: ctx.connectionId,
    kind: 'upload',
    bytes,
    mime: big ? 'application/gzip' : 'application/json',
    name,
    signal: ctx.signal,
  });
  return { blobId: put.blobId, name, size: put.size };
}

export const handlers: AreaHandlers<'data'> = {
  'Data/export': dataExport,
};
