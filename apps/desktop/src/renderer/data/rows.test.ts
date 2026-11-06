/**
 * `RowFetcher` per-type id caps: `Event/get` is capped at 100 ids because an event row carries its attendees and a
 * 500-id answer can exceed the reply cap; the other types keep their caps. Node, no DOM:
 * `cd apps/desktop && npx tsx --test src/renderer/data/rows.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataClient } from './client';
import type { Id, MethodName } from './contract-shapes';
import { createEmitter } from './emitter';
import { RowCache, RowFetcher } from './rows';
import { StateOrder } from './states';
import type { CachedRowType } from './ui-types';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

const ids = (n: number, prefix: string): Id[] =>
  Array.from({ length: n }, (_, i) => `a:${prefix}${i}`);

interface SentCall {
  readonly method: MethodName;
  readonly ids: readonly Id[];
}

interface FailedChunk {
  readonly type: CachedRowType;
  readonly ids: readonly Id[];
}

/** A fetcher over a fake transport: every `T/get` answers notFound, except call `failCall` (0-based), which rejects. */
function makeFetcher(failCall = -1) {
  const calls: SentCall[] = [];
  const errors: FailedChunk[] = [];
  let sent = 0;
  const client = {
    call(method: MethodName, args: unknown) {
      const a = args as { ids?: Id[]; opIds?: Id[] };
      const wanted = a.ids ?? a.opIds ?? [];
      calls.push({ method, ids: wanted });
      const answer = { list: [], notFound: [...wanted] };
      return sent++ === failCall ? Promise.reject(new Error('tooLarge')) : Promise.resolve(answer);
    },
  } as unknown as DataClient;
  const rows = new RowCache(new StateOrder(), createEmitter());
  const fetcher = new RowFetcher(
    client,
    rows,
    () => {},
    (type, failed) => errors.push({ type, ids: [...failed] }),
  );
  return { fetcher, calls, errors };
}

test('Event/get goes out in chunks of 100 ids', () => {
  const { fetcher, calls } = makeFetcher();
  const wanted = ids(250, 'e');
  fetcher.request('Event', wanted);
  fetcher.flush();
  assert.deepEqual(
    calls.map(c => c.method),
    ['Event/get', 'Event/get', 'Event/get'],
  );
  assert.deepEqual(
    calls.map(c => c.ids.length),
    [100, 100, 50],
    'no call larger than 100',
  );
  assert.deepEqual(
    calls.flatMap(c => [...c.ids]).sort(),
    [...wanted].sort(),
    'every id exactly once',
  );
});

test('Thread still chunks at 500 and Account at 200', () => {
  const { fetcher, calls } = makeFetcher();
  fetcher.request('Thread', ids(501, 't'));
  fetcher.request('Account', ids(250, 'a'));
  fetcher.flush();
  const sizes = (method: MethodName) =>
    calls.filter(c => c.method === method).map(c => c.ids.length);
  assert.deepEqual(sizes('Thread/get'), [500, 1]);
  assert.deepEqual(sizes('Account/get'), [200, 50]);
});

test('a failed chunk reports onError for only its own ids', async () => {
  const { fetcher, calls, errors } = makeFetcher(1);
  fetcher.request('Event', ids(250, 'e'));
  fetcher.flush();
  await nextTask();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.type, 'Event');
  assert.deepEqual(errors[0]!.ids, calls[1]!.ids);
});
