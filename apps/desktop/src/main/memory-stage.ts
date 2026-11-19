import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderMemory } from '@aplos/engine/legacy/provider';
import type { MemoryWrite } from '@aplos/engine/legacy/store';
import type { MemoryStage } from '@aplos/engine/legacy/ports';
export type { MemoryStage } from '@aplos/engine/legacy/ports';

/**
 * Provider memory whose writes during a sync are saved together with the mail they describe.
 * Keys carry a version so a stage built on a value someone else has since replaced is not saved.
 */
export function createStagedMemory(base: ProviderMemory) {
  interface Stage {
    writes: Map<string, MemoryWrite>;
    seen: Map<string, number>;
    cleared: Map<string, number>;
    open: boolean;
  }
  const scope = new AsyncLocalStorage<Stage>();
  const versions = new Map<string, number>(),
    clears = new Map<string, number>();
  const slot = (accountId: string, key: string) => `${accountId}\u0000${key}`;
  const bump = (id: string) => versions.set(id, (versions.get(id) ?? 0) + 1);
  const active = () => {
    const stage = scope.getStore();
    return stage?.open ? stage : undefined;
  };
  function note(stage: Stage, accountId: string, key: string) {
    const id = slot(accountId, key);
    if (!stage.seen.has(id)) stage.seen.set(id, versions.get(id) ?? 0);
    if (!stage.cleared.has(accountId)) stage.cleared.set(accountId, clears.get(accountId) ?? 0);
    return id;
  }
  const memory: ProviderMemory = {
    get(accountId, key) {
      const stage = active();
      if (stage) {
        const id = note(stage, accountId, key);
        if (stage.writes.has(id)) return stage.writes.get(id)!.value;
      }
      return base.get(accountId, key);
    },
    set(accountId, key, value) {
      const stage = active();
      if (stage) {
        stage.writes.set(note(stage, accountId, key), { accountId, key, value });
        return;
      }
      base.set(accountId, key, value);
      bump(slot(accountId, key));
    },
    clear(accountId) {
      const stage = active();
      if (stage)
        for (const id of [...stage.writes.keys()])
          if (stage.writes.get(id)!.accountId === accountId) stage.writes.delete(id);
      base.clear(accountId);
      clears.set(accountId, (clears.get(accountId) ?? 0) + 1);
    },
  };
  function stage(): MemoryStage {
    const s: Stage = { writes: new Map(), seen: new Map(), cleared: new Map(), open: true };
    return {
      run: fn => scope.run(s, fn),
      writes() {
        for (const [id, version] of s.seen)
          if ((versions.get(id) ?? 0) !== version) return undefined;
        for (const [accountId, version] of s.cleared)
          if ((clears.get(accountId) ?? 0) !== version) return undefined;
        return [...s.writes.values()];
      },
      committed() {
        for (const id of s.writes.keys()) bump(id);
        s.open = false;
        s.writes.clear();
      },
      discard() {
        s.open = false;
        s.writes.clear();
      },
    };
  }
  return { memory, stage };
}
