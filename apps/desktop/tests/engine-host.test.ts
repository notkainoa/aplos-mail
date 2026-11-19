import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createStore } from '../src/main/store';
import { createStagedMemory } from '../src/main/memory-stage';
import { createGroq } from '../src/main/groq';
import type { createEngineService } from '@aplos/engine/legacy/service';

// The legacy engine with this app's Node host pieces (store, staged memory, Groq); the engine's own
// portability checks live in packages/engine/tests/portability.test.ts.
const engine = join(import.meta.dirname, '..', '..', '..', 'packages', 'engine', 'src', 'legacy');

test('mail orchestration runs without process, Buffer, require or Node timer handles', async () => {
  const result = await build({
    entryPoints: [join(engine, 'service.ts')],
    bundle: true,
    platform: 'neutral',
    format: 'iife',
    globalName: 'AplosEngine',
    mainFields: ['module', 'main'],
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  // Browser-style numeric timer IDs deliberately have no Node .unref() method.
  let sequence = 0;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  const schedule = (fn: () => void, ms: number, repeat = false) => {
    const id = ++sequence;
    handles.set(id, repeat ? setInterval(fn, ms) : setTimeout(fn, ms));
    return id;
  };
  const clear = (id: number) => {
    const handle = handles.get(id);
    if (handle) {
      clearTimeout(handle);
      clearInterval(handle);
      handles.delete(id);
    }
  };
  const context = {
    structuredClone,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout: (fn: () => void, ms: number) => schedule(fn, ms),
    setInterval: (fn: () => void, ms: number) => schedule(fn, ms, true),
    clearTimeout: clear,
    clearInterval: clear,
  };
  const create = runInNewContext(
    result.outputFiles[0].text + ';AplosEngine.createEngineService',
    context,
  ) as typeof createEngineService;
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-portable-service-'));
  const store = createStore(dataDir);
  let service: Awaited<ReturnType<typeof createEngineService>> | undefined;
  try {
    service = await create({
      store,
      staged: createStagedMemory(store.memory),
      providers: {},
      groq: createGroq({ apiKey: '' }),
      secure: false,
      randomUUID,
      autoSyncMs: 0,
    });
    const initial = await service.invoke('state.get');
    assert.equal(initial.threads.length, 18);
    assert.equal(
      runInNewContext('typeof process+","+typeof Buffer+","+typeof require', context),
      'undefined,undefined,undefined',
    );
    await service.invoke('thread.update', {
      ids: ['garden'],
      patch: { status: 'later', todo: 'Portable orchestration' },
    });
    assert.equal(
      (await service.invoke('state.get')).threads.find((t: { id: string }) => t.id === 'garden')
        .todo,
      'Portable orchestration',
    );
    await service.invoke('thread.undo');
    assert.equal(
      (await service.invoke('state.get')).threads.find((t: { id: string }) => t.id === 'garden')
        .status,
      'new',
    );
    const attachment = await service.invoke('attachment.get', {
      threadId: 'garden',
      attachmentId: 'att-notes',
    });
    assert.match(Buffer.from(attachment.data, 'base64').toString(), /Community garden/);
    assert.ok(
      (await service.invoke('search', { query: 'gard has:attachment' })).some(
        (t: { id: string }) => t.id === 'garden',
      ),
    );
    const saved = await service.invoke('draft.save', {
      draft: {
        id: 'portable-draft',
        accountId: 'work',
        to: 'reader@verification.example',
        cc: '',
        bcc: '',
        subject: 'Portable send',
        html: '<p>Local portable engine check.</p>',
        attachments: [{ name: 'original.txt', type: 'text/plain', data: 'SGVsbG8=' }],
        mode: 'new',
        signature: false,
        revision: 0,
      },
    });
    assert.equal(saved.attachments[0].size, 5);
    assert.ok(saved.attachments[0].id);
    await service.invoke('settings.update', { patch: { undoSeconds: 0 } });
    await service.invoke('draft.send', { id: saved.id });
    for (
      let i = 0;
      i < 100 &&
      (await service.invoke('state.get')).drafts.some((d: { id: string }) => d.id === saved.id);
      i++
    )
      await new Promise(r => setTimeout(r, 10));
    assert.ok(
      (await service.invoke('state.get')).threads.some(
        (t: { subject: string }) => t.subject === 'Portable send',
      ),
    );
    await assert.rejects(service.invoke('workflow.enable'), /unavailable/);
  } finally {
    if (service) await service.close();
    else store.close();
    for (const id of handles.keys()) clear(id);
    await rm(dataDir, { recursive: true, force: true });
  }
});
