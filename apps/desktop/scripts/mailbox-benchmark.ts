import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemo } from '@aplos/engine/legacy/demo';
import { createStore } from '../src/main/store';
import { createService } from '../src/main/service';
import { createGroq } from '../src/main/groq';
import type { AppState, Thread } from '@aplos/contract/legacy/types';
import type { ThreadPage } from '@aplos/contract/legacy/live';
import type { StoreDiff } from '@aplos/engine/legacy/store';

export function syntheticMailbox(count: number, bodySize = 2000): AppState {
  const state = createDemo(new Date('2026-10-16T12:00:00Z'));
  state.settings.onboardingDone = true;
  state.drafts = [];
  state.events = [];
  state.conversations = [];
  const body =
    'Original synthetic studio archive: plans, equipment, workshop notes and neighborhood projects. '
      .repeat(Math.ceil(bodySize / 94))
      .slice(0, bodySize);
  state.threads = Array.from({ length: count }, (_, i): Thread => {
    const id = `scale-${String(i).padStart(6, '0')}`,
      accountId = i % 2 ? 'personal' : 'work',
      subject = `Studio archive ${String(i).padStart(6, '0')}`,
      date = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    return {
      id,
      accountId,
      subject,
      date,
      summary: `Original archive entry ${i}`,
      unread: i % 3 === 0,
      status: 'new',
      importance: i % 5 ? 'important' : 'low',
      bookmarked: false,
      replyStatus: 'none',
      messages: [0, 1].map(n => ({
        id: `${id}-${n}`,
        from: `person${i % 17}@studio.example.test`,
        fromName: `Person ${i % 17}`,
        to: [accountId === 'work' ? 'alex@studio.example' : 'alex@home.example'],
        date,
        text: `${body} Entry ${i}, part ${n}.${i === count - 1 && n === 1 ? ' needlefinch unique evidence.' : ''}`,
        html: `<p>${body}</p>`,
        attachments: [],
        sent: false,
      })),
    };
  });
  return state;
}

export async function runMailboxBenchmark(
  count = 10000,
  options: { bodySize?: number; keep?: boolean; phase?: (name: string, ms: number) => void } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-scale-')),
    timings: Record<string, number> = {};
  let store: ReturnType<typeof createStore> | undefined,
    service: Awaited<ReturnType<typeof createService>> | undefined;
  const measure = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    const value = await fn();
    timings[name] = Math.round((performance.now() - start) * 100) / 100;
    options.phase?.(name, timings[name]);
    return value;
  };
  try {
    let state = syntheticMailbox(count, options.bodySize);
    store = createStore(dataDir);
    await measure('ingestMs', () => store!.write(state));
    await measure('selectiveSearchMs', () =>
      assert.deepEqual(store!.searchText('needlefinch'), [
        `scale-${String(count - 1).padStart(6, '0')}`,
      ]),
    );
    await measure('broadSearchMs', () => {
      const ids = store!.searchText('studio', 'work');
      assert.equal(ids.length, Math.min(500, Math.ceil(count / 2)));
      assert.ok(ids.every(id => Number(id.slice(6)) % 2 === 0));
    });
    const updates: number[] = [];
    for (let n = 0; n < 5; n++) {
      const at = Math.floor(count / 2) + n;
      state.threads[at] = { ...state.threads[at], bookmarked: !state.threads[at].bookmarked };
      const start = performance.now();
      const diff: StoreDiff = store.write(state);
      updates.push(performance.now() - start);
      assert.deepEqual(diff.threads, [state.threads[at].id]);
    }
    timings.singleUpdateMedianMs = Math.round(updates.sort((a, b) => a - b)[2] * 100) / 100;
    options.phase?.('singleUpdateMedianMs', timings.singleUpdateMedianMs);
    store!.close();
    store = undefined;
    state = undefined as unknown as AppState;
    const restored = await measure('databaseOpenAndReadMs', () => {
      store = createStore(dataDir);
      return store.read()!;
    });
    assert.equal(restored.threads.length, count);
    assert.equal(restored.threads.filter(t => t.bookmarked).length, 5);
    store!.close();
    store = undefined;
    service = await measure('serviceStartMs', () =>
      createService({ dataDir, autoSyncMs: 0, groq: createGroq({ apiKey: '' }) }),
    );
    const initial = await measure('initial400Ms', () =>
      service!.invoke('state.get', { threadLimit: 400 }),
    );
    assert.equal(initial.threads.length, Math.min(400, count));
    const ids = new Set<string>(initial.threads.map((t: Thread) => t.id));
    let last = initial.threads.at(-1)!;
    await measure('remainingPagesMs', async () => {
      while (ids.size < count) {
        const page = (await service!.invoke('threads.page', {
          before: { date: last.date, id: last.id },
          limit: 2000,
        })) as ThreadPage;
        assert.ok(page.threads.length);
        for (const t of page.threads) {
          assert.ok(!ids.has(t.id));
          ids.add(t.id);
        }
        last = page.threads.at(-1)!;
      }
    });
    assert.equal(ids.size, count);
    await measure('serviceSearchMs', async () => {
      const found = await service!.invoke('search', { query: 'needlefinch' });
      assert.equal(found.length, 1);
    });
    let changed = 0;
    const unsubscribe = service.subscribe(e => {
      if (e.type === 'changes')
        changed += (e.payload as { threads?: { put: unknown[] } }).threads?.put.length ?? 0;
    });
    const acknowledgement = await measure('serviceTriageMs', () =>
      service!.invoke('thread.update', {
        ids: [last.id],
        patch: { status: 'later' },
        compact: true,
      }),
    );
    assert.ok(JSON.stringify(acknowledgement).length < 200);
    assert.equal(changed, 1);
    assert.equal((await service.invoke('search', { query: 'in:later' })).length, 1);
    const undo = await measure('serviceUndoMs', () =>
      service!.invoke('thread.undo', { compact: true }),
    );
    assert.ok(JSON.stringify(undo).length < 200);
    assert.equal(changed, 2);
    assert.equal((await service.invoke('search', { query: 'in:later' })).length, 0);
    unsubscribe();
    await service.close();
    service = undefined;
    const report = {
      date: new Date().toISOString(),
      threads: count,
      messages: count * 2,
      bodyChars: options.bodySize ?? 2000,
      timings,
      databaseBytes: (await stat(join(dataDir, 'aplos.db'))).size,
      benchmarkPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      syntheticOnly: true,
      ...(options.keep ? { dataDir } : {}),
    };
    return report;
  } finally {
    store?.close();
    await service?.close();
    if (!options.keep) await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = Number(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] ?? 10000),
    label = process.argv.find(a => a.startsWith('--label='))?.split('=')[1] ?? 'latest';
  if (!Number.isInteger(count) || count < 20 || count > 100000 || !/^[a-z0-9-]+$/.test(label))
    throw new Error('Use --count=20..100000 and an alphanumeric --label.');
  const report = await runMailboxBenchmark(count, {
    keep: process.argv.includes('--keep'),
    phase: (name, ms) => console.log(`${name}: ${ms} ms`),
  });
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/mailbox-${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
