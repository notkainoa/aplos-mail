import type { DeviceId } from '@aplos/engine/ports';

/**
 * The workflow channel's data model and merge (DECISIONS M29, ARCH 13.1): last writer wins per key, ordered by a hybrid
 * logical clock. A stamp is `{at, gen, device}`: `at` is the writer's wall clock raised to the highest stamp it had seen,
 * `gen` counts writes within one `at`, and equal `at` and `gen` go to the lower device id (plan 20 PV3 "tie-break edit
 * time by device id"). Two records with identical stamps (only a buggy or hostile key holder makes them) are ordered by
 * their canonical JSON, so the merge is a total order: commutative, associative and idempotent, and the result never
 * depends on the order copies were fetched in (D17: a stale or duplicate copy can never shadow a newer one).
 */

export interface Stamp {
  at: number;
  gen: number;
  device: DeviceId;
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowRecord {
  /** `thread:<remote thread id>` for thread workflow; `lease` / `lease:<device>` for the lease (prov-gov). */
  key: string;
  stamp: Stamp;
  value: JsonValue;
}

/** The plaintext of one sealed copy: the writer's whole merged view when it wrote. */
export interface WorkflowPayload {
  v: 2;
  device: DeviceId;
  writtenAt: number;
  records: WorkflowRecord[];
}

export const MAX_RECORDS = 50_000;
const MAX_KEY = 300;
const DEVICE_RE = /^[\w.-]{1,128}$/;

export const isDeviceId = (value: unknown): value is DeviceId =>
  typeof value === 'string' && DEVICE_RE.test(value);

/** Sorted-key JSON, the tie-break of last resort and the basis of op ids. */
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Positive when `a` is the later stamp. */
export function compareStamp(a: Stamp, b: Stamp): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.gen !== b.gen) return a.gen - b.gen;
  if (a.device === b.device) return 0;
  return a.device < b.device ? 1 : -1;
}

/** Positive when `a` wins over `b`. */
export function compareRecord(a: WorkflowRecord, b: WorkflowRecord): number {
  const byStamp = compareStamp(a.stamp, b.stamp);
  if (byStamp !== 0) return byStamp;
  const x = canonical(a.value);
  const y = canonical(b.value);
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

/** Folds `records` into `view` in place; returns the records that became winners. */
export function mergeInto(
  view: Map<string, WorkflowRecord>,
  records: readonly WorkflowRecord[],
): WorkflowRecord[] {
  const changed = new Map<string, WorkflowRecord>();
  for (const record of records) {
    const held = view.get(record.key);
    if (held && compareRecord(record, held) <= 0) continue;
    view.set(record.key, record);
    changed.set(record.key, record);
  }
  return [...changed.values()];
}

/** The highest `{at, gen}` in `records`, the clock floor for the next write. */
export function highWater(records: Iterable<WorkflowRecord>, floor: Stamp): Stamp {
  let high = floor;
  for (const r of records) if (compareStamp(r.stamp, high) > 0) high = r.stamp;
  return high;
}

/** The next stamp this device writes: never below anything it has seen, whatever its wall clock says. */
export function nextStamp(high: Stamp, now: number, device: DeviceId): Stamp {
  const at = Math.max(Math.floor(now), high.at);
  return { at, gen: at === high.at ? high.gen + 1 : 0, device };
}

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseStamp(raw: unknown): Stamp | undefined {
  const s = raw as Partial<Stamp> | null;
  if (!s || typeof s !== 'object') return undefined;
  if (!isCount(s.at) || !isCount(s.gen) || !isDeviceId(s.device)) return undefined;
  return { at: s.at, gen: s.gen, device: s.device };
}

function parseRecord(raw: unknown): WorkflowRecord | undefined {
  const r = raw as Partial<WorkflowRecord> | null;
  if (!r || typeof r !== 'object') return undefined;
  if (typeof r.key !== 'string' || r.key.length === 0 || r.key.length > MAX_KEY) return undefined;
  const stamp = parseStamp(r.stamp);
  if (!stamp || r.value === undefined) return undefined;
  return { key: r.key, stamp, value: r.value };
}

/**
 * Validates an opened payload. Any malformed record rejects the whole copy: it was authenticated, so a bad record means
 * a newer format or a broken writer, and taking half of it would merge a view its writer never had.
 */
export function parsePayload(raw: unknown): WorkflowPayload | undefined {
  const p = raw as Partial<WorkflowPayload> | null;
  if (!p || typeof p !== 'object' || p.v !== 2) return undefined;
  if (!isDeviceId(p.device) || !isCount(p.writtenAt) || !Array.isArray(p.records)) return undefined;
  if (p.records.length > MAX_RECORDS) return undefined;
  const records: WorkflowRecord[] = [];
  for (const item of p.records) {
    const record = parseRecord(item);
    if (!record) return undefined;
    records.push(record);
  }
  return { v: 2, device: p.device, writtenAt: p.writtenAt, records };
}

/** True when every record of `copy` is matched or beaten in `view`: dropping the copy loses nothing. */
export function dominated(
  copy: readonly WorkflowRecord[],
  view: ReadonlyMap<string, WorkflowRecord>,
): boolean {
  return copy.every(r => {
    const held = view.get(r.key);
    return held !== undefined && compareRecord(held, r) >= 0;
  });
}
