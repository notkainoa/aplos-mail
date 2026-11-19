import type { EngineConnection, EngineSession } from '../../src/client/index';
import type { Caller } from '../../src/access';

/**
 * What an engine hands the conformance suite. Only contract-level abilities: the suite never reaches into an engine's
 * internals, so the stand-in and the real engine are held to the same assertions (plan 10 section 4.1).
 */
export interface EngineUnderTest {
  /** An engine holding the demo data (`Demo/load` on a fresh store is fine) and nothing sending. */
  connection: EngineConnection;
  /** Let `ms` of engine time pass: a fake clock advances, a real engine sleeps. Frames due by then have arrived when it resolves. */
  advance(ms: number): Promise<void>;
  /** Raise the change-log floor to the current state (compaction). Tests that need it are skipped without it. */
  compactLog?(): Promise<void>;
  /** Void every window, as after a restore, a restart or another `dbEpoch`. Tests that need it are skipped without it. */
  reset?(reason: 'dbEpoch' | 'restore' | 'restart'): Promise<void>;
  /** Force where a command's frames land relative to its reply. Without it, the engine's natural order is tested. */
  orderings?: { modes: readonly OrderingMode[]; set(mode: OrderingMode): Promise<void> };
  /** A session as another caller, e.g. a listener client holding some scopes. The access tests are skipped without it. */
  connectAs?(caller: Caller): EngineSession;
  /** The Mac sleeps for `ms`: no timer fires on the way, then due work runs late at wake. The overdue test needs it. */
  sleep?(ms: number): Promise<void>;
  /** The stand-in engine, the only one allowed to answer `MailFrame.srcdoc` (freeze FR-34). */
  standIn?: boolean;
  close?(): Promise<void>;
}
export type OrderingMode = 'receiptFirst' | 'frameFirst' | 'together';

export interface ConformanceTarget {
  /** Names the run and its expected-fail list: `expected-fail.<name>.json` next to the suite. */
  name: string;
  /** A fresh engine for each test group. */
  create(): Promise<EngineUnderTest>;
}
