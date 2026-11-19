import type { SqlStatement } from './sql';
import type { ChangeType } from './port';

/** What a store write function outside `commit.ts` gets from the running commit. Internal to the store. */
export interface WriteScope {
  readonly seq: number;
  readonly local: boolean;
  q(sql: string): SqlStatement;
  now(): number;
  /** Change row for `accountId:remoteId`, or for the account itself when `remoteId` is null. */
  mark(type: ChangeType, accountId: string, remoteId: string | null, op: 'u' | 'd'): void;
  /** Sync facts about an untracked item are dropped; a local edit of a missing item fails the commit. */
  missing(what: string): void;
}
