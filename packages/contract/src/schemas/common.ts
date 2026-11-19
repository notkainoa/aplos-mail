import * as z from 'zod/mini';

/**
 * Building blocks every schema shares. The wire rules (ARCH 9.3): discriminated unions of named objects, no tuples,
 * no `Date`/`Map`/`Set`/`BigInt` (times are epoch-ms numbers, days are `YYYY-MM-DD` strings), no transforms or defaults
 * that change data, and open string enums for anything a newer engine may extend. The human sentences below are today's
 * validator wording (`service.ts`), so UI-visible text does not change.
 */
export const messages = {
  text: 'Invalid text or text is too long.',
  option: 'Invalid option.',
  checkbox: 'Invalid checkbox value.',
  object: 'Expected an object.',
  number: 'Enter a valid number.',
  date: 'Enter a valid date.',
  dueDate: 'Enter a valid due date.',
  email: 'Enter a valid email address.',
  serverAddress: 'Enter the server address, e.g. http://localhost:11434/v1.',
  plainAddress: 'Use an http or https address without a password in it.',
  bareAddress: 'Use the server address only, without ? or # parts.',
} as const;

type Open<T extends string> = T | (string & {});

/**
 * An open string enum: the known values document the vocabulary and type-hint callers, and any string is accepted so a
 * newer engine can add one (ARCH 9.3). Use it for outputs; inputs a method must understand use a closed `z.enum`.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([z.enum(values), z.string()]) as unknown as z.ZodMiniType<
    Open<T[number]>,
    Open<T[number]>
  >;
}

/** A closed enum with today's "Invalid option." sentence. */
export function choice<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: messages.option });
}

export const bool = () => z.boolean({ error: messages.checkbox });

/** Bounded text. Every free-text field has a ceiling so a hostile caller cannot hand the engine a 1 GB string. */
export const text = (max: number) =>
  z.string({ error: messages.text }).check(z.maxLength(max, messages.text));
/** Single-line text: no CR or LF, for names and header-bound values. */
export const line = (max: number) => text(max).check(z.regex(/^[^\r\n]*$/, messages.text));

/** An opaque contract id (`accountId:remoteId` for threads, ARCH 3.1). Never parse one. */
export const Id = text(1_000).check(z.minLength(1, messages.text));
export const Ids = (max = 1_000) => z.array(Id).check(z.maxLength(max, messages.text));

/** A client-made operation id, also the HTTP `Idempotency-Key`; replaying it never applies twice. */
export const OpId = text(200).check(z.minLength(1, messages.text));

/** Epoch milliseconds. */
export const EpochMs = z.int({ error: messages.date }).check(z.nonnegative(messages.date));
export const DurationMs = z.int({ error: messages.number }).check(z.nonnegative(messages.number));
export const Count = z.int({ error: messages.number }).check(z.nonnegative(messages.number));

const isDay = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
/** A calendar day with no time zone, `YYYY-MM-DD` (due dates, all-day events). */
export const LocalDate = z
  .string({ error: messages.dueDate })
  .check(z.refine(isDay, messages.dueDate));

/** An IANA time zone name such as `America/Los_Angeles`. */
export const TimeZone = line(100);

const isEmail = (v: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
/** An email address as typed; the engine lower-cases it (no transforms on the wire). */
export const Email = z
  .string({ error: messages.email })
  .check(z.maxLength(320, messages.email), z.refine(isEmail, messages.email));
export const Address = z.object({ address: Email, name: z.optional(line(200)) });
export type Address = z.infer<typeof Address>;
/** A sender match for rules and the image allow-list: a full address or `@domain`. */
export const SenderMatch = z.string({ error: messages.email }).check(
  z.maxLength(320, messages.email),
  z.refine(v => isEmail(v) || /^@[^\s@<>]+\.[^\s@<>]+$/.test(v), messages.email),
);

const parsesAsUrl = (v: string) => {
  if (!v.trim()) return true;
  try {
    new URL(v.trim());
    return true;
  } catch {
    return false;
  }
};
const isPlainHttp = (v: string) => {
  if (!v.trim()) return true;
  try {
    const u = new URL(v.trim());
    return /^https?:$/.test(u.protocol) && !u.username && !u.password;
  } catch {
    return true;
  }
};
/** No `?query` or `#fragment`, where a key could hide and be echoed back by `Settings/get` (FR-36). */
const isBareAddress = (v: string) => !/[?#]/.test(v.trim());
/** An http(s) server address with no credentials, query or fragment in it; empty means "use the default". */
export const HttpAddress = text(500).check(
  z.refine(parsesAsUrl, messages.serverAddress),
  z.refine(isPlainHttp, messages.plainAddress),
  z.refine(isBareAddress, messages.bareAddress),
);

const isHttps = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
};
export const HttpsUrl = text(2_000).check(z.refine(isHttps, 'Use an https address.'));

/**
 * Binary data: a `Uint8Array` that MessagePort transports transfer and HTTP carries as a blob route, never base64
 * (ARCH 9.4). The schema walker and the OpenAPI writer recognise this one instance.
 */
export const Bytes = z.instanceof(Uint8Array);

/**
 * A state token: the change-log position `{dbEpoch, seq}` (ARCH 3.5). Compare `seq` only within one `dbEpoch`; a
 * different epoch means the database was reset or restored and the client re-opens its windows. `sig` is the HMAC
 * network clients receive; Electron windows never see one.
 */
export const State = z.object({ dbEpoch: line(100), seq: Count, sig: z.optional(line(200)) });
export type State = z.infer<typeof State>;

/** What every command returns: drop the optimistic overlay once a window reaches `appliedState` (ARCH 9.2). */
export const Receipt = z.object({
  opId: OpId,
  appliedState: State,
  /**
   * Until when `Operation/undo` cancels a held change instead of sending an inverse: calendar writes that email guests,
   * and a send in its undo window or waiting to send later (freeze FR-14). Meaningful only with `undoable` true; after it,
   * undoing a send answers `conflict`.
   */
  undoUntil: z.optional(EpochMs),
  /** False for changes with no inverse (a disconnect, a draft save). A send's receipt is undoable while it is held. */
  undoable: z.optional(z.boolean()),
});
export type Receipt = z.infer<typeof Receipt>;

/** `T/get` for row types: unknown ids come back in `notFound` instead of failing the call (JMAP). */
export const GetInput = z.object({ ids: Ids(500) });
export function getResult<T extends z.ZodMiniType>(row: T) {
  return z.object({ state: State, list: z.array(row), notFound: z.array(z.string()) });
}

export const Empty = z.object({});
export const Ok = z.object({ ok: z.literal(true) });

/**
 * A provider or AI failure reduced to what the UI may show: a copy key and, when useful, the sentence. `message` is
 * engine copy chosen by `reasonCode`, never the provider's own text, which can echo part of a key (FR-33); the
 * provider's words go only to `ClassifiedError.providerMessage`, redacted, for diagnostics.
 */
export const Problem = z.object({
  reasonCode: z.string(),
  message: z.optional(text(1_000)),
  at: z.optional(EpochMs),
  /** A pause: when the engine asks again (`paused`, and a run that skipped accounts cooling down). */
  resumeAt: z.optional(EpochMs),
});
