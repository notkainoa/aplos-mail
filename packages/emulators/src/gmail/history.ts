import type { Clock } from '../kit/clock';
import type { Random } from './rng';

/**
 * Gmail's change log. History ids increase but are not contiguous: each change steps the id by
 * a seeded 1 to 7, so a client that assumes "next id = previous + 1" fails here as it would live.
 */
export interface HistoryRef {
  id: string;
  threadId: string;
}

export interface HistoryMessage extends HistoryRef {
  labelIds?: string[];
}

export interface HistoryRecord {
  id: string;
  messages: HistoryRef[];
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage; labelIds: string[] }[];
  labelsRemoved?: { message: HistoryMessage; labelIds: string[] }[];
}

export type HistoryType = 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';
export const HISTORY_TYPES: readonly HistoryType[] = [
  'messageAdded',
  'messageDeleted',
  'labelAdded',
  'labelRemoved',
];

const TYPE_FIELD: Record<
  HistoryType,
  'messagesAdded' | 'messagesDeleted' | 'labelsAdded' | 'labelsRemoved'
> = {
  messageAdded: 'messagesAdded',
  messageDeleted: 'messagesDeleted',
  labelAdded: 'labelsAdded',
  labelRemoved: 'labelsRemoved',
};

interface Stored {
  record: HistoryRecord;
  num: number;
  at: number;
}

export interface HistoryQuery {
  startHistoryId: number;
  types: HistoryType[];
  labelId?: string;
  maxResults: number;
  pageToken?: string;
}

export type HistoryResult =
  | { expired: true }
  | { expired: false; records: HistoryRecord[]; nextPageToken?: string; historyId: string };

export class HistoryLog {
  private stored: Stored[] = [];
  /** When each id was handed out, so a cursor's age can be judged. */
  private issued: { num: number; at: number }[] = [];
  private current: number;
  /** Ids at or below this are gone (forced by `expire`). */
  private purgedThrough = 0;

  constructor(
    private readonly clock: Clock,
    private readonly random: Random,
    private readonly retention: number | (() => number),
  ) {
    this.current = 1_000_000 + random.int(0, 8_000_000);
    this.issued.push({ num: this.current, at: clock.now() });
  }

  get currentId(): number {
    return this.current;
  }

  /** Moves the id forward by a seeded 1 to 7 and returns it. */
  step(): number {
    this.current += this.random.int(1, 7);
    this.issued.push({ num: this.current, at: this.clock.now() });
    return this.current;
  }

  append(parts: Omit<HistoryRecord, 'id'>): HistoryRecord {
    const num = this.step();
    const record: HistoryRecord = { id: String(num), ...parts };
    this.stored.push({ record, num, at: this.clock.now() });
    return record;
  }

  /** Drops all records, e.g. after generating the starting mailbox. */
  clear(): void {
    this.stored = [];
    this.issued = [];
    this.step();
  }

  /** Makes every cursor handed out so far answer 404, as when Google's retention window passes. */
  expire(): void {
    this.purgedThrough = this.current;
    this.stored = [];
    this.step();
  }

  query(q: HistoryQuery): HistoryResult {
    if (q.startHistoryId > this.current) return { expired: true };
    if (q.startHistoryId <= this.purgedThrough) return { expired: true };
    // A cursor that is older than the retention horizon and has changes after it is stale. A cursor
    // equal to the current id stays valid however long the mailbox has been quiet.
    const retentionMs = typeof this.retention === 'function' ? this.retention() : this.retention;
    const horizon = this.clock.now() - retentionMs;
    if (q.startHistoryId < this.current && this.issuedAt(q.startHistoryId) < horizon)
      return { expired: true };

    const after = q.pageToken
      ? Number(Buffer.from(q.pageToken, 'base64url').toString())
      : q.startHistoryId;
    const matching = this.stored
      .filter(s => s.num > after && s.at >= horizon)
      .map(s => this.project(s.record, q))
      .filter((r): r is HistoryRecord => r !== undefined);
    const page = matching.slice(0, q.maxResults);
    const more = matching.length > q.maxResults;
    return {
      expired: false,
      records: page,
      nextPageToken: more ? Buffer.from(page[page.length - 1].id).toString('base64url') : undefined,
      historyId: String(this.current),
    };
  }

  /** When the newest id at or below `num` was handed out (-Infinity if `num` predates the log). */
  private issuedAt(num: number): number {
    const mark = [...this.issued].reverse().find(m => m.num <= num);
    return mark ? mark.at : -Infinity;
  }

  /** Applies the historyTypes and labelId filters to one record; undefined means "leave it out". */
  private project(record: HistoryRecord, q: HistoryQuery): HistoryRecord | undefined {
    const wantedFields = q.types.length
      ? q.types.map(t => TYPE_FIELD[t])
      : Object.values(TYPE_FIELD);
    const out: HistoryRecord = { id: record.id, messages: record.messages };
    let kept = false;
    for (const field of wantedFields) {
      const entries = record[field];
      if (!entries?.length) continue;
      const filtered = q.labelId ? entries.filter(e => this.touchesLabel(e, q.labelId!)) : entries;
      if (!filtered.length) continue;
      (out as unknown as Record<string, unknown>)[field] = filtered;
      kept = true;
    }
    return kept ? out : undefined;
  }

  private touchesLabel(
    entry: { message: HistoryMessage; labelIds?: string[] },
    labelId: string,
  ): boolean {
    return (
      (entry.labelIds ?? []).includes(labelId) || (entry.message.labelIds ?? []).includes(labelId)
    );
  }
}
