import type * as z from 'zod/mini';
import type { Scope } from '../schemas/session';

/**
 * The owning area of every engine method: one `packages/engine/src/methods/<area>.ts` file each, filled by one lane
 * (F5). `blob`, `sender`, `data` and `workflow` were added to the plan's list in contract v1.
 */
export const engineAreas = [
  'session',
  'settings',
  'view',
  'thread',
  'operation',
  'submission',
  'draft',
  'outbox',
  'later',
  'reminder',
  'notification',
  'ai',
  'ask',
  'setup',
  'demo',
  'consent',
  'queue',
  'mail',
  'diagnostics',
  'listener',
  'clients',
  'account',
  'sync',
  'unsubscribe',
  'event',
  'blob',
  'sender',
  'data',
  'workflow',
] as const;
/** Desktop methods live in main (`main/native-methods.ts` after restructure step 3), never in the engine. */
export const desktopAreas = ['native'] as const;
export type EngineArea = (typeof engineAreas)[number];
export type DesktopArea = (typeof desktopAreas)[number];
export type Area = EngineArea | DesktopArea;
export type Host = 'engine' | 'desktop';
/** Queries change nothing durable; commands change state and return a receipt or the changed row. */
export type Kind = 'query' | 'command';

type Schema = z.ZodMiniType;

/** What an area file writes for each method. */
export interface MethodSpec<I extends Schema = Schema, O extends Schema = Schema> {
  input: I;
  output: O;
  kind: Kind;
  /** The listener scope a non-UI client needs (ARCH 12.3). `host` methods are for main's control connection only. */
  scope: Scope;
  /** One line for OpenAPI and the method list. */
  summary: string;
  /** Arguments carry a secret (an AI key, a password, a pairing code): never logged, never echoed, Electron windows only. */
  secret?: true;
  /** Only Electron windows may call it, never the socket, HTTP or MCP (listener and client management, content export). */
  uiOnly?: true;
  /** A call from a non-UI client writes an `audit_log` row (sends, deletes, settings changes). */
  audit?: true;
  /**
   * A check the handler makes from the data it acts on, after the method's own scope (freeze FR-3, FR-4). Scopes are a
   * set, not a hierarchy, so a cheap scope must never reach an effect a dearer one guards:
   * - `originating`: the call acts on an operation, queue item or submission another method created. The caller's scopes
   *   must also include that method's scope (`Operation.scope`, `QueueItem.scope`; `send` for submissions, so also for
   *   `Draft/destroy` of a draft with a live send, R2B-2), else `forbidden`. `requireOriginating` in
   *   `@aplos/contract/access` makes the check, failing closed when the scope is unknown (R2B-1).
   * - `guests`: what the call creates would invite or email someone other than the owner (an event with a non-self
   *   attendee). The caller's scopes must also include `send`, else `forbidden`.
   */
  scopeRule?: 'originating' | 'guests';
  /**
   * Argument paths only Electron windows and main may set (FR-5): a listener call whose arguments hold any of them
   * answers `forbidden`, whatever its scopes. Dot paths from the input root, e.g. `patch.ai`. `checkAccess` applies them.
   */
  windowOnlyArgs?: readonly string[];
}

/** A registered method: its spec plus the host and area the registry stamps on it. */
export type MethodDef<
  A extends Area = Area,
  H extends Host = Host,
  I extends Schema = Schema,
  O extends Schema = Schema,
> = MethodSpec<I, O> & { area: A; host: H };

type MethodName = `${string}/${string}`;
type Stamped<M, A extends Area, H extends Host> = { [K in keyof M]: M[K] & { area: A; host: H } };

function stamp<M extends Record<string, MethodSpec>, A extends Area, H extends Host>(
  area: A,
  host: H,
  methods: M,
): Stamped<M, A, H> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(methods)) {
    if (!/^[A-Z][A-Za-z]*\/[a-z][A-Za-z]*$/.test(name))
      throw new Error(`Method name ${name} is not Type/verb.`);
    out[name] = { ...spec, area, host };
  }
  return out as Stamped<M, A, H>;
}

/** Declares one engine area's methods. Names are `Type/verb`: a PascalCase type and a camelCase verb. */
export function area<A extends EngineArea, M extends Record<MethodName, MethodSpec>>(
  name: A,
  methods: M,
) {
  return stamp(name, 'engine', methods);
}

/** Declares main's native methods (`window.*`, `file.*`, `system.*`, `update.*` today). Always UI-only. */
export function desktop<M extends Record<MethodName, MethodSpec>>(methods: M) {
  return stamp('native', 'desktop', methods);
}
