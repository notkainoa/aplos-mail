import { ProviderError, type AccountId } from '../ports/base';
import type {
  AdapterAccount,
  AdapterContext,
  AttachmentRef,
  FolderList,
  OpenedThread,
  ProviderAdapter,
  ServerSearch,
} from '../ports/provider';
import type { StorePort, StoreWrite } from '../store/port';
import { messageWrite, messageWrites } from './facts';
import { readFence } from './ops';

/**
 * The byte reads of the `ProviderPort` section (`sync/host.ts` keeps search): a thread's open, one attachment's
 * bytes, and the message's raw RFC822 for `Message/original`. Each takes the account's actor entry — the adapter and
 * the actor that supplies the governed context. Loaded on the first read (`import()` in `sync/host.ts`), so none of it
 * counts against the engine core.
 */
export interface ReadEntry {
  adapter: Pick<
    ProviderAdapter,
    'kind' | 'fetchAttachment' | 'openThread' | 'listFolder' | 'search'
  > & {
    /**
     * The adapter's optional raw-RFC822 read (`ProviderPort.original`); the Gmail adapter has it
     * (`bodies.ts fetchOriginal`). Declared structurally: an adapter that cannot serve it leaves it out.
     * `opts.signal` is the caller's view of the deadline (a lane stop or the 120 s total), merged into the
     * adapter's own abort set so the HTTP read really stops.
     */
    original?(
      remoteMessageId: string,
      ctx: AdapterContext,
      opts?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Uint8Array>>;
  };
  actor: { context(): AdapterContext };
}

/** One attachment's bytes (`messages.attachments.get` on Gmail), on the account's own context. */
export function attachmentBytes(
  entry: ReadEntry,
  ref: AttachmentRef,
): Promise<AsyncIterable<Uint8Array>> {
  return entry.adapter.fetchAttachment(ref, entry.actor.context());
}

/** Thread reads in flight, per mailbox (`sharedOpen`). */
const inFlight = new WeakMap<StorePort, Map<string, Promise<OpenedThread>>>();
/** Threads whose last open left a body part behind, per mailbox (`sharedOpen`). */
const leftPartial = new WeakMap<StorePort, Set<string>>();

function perStore<T>(map: WeakMap<StorePort, T>, store: StorePort, make: () => T): T {
  const found = map.get(store) ?? make();
  map.set(store, found);
  return found;
}

/**
 * `openThreadRemote` with reads in flight shared (fix-bodies S2): one open of an email used to fetch the thread twice
 * (`Thread/open` and `MessageBody/get`, both interactive), each a full `threads.get` waiting its turn for the one
 * reserved slot. A caller joins a read already going out with the same lane, account, thread, known count and actor
 * generation; an interactive caller never joins a prefetch read, so it never waits behind the slow lane.
 *
 * A thread whose last open left a body part behind (a pause, a failed part) is read again only when someone opens it,
 * never by a prefetch: otherwise every hover or focus would spend another full `threads.get` on it.
 */
export function sharedOpen(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteThreadId: string,
  opts: { knownCount?: number; lane?: 'interactive' | 'prefetch' },
): Promise<OpenedThread> {
  const lane = opts.lane ?? 'interactive';
  const thread = `${account} ${remoteThreadId}`;
  const partial = perStore(leftPartial, store, () => new Set<string>());
  if (lane === 'prefetch' && partial.has(thread))
    return Promise.resolve({ messages: [], costUnits: 0 });
  const opening = perStore(inFlight, store, () => new Map<string, Promise<OpenedThread>>());
  const key = `${lane} ${thread} ${opts.knownCount ?? ''} ${entry.actor.context().generation}`;
  const going = opening.get(key);
  if (going) return going;
  const read = openThreadRemote(entry, store, newId, account, remoteThreadId, opts);
  opening.set(key, read);
  const settled = (opened?: OpenedThread) => {
    opening.delete(key);
    if (!opened) return;
    if (opened.messages.some(m => m.partial)) partial.add(thread);
    else partial.delete(thread);
  };
  read.then(settled, () => settled());
  return read;
}

/** `ProviderPort.openThread` (AM-1): the adapter read plus the fence and commit the host owes the store. */
export async function openThreadRemote(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteThreadId: string,
  opts: { knownCount?: number; lane?: 'interactive' | 'prefetch' },
): Promise<OpenedThread> {
  const ctx = entry.actor.context();
  const fence = readFence(store, account, ctx.generation);
  const opened = await entry.adapter.openThread(
    { remoteThreadId, ...(opts.knownCount !== undefined ? { knownCount: opts.knownCount } : {}) },
    opts.lane ?? 'interactive',
    ctx,
  );
  store.commit({
    opId: newId(),
    origin: 'sync',
    fenceSeq: fence,
    writes: openedWrites(ctx.account, remoteThreadId, opened),
  });
  return opened;
}

/**
 * `ProviderPort.search` (D2): the adapter read plus the fence and commit the host owes the store. The caller
 * checks `entry.adapter.search` exists first; committed under `step: 'search'` so the rows never count as synced
 * facts a sweep could remove.
 */
export async function searchRemote(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  query: ServerSearch,
): Promise<{ remoteThreadIds: string[]; nextPageToken?: string; partial?: boolean }> {
  const ctx = entry.actor.context();
  const fence = readFence(store, account, ctx.generation);
  const result = await entry.adapter.search!(query, ctx);
  store.commit({
    opId: newId(),
    origin: 'sync',
    step: 'search',
    fenceSeq: fence,
    writes: result.upserts.map(m => messageWrite(account, ctx.account.address, m)),
  });
  return {
    remoteThreadIds: result.remoteThreadIds,
    ...(result.nextPageToken !== undefined ? { nextPageToken: result.nextPageToken } : {}),
    ...(result.partial !== undefined ? { partial: result.partial } : {}),
  };
}

/**
 * A `lazy` folder opened in the UI (`ProviderPort.listFolder`): the account's `folder:<remoteId>` sync_state row is
 * the throttle, the failure backoff and the deep walk's bookmark. An open sooner than `FOLDER_REFETCH_MS` after the
 * last stamp changes nothing. Each open pays exactly one provider page on the `interactive` lane — a held token
 * continues the walk, none re-reads the head — so opening Spam or a big label never competes with the owner's own
 * thread opens. A failure stamps the row anyway (token cleared, throttle held): the next open backs off instead of
 * paying the same call, and a rejected token can never wedge the folder. The commit is `origin='sync'` with NULL
 * `seen_gen` (no sweep owns these placements); later history keeps them honest.
 */
export const FOLDER_REFETCH_MS = 60_000;

/** Folder opens in flight, per mailbox: overlapping `View/watch`/`View/query` callers join the one fetch. */
const openingFolder = new WeakMap<StorePort, Map<string, Promise<void>>>();

export async function ensureFolder(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteFolderId: string,
): Promise<void> {
  if (!entry.adapter.listFolder) return;
  // The key holds no fence/generation: opens on either side of a commit are the same fetch.
  const key = `${account} ${remoteFolderId}`;
  const going = perStore(openingFolder, store, () => new Map<string, Promise<void>>());
  const held = going.get(key);
  if (held) return held;
  const run = fetchFolder(entry, store, newId, account, remoteFolderId);
  going.set(key, run);
  run.then(
    () => going.delete(key),
    () => going.delete(key),
  );
  return run;
}

async function fetchFolder(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteFolderId: string,
): Promise<void> {
  const ctx = entry.actor.context();
  const scope = `folder:${remoteFolderId}`;
  const state = store.read(q =>
    q.get<{ page_token: string | null; updated_at: number }>(
      'SELECT page_token, updated_at FROM sync_state WHERE account_id = ? AND scope = ?',
      account,
      scope,
    ),
  );
  if (state && ctx.clock.now() - state.updated_at < FOLDER_REFETCH_MS) return;
  const fence = readFence(store, account, ctx.generation);
  let result: FolderList;
  try {
    result = await entry.adapter.listFolder!(remoteFolderId, state?.page_token ?? undefined, ctx);
  } catch (error) {
    // A failure or a refused token clears the bookmark and holds the throttle — never a wedge, never a hammer.
    store.commit({
      opId: newId(),
      origin: 'sync',
      fenceSeq: fence,
      writes: [{ kind: 'syncState', accountId: account, scope, generation: ctx.generation }],
    });
    throw error;
  }
  store.commit({
    opId: newId(),
    origin: 'sync',
    fenceSeq: fence,
    writes: [
      ...result.upserts.map(m => messageWrite(account, ctx.account.address, m)),
      {
        kind: 'syncState',
        accountId: account,
        scope,
        generation: ctx.generation,
        ...(result.nextPageToken !== undefined ? { pageToken: result.nextPageToken } : {}),
      },
    ],
  });
}

/**
 * The message's raw RFC822, fetched live and never cached (`ports/engine.ts` `ProviderPort.original`). An adapter
 * without it answers `unavailable`, not absent, so the caller can tell "this account cannot" from "this read failed".
 */
export function originalRemote(
  entry: ReadEntry,
  remoteMessageId: string,
  opts?: { signal?: AbortSignal },
): Promise<AsyncIterable<Uint8Array>> {
  if (!entry.adapter.original)
    throw new ProviderError({
      class: 'permanent',
      provider: entry.adapter.kind,
      method: 'ProviderPort.original',
      reason: 'unavailable',
      uncertain: false,
    });
  return entry.adapter.original(remoteMessageId, entry.actor.context(), opts);
}

/** An opened thread: full messages, bodies, `complete`, and messages the thread no longer has. */
export function openedWrites(
  account: AdapterAccount,
  remoteThreadId: string,
  opened: OpenedThread,
): StoreWrite[] {
  const id = account.id;
  const writes: StoreWrite[] = [];
  let size: number | undefined;
  let complete = true;
  for (const m of opened.messages) {
    const { body, ...facts } = m;
    writes.push(...messageWrites(id, account.address, facts));
    // A body part that did not arrive (a pause, a failed part fetch) is not stored (fix-bodies R3): a stored body is
    // never fetched again, so it would read as a blank letter forever. Left out, the thread stays partial and the next
    // open fetches it again.
    if (m.partial) complete = false;
    else
      writes.push({
        kind: 'body',
        accountId: id,
        remoteId: m.remoteId,
        body: { text: body.text, html: body.html, cidMap: body.cidMap },
      });
    size = m.threadSize ?? size;
  }
  for (const remoteId of opened.removed ?? [])
    writes.push({ kind: 'messageDelete', accountId: id, remoteId });
  writes.push({
    kind: 'thread',
    accountId: id,
    remoteThreadId,
    complete,
    remoteCount: size ?? opened.messages.length,
  });
  return writes;
}
