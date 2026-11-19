import { createHash } from 'node:crypto';
import type { ProviderMemory } from '@aplos/engine/legacy/provider';

/** Folders Aplos syncs, by role rather than by the host's name for them. */
export type Role = 'inbox' | 'archive' | 'sent' | 'trash' | 'junk';
/** One copy of a message in one folder. The same Message-ID can have copies in several folders. */
export interface MessageRecord {
  /** Normalized Message-ID (no angle brackets), or a synthesized `${role}:${uidValidity}:${uid}`. */
  id: string;
  f: Role;
  v: string;
  u: number;
  seen: boolean;
  flagged: boolean;
  /** Written by the account owner (in Sent, or from the account address outside the inbox). */
  out: boolean;
  /** ISO date, for ordering. */
  d: string;
  /** Size in octets, so large messages are read part by part. */
  z: number;
}
interface ThreadRecord {
  n: number;
  m: MessageRecord[];
}
/** A thread merged into another keeps a pointer so references to its key still resolve. */
interface Tombstone {
  a: string;
}
interface FolderRecord {
  v: string;
  u: Record<string, string>;
}

export interface IndexChanges {
  /** Threads whose set of messages changed, or that are new. */
  changed: string[];
  /** Threads with the same messages but different flags or folders. */
  touched: string[];
  /** Threads that existed before and have no messages left, or were merged into another. */
  removed: string[];
}

export const normalizeId = (value: string | undefined) =>
  value?.trim().replace(/^<|>$/g, '').trim() || undefined;
export function referenceIds(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(' ') : (value ?? '');
  return [...text.matchAll(/<([^<>\s]+)>/g)]
    .map(m => m[1])
    .concat(text.includes('<') ? [] : text.split(/\s+/).filter(Boolean));
}
const mids = (records: MessageRecord[]) => [...new Set(records.map(r => r.id))].sort().join('\n');

/**
 * Thread and UID index for one account, kept in provider memory.
 *
 * Keys: `ids:<message-id>` → thread key (also for referenced messages not seen yet, so they join on arrival),
 * `t:<key>` → thread record or tombstone, `f:<role>` → UID → message-id map for the folder, `seq` → counter
 * that orders threads by age, `p` → threads changed outside sync that the next sync must report.
 * Writes are buffered until `flush()`, so a failed operation leaves memory as it was.
 */
export function createIndex(memory: ProviderMemory, accountId: string) {
  const cache = new Map<string, string | undefined>(),
    dirty = new Set<string>();
  const before = new Map<string, string | null>(),
    merged = new Set<string>();
  const read = <T>(key: string): T | undefined => {
    if (!cache.has(key)) cache.set(key, memory.get(accountId, key));
    const raw = cache.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  };
  const write = (key: string, value: unknown) => {
    cache.set(key, value === undefined ? undefined : JSON.stringify(value));
    dirty.add(key);
  };
  function resolve(key: string): string {
    for (let i = 0; i < 50; i++) {
      const record = read<ThreadRecord | Tombstone>(`t:${key}`);
      if (!record || !('a' in record)) return key;
      key = record.a;
    }
    return key;
  }
  const thread = (key: string) => {
    const record = read<ThreadRecord | Tombstone>(`t:${key}`);
    return record && 'm' in record ? record : undefined;
  };
  function snapshot(key: string) {
    if (!before.has(key)) {
      const record = thread(key);
      before.set(key, record ? mids(record.m) : null);
    }
  }
  function save(key: string, record: ThreadRecord) {
    write(`t:${key}`, record.m.length ? record : undefined);
  }
  function folderMap(role: Role, v: string, uid: number, id: string | undefined) {
    const folder = read<FolderRecord>(`f:${role}`);
    if (!folder || folder.v !== v) return;
    if (id === undefined) delete folder.u[uid];
    else folder.u[uid] = id;
    write(`f:${role}`, folder);
  }
  function freshKey(id: string): string {
    for (let i = 0; ; i++) {
      const key = createHash('sha256')
        .update(i ? `${id}#${i}` : id)
        .digest('base64url')
        .slice(0, 16);
      if (!read(`t:${key}`)) return key;
    }
  }
  function nextSeq() {
    const n = Number(read<number>('seq') ?? 0) + 1;
    write('seq', n);
    return n;
  }
  function diff(): IndexChanges {
    const result: IndexChanges = { changed: [], touched: [], removed: [] };
    for (const [key, old] of before) {
      if (merged.has(key)) {
        if (old !== null) result.removed.push(key);
        continue;
      }
      const record = thread(key);
      if (!record?.m.length) {
        if (old !== null) result.removed.push(key);
        continue;
      }
      (old === mids(record.m) ? result.touched : result.changed).push(key);
    }
    return result;
  }
  return {
    /** The live thread key for a message-id, following merges. */
    keyOf(id: string): string | undefined {
      const key = read<string>(`ids:${id}`);
      return key ? resolve(key) : undefined;
    },
    records(key: string): MessageRecord[] {
      return [...(thread(resolve(key))?.m ?? [])];
    },
    folder: (role: Role) => read<FolderRecord>(`f:${role}`),
    /** Start tracking a folder afresh (new UIDVALIDITY), or stop tracking it: every copy indexed under the old one is dropped. */
    resetFolder(role: Role, v: string | undefined) {
      const old = read<FolderRecord>(`f:${role}`);
      if (old)
        for (const [uid, id] of Object.entries(old.u)) this.drop(role, old.v, Number(uid), id);
      write(`f:${role}`, v === undefined ? undefined : { v, u: {} });
    },
    /** Report a thread as changed-or-touched even though nothing in the index moved. */
    touch(key: string) {
      snapshot(resolve(key));
    },
    /**
     * Which thread a message joins: the oldest thread any of its IDs or references already belongs to.
     * `references` lists References (root first) then In-Reply-To. A new thread's key comes from the root
     * it names, so an index rebuilt in another order (say, after the root moved folders) gives the same key.
     */
    link(id: string, references: string[]): string {
      const related = [...new Set([id, ...references])];
      const keys = [...new Set(related.map(x => this.keyOf(x)).filter((k): k is string => !!k))];
      let key: string;
      if (!keys.length) {
        key = freshKey(references[0] ?? id);
        snapshot(key);
        write(`t:${key}`, { n: nextSeq(), m: [] });
      } else {
        // Keys reserved by references alone have no record yet; they count as the newest.
        const age = (k: string) => thread(k)?.n ?? Number.MAX_SAFE_INTEGER;
        keys.sort((a, b) => age(a) - age(b));
        key = keys[0];
        snapshot(key);
        if (!thread(key)) write(`t:${key}`, { n: nextSeq(), m: [] });
        const target = thread(key)!;
        for (const other of keys.slice(1)) {
          snapshot(other);
          const absorbed = thread(other);
          if (absorbed) target.m.push(...absorbed.m);
          write(`t:${other}`, { a: key } satisfies Tombstone);
          merged.add(other);
        }
        save(key, target);
      }
      for (const x of related) if (read<string>(`ids:${x}`) !== key) write(`ids:${x}`, key);
      return key;
    },
    /** Add or replace the copy at (role, uidValidity, uid). */
    put(key: string, record: MessageRecord) {
      key = resolve(key);
      snapshot(key);
      const target = thread(key) ?? { n: nextSeq(), m: [] };
      target.m = target.m.filter(r => !(r.f === record.f && r.v === record.v && r.u === record.u));
      target.m.push(record);
      save(key, target);
      folderMap(record.f, record.v, record.u, record.id);
      if (read<string>(`ids:${record.id}`) === undefined) write(`ids:${record.id}`, key);
    },
    /** Update flags of a known copy without counting it as a change of messages. */
    update(key: string, record: MessageRecord, patch: Partial<MessageRecord>) {
      key = resolve(key);
      const target = thread(key);
      if (!target) return;
      snapshot(key);
      const at = target.m.findIndex(r => r.f === record.f && r.v === record.v && r.u === record.u);
      if (at < 0) return;
      const next = { ...target.m[at], ...patch };
      if (next.f !== record.f || next.u !== record.u || next.v !== record.v) {
        folderMap(record.f, record.v, record.u, undefined);
        folderMap(next.f, next.v, next.u, next.id);
      }
      target.m[at] = next;
      save(key, target);
    },
    /** Forget one copy. Returns the thread it belonged to. */
    drop(role: Role, v: string, uid: number, id?: string): string | undefined {
      folderMap(role, v, uid, undefined);
      const key = id ? this.keyOf(id) : undefined;
      if (!key) return;
      const target = thread(key);
      if (!target) return key;
      snapshot(key);
      target.m = target.m.filter(r => !(r.f === role && r.v === v && r.u === uid));
      save(key, target);
      return key;
    },
    /** Make sure the folder map exists for a UIDVALIDITY, e.g. after creating or first moving into a folder. */
    trackFolder(role: Role, v: string) {
      const folder = read<FolderRecord>(`f:${role}`);
      if (!folder || folder.v !== v) this.resetFolder(role, v);
    },
    /** What changed since this index was opened, plus threads deferred by earlier operations (which are then cleared). */
    changes(): IndexChanges {
      const result = diff(),
        pending = read<string[]>('p') ?? [];
      if (!pending.length) return result;
      const changed = new Set(result.changed),
        removed = new Set(result.removed);
      for (const key of pending) {
        const live = resolve(key);
        if (live !== key) removed.add(key);
        if (thread(live)?.m.length) changed.add(live);
        else removed.add(live);
      }
      for (const key of changed) removed.delete(key);
      write('p', undefined);
      return {
        changed: [...changed],
        touched: result.touched.filter(k => !changed.has(k) && !removed.has(k)),
        removed: [...removed],
      };
    },
    /**
     * Outside sync: remember threads whose messages changed (a copy vanished, threads merged) so the next sync
     * reports them. Threads this operation created are left out; the operation itself returns them.
     */
    defer() {
      const c = diff(),
        keys = [...c.changed.filter(k => before.get(k) !== null), ...c.removed];
      if (keys.length) write('p', [...new Set([...(read<string[]>('p') ?? []), ...keys])]);
    },
    /** Persist buffered writes. */
    flush() {
      for (const key of dirty) memory.set(accountId, key, cache.get(key));
      dirty.clear();
    },
  };
}
export type ImapIndex = ReturnType<typeof createIndex>;
