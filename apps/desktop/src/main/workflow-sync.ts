import { randomUUID } from 'node:crypto';
import type { Account, Thread } from '@aplos/contract/legacy/types';
import type { MailProvider, ProviderMemory } from '@aplos/engine/legacy/provider';
import {
  applyLog,
  compactLog,
  keySchemeFor,
  parseWorkflowLog,
  publishLog,
  sameLog,
  workflowEdit,
  type WorkflowEdit,
  type WorkflowLog,
  type WorkflowPatch,
} from '@aplos/engine/legacy/workflow';
import {
  generateSyncCode,
  normalizeSyncCode,
  openWorkflow,
  sealWorkflow,
  WorkflowCryptoError,
} from './workflow-crypto';
import { createVault } from './vault';

/** Provider memory key for the device's own ID, kept under a pseudo-account that no disconnect clears. */
const DEVICE = 'aplos-device';
/** Per account: pending edits `{gen, items: threadId → WorkflowEdit}`, and `key → stamp` of entries already applied or published. */
const EDITS = 'workflow.edits',
  APPLIED = 'workflow.applied';
/** Written by the first version of device sync: the last log seen, and the IDs of edited threads. */
const LEGACY_KNOWN = 'workflow.known',
  LEGACY_EDITED = 'workflow.edited';
const MAX_EDITS = 20_000;

interface Edits {
  gen: number;
  items: Record<string, WorkflowEdit>;
}

export interface WorkflowSyncOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  memory: ProviderMemory;
  now: () => Date;
}

/**
 * Done, Later, todos, due dates and reminders, shared between devices through each account's hidden
 * "Aplos" folder. The sync code is the only key; it stays in the credential vault and never reaches
 * the host. All other state lives in provider memory, whose writes during a round are saved together with
 * the returned patches, so a round that is interrupted or discarded is simply done again.
 */
export async function createWorkflowSync(options: WorkflowSyncOptions) {
  const vault = await createVault<string>({
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    file: 'workflow-sync.enc.json',
  });
  const { memory } = options;
  let device = memory.get(DEVICE, 'id');
  if (!device) {
    device = randomUUID();
    memory.set(DEVICE, 'id', device);
  }
  const json = (accountId: string, key: string): unknown => {
    const raw = memory.get(accountId, key);
    if (!raw) return;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const edits = (accountId: string): Edits => {
    const v = json(accountId, EDITS) as Edits | undefined;
    return v && typeof v.gen === 'number' && v.items && typeof v.items === 'object'
      ? v
      : { gen: 0, items: {} };
  };
  const appliedMap = (accountId: string): Record<string, string> => {
    const v = json(accountId, APPLIED);
    if (v && typeof v === 'object') return v as Record<string, string>;
    // Upgrading from the first version: what it had seen counts as applied, so nothing flips back once more.
    let known: WorkflowLog | undefined;
    try {
      const raw = json(accountId, LEGACY_KNOWN);
      known = raw ? parseWorkflowLog(raw) : undefined;
    } catch {
      /* Start fresh. */
    }
    return Object.fromEntries(
      Object.entries(known?.entries ?? {}).map(([k, e]) => [k, `${e.at}:${e.device}`]),
    );
  };
  const clear = (accountId: string) => {
    for (const key of [EDITS, APPLIED, LEGACY_KNOWN, LEGACY_EDITED])
      memory.set(accountId, key, undefined);
  };
  /** Seal, dropping the oldest entries until the log fits what the host can store and every reader accepts. */
  const seal = (log: WorkflowLog, code: string, now: number) => {
    for (;;) {
      try {
        return { log, data: sealWorkflow(log, code) };
      } catch (error) {
        const count = Object.keys(log.entries).length;
        if (!(error instanceof WorkflowCryptoError && error.reason === 'size') || count < 2)
          throw error;
        log = compactLog(log, now, Math.floor(count / 2));
      }
    }
  };
  return {
    get enabled() {
      return vault.get('code') !== undefined;
    },
    /** Turn sync on with the code from another device, or a new code for the first device. */
    async enable(code?: string): Promise<string> {
      if (!vault.secure)
        throw new Error('Syncing between devices needs the Aplos Mail desktop app.');
      const value = code === undefined ? generateSyncCode() : normalizeSyncCode(code);
      await vault.set('code', value);
      return value;
    },
    code: () => vault.get('code'),
    hasEdits: (accountId: string) =>
      Object.keys(edits(accountId).items).length > 0 || !!memory.get(accountId, LEGACY_EDITED),
    async disable(accountIds: string[]) {
      await vault.delete('code');
      for (const id of accountIds) clear(id);
    },
    /**
     * Record the user's edits, given the threads as they are right after the edit. Synchronous and
     * memory-only so it is saved in the same transaction as the edit itself.
     */
    noteEdits(threads: Thread[]) {
      if (vault.get('code') === undefined) return;
      const at = options.now().getTime(),
        byAccount = new Map<string, Thread[]>();
      for (const t of threads)
        byAccount.set(t.accountId, [...(byAccount.get(t.accountId) ?? []), t]);
      for (const [accountId, list] of byAccount) {
        const state = edits(accountId);
        for (const t of list) {
          delete state.items[t.id];
          state.items[t.id] = workflowEdit(t, at, ++state.gen);
        }
        const ids = Object.keys(state.items);
        for (const id of ids.slice(0, Math.max(0, ids.length - MAX_EDITS))) delete state.items[id];
        memory.set(accountId, EDITS, JSON.stringify(state));
      }
    },
    /**
     * Read every copy of the account's synced log, merge them with this device's edits, write the result
     * back when it differs (replacing exactly the copies it merged), and return the patches the winning
     * entries imply for local threads. Apply the patches with no await in between: they are computed from
     * `threads()` after the last await. Memory is only written after that point too.
     */
    async round(
      account: Account,
      provider: MailProvider,
      threads: () => Thread[],
    ): Promise<WorkflowPatch[]> {
      const code = vault.get('code');
      if (!code || !provider.readAppData || !provider.writeAppData) return [];
      const scheme = keySchemeFor(account.provider),
        now = options.now().getTime(),
        started = edits(account.id),
        applied = appliedMap(account.id);
      const pending = Object.values(started.items),
        legacy = json(account.id, LEGACY_EDITED);
      if (Array.isArray(legacy)) {
        const ids = new Set(legacy);
        for (const t of threads())
          if (t.accountId === account.id && ids.has(t.id) && !started.items[t.id])
            pending.push(workflowEdit(t, now, -1));
      }
      const records = await provider.readAppData(account);
      const logs: WorkflowLog[] = [],
        merged: string[] = [],
        damaged: string[] = [];
      let unreadable = false;
      for (const record of records) {
        try {
          logs.push(openWorkflow(record.data, code));
          merged.push(record.id);
        } catch (error) {
          // Damaged copies are replaced; a different code or a newer format belongs to another device and stops the round; a copy too large to read is left alone.
          if (!(error instanceof WorkflowCryptoError)) throw error;
          if (error.reason === 'damaged') damaged.push(record.id);
          else if (error.reason === 'size') unreadable = true;
          else throw error;
        }
      }
      const mine = (list: Thread[]) => list.filter(t => t.accountId === account.id);
      const built = publishLog({
        remotes: logs,
        edits: pending,
        applied,
        threads: mine(threads()),
        seed: !logs.length && !unreadable,
        device: device!,
        now,
        scheme,
      });
      let log = built.log;
      const write =
        damaged.length > 0 ||
        (logs.length === 1
          ? !sameLog(log, logs[0])
          : logs.length > 1 || Object.keys(log.entries).length > 0);
      if (write) {
        const sealed = seal(log, code, now);
        log = sealed.log;
        await provider.writeAppData(account, sealed.data, [...merged, ...damaged]);
      }
      // Everything below runs without awaiting, so it sees edits made during the round and saves with the patches.
      if (vault.get('code') !== code) return [];
      const current = edits(account.id),
        skip = new Set<string>();
      let acked = 0;
      for (const [id, edit] of Object.entries(current.items)) {
        if (started.items[id]?.gen === edit.gen) {
          delete current.items[id];
          acked++;
        } else skip.add(id);
      }
      const result = applyLog(log, mine(threads()), applied, { scheme, skip, own: built.own }),
        marks = JSON.stringify(result.applied);
      if (acked) memory.set(account.id, EDITS, JSON.stringify(current));
      if (memory.get(account.id, APPLIED) !== marks) memory.set(account.id, APPLIED, marks);
      if (legacy !== undefined || memory.get(account.id, LEGACY_KNOWN) !== undefined) {
        memory.set(account.id, LEGACY_KNOWN, undefined);
        memory.set(account.id, LEGACY_EDITED, undefined);
      }
      return result.patches;
    },
  };
}
