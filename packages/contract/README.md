# @aplos/contract

The engine contract, v1: zod/mini schemas for every method, type and frame, the method registry, the generated allowlists
and OpenAPI document, and the typed client. It is platform-neutral (no Node, no Electron) and holds no behaviour beyond
validation. The design is ARCHITECTURE.md section 9; plan 10 section 4.1 and plan 30 section 8.1 list what it must serve.

## Layout

| Path | What |
|---|---|
| `src/schemas/*.ts` | Domain types: Session, Account, Folder, ThreadRow, Message, MessageBody, Draft, Submission, Event, Calendar, Plan, Settings, AI types, SetupStatus, admin types |
| `src/errors.ts`, `src/status.ts` | Error types and the error body, the classified-error record, the account status vocabulary, `ReasonCode` |
| `src/contract-error.ts` | `ContractError` and `NotImplementedError`, with no zod import, so the engine can throw them for free |
| `src/wire.ts` | The call and reply envelopes, `Hello`, and every push frame |
| `src/api/*.ts` | Every method, grouped by domain, each stamped with its owning area |
| `src/registry/` | `area()` and `desktop()`, the merged `methods` table, `parseArgs`, `checkResult` and the type helpers (`Input<M>`, `Output<M>`) |
| `src/access.ts` | `checkAccess`, `listenerCaller`, `requireScope`, `requireOriginating` and `principalOf`: the default-deny rules from the generated tables, no zod (`@aplos/contract/access`) |
| `src/rules.ts` | The send rules defined once (FR-2): the waiting submission states and the 5-minute overdue grace, no zod (`@aplos/contract/rules`) |
| `src/client/` | `createClient(session)` and `api.<type>.<verb>()`, `routeByHost`, the `EngineConnection` interface |
| `src/legacy-methods.ts` | Today's 66 method names (47 engine, 19 desktop) and where each capability lives in v1 |
| `GAPS.md` | How v1 answers every gap the UI threads raised before the freeze: closed, already there, or rejected with the reason |
| `generated/` | `methods.generated.ts` (plain string tables, no zod, for preload) and `openapi.json` (OpenAPI 3.1). Never edit by hand |

## Wire rules

Every schema follows ARCH 9.3, and `tests/wire-rules.test.ts` enforces it:

- Unions of objects are discriminated unions of named objects.
- No tuples, no `Date`, `Map`, `Set` or `BigInt`. Times are epoch milliseconds, and days are `YYYY-MM-DD` strings.
- No transforms, defaults or catches that change data. The engine lower-cases addresses; the schema does not.
- Binary data is `Bytes`, a `Uint8Array` that MessagePort transfers and HTTP sends as a blob route. Never base64.
- Outputs use open string enums (`openEnum`), so a newer engine can add a value. Inputs use closed enums (`choice`), so an
  older engine refuses what it cannot do.
- Every method input is an object. Inputs strip unknown fields rather than fail, so a newer client can talk to an older
  engine within v1.
- Validation messages are the sentences the UI shows. Today's validator wording (`service.ts`) carries over unchanged.

## Adding a method

1. Add it to the right file in `src/api/`, inside its area's `area('<area>', {...})` block. The name is `Type/verb`: a
   PascalCase type and a camelCase verb. Give it `input`, `output`, `kind` (`query` or `command`), `scope`, a one-line
   `summary`, and `secret`, `uiOnly`, `audit`, `scopeRule` or `windowOnlyArgs` where they apply (see
   `src/registry/define.ts`).
2. Commands take an `opId` and return a `Receipt`, or a row plus a receipt.
3. Run `npm run generate -w @aplos/contract`. This rewrites `generated/`, and the golden test fails until you do.
4. Add the handler to `packages/engine/src/methods/<area>.ts`. Its type demands the new entry. `methods/index.ts` does
   not change. A new area also needs its file, an entry in `engineAreas`, and an OWNERS.md line.
5. Run `npm test -w @aplos/contract`, `npm test -w @aplos/engine` and `npm run typecheck`.

## Scopes and transports

| Scope | Meaning |
|---|---|
| `read` | Reads, and harmless reads with effects (watching a window, prefetching, a manual sync) |
| `triage` | Reversible mailbox and calendar changes |
| `draft` | Drafts and uploads |
| `send` | Anything that sends mail or notifies other people: submissions, RSVPs, event edits with guests, unsubscribe |
| `ai` | Spends the AI budget and sends mail text to a provider |
| `admin` | Accounts, settings, consent, keys, the queue, diagnostics, the listener |
| `host` | Main's own control connection only: the protocol relay and the notification outbox |

ARCH 12.3 names `read`, `draft`, `send` and `admin`. `triage` and `ai` are added because neither fits those four without
over-granting.

The generated tables say who may call what:

- Preload allows `rendererMethods` and routes `desktopMethods` to main.
- The listener (socket, loopback HTTP) carries `listenerMethods`: engine methods that are not `secret`, `uiOnly` or `host`.
- The MCP adapter exposes `mcpMethods`: the `read` and `draft` scopes, minus anything audited, so nothing destructive
  (`Draft/destroy`) runs without the owner (ARCH 12.3 item 6).

A transport makes a listener's `Caller` only with `listenerCaller(client, transport)`, from the stored `Client` row the
token matched, never from `Hello`: `clientId` and `scopes` come from the row, and a `Client` of kind `mcp` is limited to
`mcpMethods` on the socket and HTTP too. `checkAccess` refuses a listener caller with no `clientId` or `via`.

Every dispatch denies by default with `checkAccess(method, caller, args)` from `@aplos/contract/access` (zod-free, so the
neutral engine can use it): the method's scope must be in `caller.scopes`; `host` methods need main's connection;
`uiOnly` and `secret` methods need a window or main; and a listener may not set a `windowOnlyArgs` path (`patch.ai` on
`Settings/set`, `aiAllowed` on `Account/set`). Two registry tags add a check the handler makes from its data, with
`requireScope`:

- `scopeRule: 'originating'` (`Operation/undo`, `Operation/retry`, `Queue/retry`, `Queue/discard`): the caller also needs
  the scope of the method that made the operation or item (`Operation.scope`, `QueueItem.scope`), so a triage tool cannot
  re-send mail or re-invite guests. It fails closed with `requireOriginating`: every operation records its scope, an
  engine that finds none uses the scope of the method that made it, and a listener is refused when that is unknown too.
  `Draft/destroy` of a draft with a live send also needs `send`, the scope that cancels a send.
- `scopeRule: 'guests'` (`Ask/decide`): accepting an event that invites anyone but the owner also needs `send`.

Blobs and frame tokens carry at least 128 random bits and belong to the principal that made them (`principalOf`: every
window and main are one, each listener client its own). Another caller's id answers `notFound`, on `Blob/get`,
`Blob/release`, `GET /v1/blob/:id`, `DraftAttachment.blobId` and `Ai/transcribe` alike. A blob attached to a draft with
a live send stays until that send settles (FR-7): `Blob/release` answers `stateMismatch` and a disconnect drops nothing,
so the bytes that leave are the ones the owner attached. "Use this account's mail for AI" bounds every AI call: a scope,
thread or draft naming an excluded account never widens it.

Over the socket the first frame is `Hello` with the client's `token`, answered by `HelloReply`. Over HTTP:

- `Authorization: Bearer <token>` on every request, compared in constant time with the stored hash; nothing else
  authenticates, and a token is never logged.
- `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`, else 421; an `Origin`, when present, must match an
  allowed origin exactly, else 403. No CORS headers are ever reflected.
- Every response is `Cache-Control: no-store`.

Transports validate every call with `parseArgs(method, args)` before `dispatch`. The neutral engine imports no zod, which
keeps it inside its 400,000-byte budget. Output schemas are checked with `checkResult` in tests and dev builds only.

Over HTTP, a call is `POST /v1/call/<Type>/<verb>` with the arguments as the body. A command's `opId` is the
`Idempotency-Key`. A success answers 200 with the result. A failure answers a non-2xx status with `{error}`. Frames
stream from `GET /v1/events` (SSE, `id: <seq>`). Blobs use `PUT /v1/blob` and `GET /v1/blob/:id`.

## The renderer

```ts
import { createClient, routeByHost } from '@aplos/contract/client';
const { api, subscribe } = createClient(routeByHost({ engine: enginePort, desktop: preloadInvoke }));
const receipt = await api.thread.act({ opId, ids, action: { type: 'done' } });
```

The client imports no zod at runtime. If the renderer also imports schemas, for example to validate a form or to pass
`validate: parseArgs`, it must call `configureZodForCsp()` once at startup. That sets `z.config({ jitless: true })`,
because the renderer's CSP forbids `eval`.

## Changing the contract after the freeze

The Integrator tags `contract-v1`. After that:

- Changes are additive within `v: 1`: new methods, new optional fields, new open-enum values.
- Each change is proposed with CONTRACT-CHANGE-PROPOSED in `plans/STATUS.md`.
- Only lane `eng-contract` edits this package. Each change lands as a small PR labelled `contract-change`, with the
  regenerated files.
- A breaking change bumps `v`. It is a conversation with the UI threads, not a quiet edit.

The OpenAPI golden test and the stand-in engine's conformance suite catch accidental breaks.
