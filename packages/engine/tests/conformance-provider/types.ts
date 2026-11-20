/**
 * What a provider binding hands the conformance suite (`suite.ts`): the factory under test, and a handle on the fake
 * server it talks to. The handle speaks in the port's own words (remote ids, seen/flagged, inbox, trash), so the suite
 * never needs to know which provider is behind it.
 */
import type {
  AdapterAccount,
  BoundGovernor,
  Clock,
  ConnectContext,
  ProviderFactory,
} from '@aplos/engine/ports';

/** One message as the server holds it. */
export interface ServerMessage {
  remoteId: string;
  remoteThreadId: string;
  seen: boolean;
  flagged: boolean;
  inInbox: boolean;
  trashed: boolean;
}

export interface NewMail {
  subject: string;
  text: string;
  /** Remote id of the message this one answers: it joins that message's thread. */
  inReplyTo?: string;
}

/** Which calls a fault hits. */
export type FaultArea = 'sync' | 'open' | 'write' | 'send';

/**
 * - `throttle`: the server refuses with its rate-limit answer.
 * - `unavailable`: the server refuses with its temporary-failure answer.
 * - `lostAnswer`: the server does the work, and the answer never arrives.
 * - `notSent`: the connection fails before the server sees the request.
 */
export type FaultKind = 'throttle' | 'unavailable' | 'lostAnswer' | 'notSent';

/** Another mailbox on the same server, which the adapter must never touch. */
export interface OtherMailbox {
  address: string;
  deliver(mail: NewMail): ServerMessage;
  message(remoteId: string): ServerMessage | undefined;
}

export interface ConformanceServer {
  /** The mailbox the factory connects to. */
  readonly address: string;
  /** New unread mail in the inbox. */
  deliver(mail: NewMail): ServerMessage;
  setFlags(remoteId: string, flags: { seen?: boolean; flagged?: boolean }): void;
  /** Deletes a message for good, as another device would. */
  remove(remoteId: string): void;
  message(remoteId: string): ServerMessage | undefined;
  inbox(): ServerMessage[];
  /** Write requests (flag, move, trash) the server has carried out so far. */
  writes(): number;
  /** Copies of a sent message (by its Message-ID, angle brackets included) in the sent mail. */
  delivered(internetId: string): number;
  /** Arms one fault for the next matching request. */
  fail(area: FaultArea, kind: FaultKind): void;
  /** Mailbox addresses the server answered requests for. */
  touched(): string[];
  readonly other: OtherMailbox;
}

export interface ConformanceRig {
  factory: ProviderFactory;
  server: ConformanceServer;
  clock: Clock & { advance(ms: number): Promise<void> };
  /** The context `factory.connect` runs with. */
  connectContext(accountId: string): ConnectContext;
  /** The governor the adapter's calls go through, as the actor would bind it. */
  governor(account: AdapterAccount): BoundGovernor;
  close(): void | Promise<void>;
}

export interface RigOptions {
  /** Threads already in the inbox before connect. */
  threads: number;
}

export type MakeRig = (options: RigOptions) => Promise<ConformanceRig>;
