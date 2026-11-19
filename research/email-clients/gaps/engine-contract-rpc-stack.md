# Engine contract and RPC stack: JMAP envelope vs resource REST, schema and codegen tooling

2026-10-25. This is a gap report under `research/email-clients/SYNTH-architecture.md` (§6, §11 F3/F4, and "Decisions that don't depend on topology"). It does not repeat that synthesis.

**Evidence labels.**
- **[V]**: I read the code or document myself. The path or URL is given.
- **[M]**: I measured it myself with my own script.
- **[C]**: the project's own claim, which I did not check.
- **[I]**: my inference.

**Method.** Clones are in `/Users/knewton/.t3/aplos-research/src/<name>`. I only read files there: nothing was installed, built or run. Package sizes come from bundlephobia's public API. They are whole-package numbers, so read them as upper bounds. Aplos paths are relative to `apps/desktop/` at `72095ff`.

**Licences.** No code from these projects goes into Aplos; only ideas.

| Project | Licence |
|---|---|
| Stalwart | AGPL-3.0-only OR SEL |
| Delta Chat core | MPL-2.0 |
| Inbox Zero | AGPL-3.0 plus extra terms |
| Fastmail Overture and jmap-js | MIT |
| oRPC, tRPC, ts-rest, Effect, Cap'n Web, zod, Valibot, TypeBox | MIT |
| swift-openapi-generator, quicktype | Apache-2.0 |

---

## 0. Recommendation in one screen

1. **Use JMAP's semantics with an RPC-per-method envelope, and don't use JMAP's batch envelope.**
   - Every object type gets the JMAP verbs: `get`, `changes`, `set` and `query`.
   - The building blocks are opaque per-type state strings, `cannotCalculateChanges`, `maxChanges`, client-generated creation IDs and an `ifInState` guard.
   - On the wire, each call is `{id, method, args}` over MessagePort or WebSocket. Over HTTP it is `POST /v1/call/<Type>/<verb>`.
   - Defer back-references and heterogeneous batches. A JMAP-envelope adapter can sit on the same registry later if one is ever needed.
2. **Don't build `queryChanges` for list views. Build live windows** of at most about 200 body-free rows.
   - The engine re-runs each open window's keyset query after relevant commits, coalesced.
   - It pushes `{windowId, state, ids, total, changed}`. The push carries IDs only; clients fetch rows with `Thread/get`.
   - Every Aplos list view sorts or filters on mutable fields. For those, RFC 8620 makes `upToId` meaningless, and Stalwart re-runs the whole query anyway. I measured 39 ms and 1.2 MB of IDs at 100k threads, against 0.12 ms for a 100-row window [M].
3. **Schema: zod v4, in a platform-neutral `contract` module. Codegen: a thin in-house method registry** of about 500 lines. It generates:
   - the allowlists for preload, main and `server.ts`;
   - the typed TypeScript client, by inference, with no codegen step;
   - input validators at each host boundary;
   - an OpenAPI 3.1 document via `z.toJSONSchema(registry)`.

   Swift then uses swift-openapi-generator, with quicktype as a fallback that generates types only.
   - **oRPC is the runner-up.** Revisit it when its v2 reaches GA, or when typed errors, batching and MCP glue start costing more than the registry.
   - **Reject the rest:** tRPC, ts-rest, Effect RPC and Cap'n Web (§4).
4. **Persist the change log in the same transaction as the store write.** `{epoch, rev}` becomes `{dbEpoch, seq}`, held in an opaque state token. A gap triggers `changes(since)` catch-up, not a re-snapshot.
5. **Effort: about 4-6 weeks**, overlapping F2/F3 [I]. The largest piece is moving the renderer off a whole `AppState.threads` array onto windows: 1.5-3 weeks.

---

## 1. What exists today (all [V])

- **One wire shape everywhere: `invoke(method, payload)` plus a `{type, payload}` event stream** (`src/shared/types.ts` `Bridge`; `src/main/engine-rpc.ts` `Message` union).
  - Renderer → preload → `ipcMain.handle` → `connectEngine` → `utilityProcess` `parentPort`. Every call takes two hops, because main brokers all traffic (`src/main/electron.ts:278-288`).
  - Main also keeps a full `latestState` mirror and applies every change to it (`engineEvent`).
- **The allowlist is copied three times, and the copies have drifted.** I counted them:
  - Preload has 66 entries.
  - `electron.ts` has 47 engine methods plus 18 native ones.
  - `server.ts` has 47 engine methods plus 15 web ones and handles `update.*` inline.
  - `ai.key.paste` exists only in preload and in the server's web list.
- **Validation is hand-written inside the engine.** Examples are `threadPatch`, `settingsPatch`, `text()` and `enumValue()` in `src/engine/service.ts:58-130`. Its human-readable errors are shown directly in the UI.
- **Change propagation.**
  - `epoch = randomUUID()` is created on every engine start, and `rev` is an in-memory counter (`service.ts:231-232`).
  - `publish()` sends **full thread rows** for changed IDs, plus whole small collections (`service.ts:259-267`).
  - The store already computes the changed IDs per commit by comparing serialized signatures (`src/engine/store.ts:135-160`, `StoreDiff`). **The data a persisted change log needs is already there.**
- **The renderer holds the mailbox.**
  - It starts from `state.get {threadLimit:400}` (`renderer/App.tsx:107`), pages older threads with `threads.page`, and computes every view client-side (`shared/mailbox.ts` `threadInView`).
  - `createLiveState` buffers up to 500 changes and re-snapshots on a gap or a new epoch (`shared/live.ts`).
- **Constraints the contract must respect.**
  - The engine bundles for `platform:'neutral'`, with no Node imports and a bundle under 400,000 bytes (`tests/portability.test.ts`). `MOBILE.md` records 146,544 bytes, so about 250 KB of headroom remains.
  - The renderer's CSP has no `'unsafe-eval'` (`index.html`), so validators that compile with `new Function` must fall back to interpreted mode there.
  - Binary data travels as base64 inside JSON: `attachment.get`, and `ai.transcribe` at up to 25 MB (`API.md`; `server.ts` caps request bodies at 36 MB).
- **The team already writes JMAP back-references as a client.** `src/main/jmap.ts:251-254` chains `Email/query` → `Email/get` → `Thread/get` with `#ids`.

---

## 2. The four contract styles against Aplos's needs

| Need | (a) JMAP envelope (RFC 8620) | (b) Resource REST + state/changes + SSE | (c) Schema-first JSON-RPC (Delta Chat) | (d) Live queries (Inbox Zero) |
|---|---|---|---|---|
| Fits MessagePort natively | Yes: one message, many calls | No: HTTP has to be tunnelled | Yes | Yes |
| Fits loopback HTTP + SSE, CLI, MCP | Yes: one POST endpoint | Best: curl-friendly | Yes: POST per method | Needs a stateful subscription channel |
| Swift codegen | **Poor**: `[name, args, callId]` tuples plus JSON Pointer refs; the envelope needs a hand-written codec | **Best**: OpenAPI → swift-openapi-generator | Medium: no Swift OpenRPC generator; map methods to POST routes instead | Poor: subscriptions aren't described by OpenAPI |
| Thread views with mutable AI/rule sort keys | `queryChanges` degenerates (§3) | Same problem if built as `queryChanges` | Up to the designer | **Good**: re-run on commit |
| Push | State-only `StateChange` | SSE journal with `Last-Event-ID` | ID-only invalidation events | Full snapshots |
| Optimistic ops with receipts | `set` + `oldState`/`newState` | `Idempotency-Key` + `If-Match` | Up to the designer | `Admission` + `observeOperation` |
| Migration from `invoke(method,payload)` | Medium | Large (URL design for 66 methods) | **Smallest**: same shape | Large (whole UI data model) |

**Verified evidence behind the table.**
- **(a)** RFC 8620 §5.6 `upToId` text (rfc-editor.org/rfc/rfc8620.txt). `canCalculateChanges` in §5.5 only says whether `queryChanges` is supported "with these filter/sort parameters".
  - RFC 8621 §4.4.3: thread collapsing keeps only the first Email per Thread, so a thread row in JMAP is an *Email* id.
  - Aplos's rows carry private fields (status, importance, summary, due date). **Exposing those through JMAP gains no interoperability**, because a generic JMAP client wouldn't understand them [I].
  - **No `prefixItems` tuples in Swift.** GitHub code search finds no occurrence of `prefixItems` in `apple/swift-openapi-generator`. Its feature list supports `oneOf` with a discriminator only when every child is a `$ref` to an object (`Supported-OpenAPI-features.md`). So JMAP's tuple batches don't map to Swift [V for the docs; I for the consequence].
- **(c)** Delta Chat's Rust `#[rpc(all_positional)] impl CommandApi` (`deltachat-jsonrpc/src/api.rs:156`) is the single source of truth.
  - The yerpc macro generates TypeScript types, a `RawClient` and an OpenRPC document (`deltachat-jsonrpc/Cargo.toml`: `yerpc` with the `openrpc` feature, plus `typescript-type-def`). The same macro also emits Qt bindings (`deltachat-jsonrpc-bindings/build.rs`).
  - Events are long-polled with `get_next_event_batch` (`api.rs:186-201`), and the TS client loops on it (`typescript/src/client.ts` `eventLoop`). That makes the event channel transport-agnostic.
  - The events are ID invalidations. `ChatlistChanged` means "re-query the list"; `ChatlistItemChanged{chatId}` means "re-render one row". `EventChannelOverflow{n}` reports dropped events (`api/types/events.rs:87-93, 414-443`).
  - The only OpenRPC generator I found has 98 stars, was last pushed 2025-10-22, and documents TypeScript only (`open-rpc/generator` README).
- **(d)** Inbox Zero's query registry re-runs every open query after each commit. It skips republishing when the JSON is unchanged, coalesces one follow-up load, and pushes full snapshots (`packages/mail-core/src/subscriptions.ts:31-39, 84-110`). Its requests are a Zod discriminated union carrying `protocolVersion` and `requestId` (`protocol/mail-ipc.ts`).

**Verdict [I].** Use (c)'s wire shape, (a)'s per-type state vocabulary, and (d)'s re-run windows, pushing IDs only rather than (d)'s full snapshots. Use (b) only for blobs and sanitized HTML, where GET semantics, caching and a separate origin matter.

The JMAP batch envelope saves round trips, and that only matters at WAN latency. MessagePort and loopback round trips are sub-millisecond [I]. For a future phone, one compound option covers the dominant chain, query then get: `fetch: {properties}` on `View/query` and `View/watch`.

---

## 3. Thread-centric live views: three mechanisms, costed

### 3.1 What JMAP `queryChanges` actually does with mutable sort keys

**RFC 8620 §5.6** [V]:
- `upToId` helps only "if the sort and filter are both only on immutable properties"; otherwise "this argument is ignored".
- With a mutable property, the server "MUST include all Foos in the current results for which this property may have changed" in `removed`, and must re-add them at their new index in `added`.

**Stalwart** (`crates/jmap/src/changes/query.rs`) [V]:
- It computes `changes` since the query state; there is no separate per-query state.
- It returns early only when nothing changed. Otherwise it **re-runs the full query** (`email_query`, line ~70).
- With a mutable filter or sort, every created or updated ID that is in the new results goes into `added` with its index. All updated IDs go into `removed`. `upToId` is not consulted.
- Only the immutable branch stops at `upToId`.

**Which Email properties count as immutable** (`jmap-proto/src/object/email.rs:809-860`) [V]:
- Filters: dates, size, addresses, subject, body, header and text.
- Sorts: `receivedAt`, `size`, `from`, `to`, `subject`, `cc` and `sentAt`.
- `inMailbox` and keywords are mutable. **So even a plain Inbox view takes the mutable path.**
- I found no handling of `collapseThreads` in the mutability decision. It is unverified whether the previous representative email of a thread is reported when a newer one arrives [I, open].

**Fastmail's public client code** [V]. jmap-js (MIT, now `jmapio/jmap-js`, last commit 2020-05-05) sends `Email/queryChanges` with:
- `maxChanges: 25`;
- `calculateTotal: true`;
- `upToId` set to the last loaded ID when the list is partial.

It then chains `Email/get` on `/added/*/id` (`source/mail/MessageList.js:239-266`).

Overture's `WindowedQuery` (MIT, active 2026-10-21) [V]:
- keeps windows of 30 IDs and prefetches one window either side (`source/datastore/query/WindowedQuery.js:308-340`);
- truncates its cached list after `upToId`, and resets if that ID is missing (`_applyUpdate`, ~line 771);
- applies optimistic "preemptive" updates. When the server state catches up, it inverts and re-composes them (`sourceDidFetchUpdate`, ~line 1072);
- never sends an ID it only added preemptively as `upToId` (`getUpToStoreKey`);
- computes preemptive insert positions with a client-side comparator and binary search (`jmap-js mail-model.js:275-330`).

**Lesson [I].** Fastmail caps changes at 25 and falls back to refetching. Most of the value is in the optimistic-update discipline, not in index-level diffs.

### 3.2 Measured costs at 100k threads [M]

My script is `/tmp/aplos-bench-scripts/window-bench.mjs`, outside the repo.

**Setup.**
- Node 24.21 `node:sqlite` with SQLite 3.54, WAL, on this Mac.
- 100k synthetic threads in one account, 3,145 of them in Home.
- Indexes on `(account, status, rank DESC, last_at DESC, id)` and `(account, last_at DESC, id)`.
- Times are the mean of 10-200 warm-cache runs.

| Operation | Time |
|---|---|
| Home window: top 100 by (rank, date, id) | **0.13 ms** |
| All-mail keyset window, 100 rows mid-list | **0.12 ms** |
| Later window by due date; day-group counts | 0.04 ms; 0.40 ms |
| Count of Home; count of all 100k | 0.11 ms; 2.9 ms |
| **Full ordered ID list of All mail** (what `queryChanges` re-runs) | **39 ms, 1.2 MB JSON** |
| Full ordered ID list of Home (3k) | 0.86 ms |
| Index of one changed ID in All mail (count-before) | 5.1 ms |
| Commit of 500 rank updates plus 500 change-log rows | 19 ms |
| `changes(since)`: distinct IDs over a 10k-entry log, unindexed by type | 5.2 ms |
| One 100-row window as JSON | 19.9 KB |

### 3.3 The comparison

| Mechanism | Per-commit cost at 100k | Wire cost | What breaks |
|---|---|---|---|
| JMAP `queryChanges` with a mutable sort | One full query re-run per view: ~40 ms for All mail, ~1 ms for Home [M] | Every updated ID in the view goes out *twice*; a backfill page of 500 updates means 1,000 entries per client, for rows the client isn't showing | `upToId` can't bound the work, so clients cap `maxChanges` and refetch anyway (Fastmail) |
| Re-run bounded windows, ID-only push (**recommended**) | 0.1-0.5 ms per open window [M]; gated by account and type, and coalesced to at most about 4 per second per window [I] | About 100 IDs plus the changed subset, then `get` for unknown or stale rows only (≤20 KB) | Rows reorder under the cursor, which the UI handles (§5.4); scrollbars are approximate (keyset, no offsets) |
| Delta Chat ID invalidation; client re-fetches the full ID list | Same as the full list: 39 ms [M] | 1.2 MB per change at 100k | Works for chat lists of hundreds of items, not 100k mailboxes; it needs windowing, which turns it into the row above |
| Inbox Zero: re-run every query, push full snapshots | The query is cheap, but `JSON.stringify` of up to 40 × 50 rows per query per commit [V `MAX_MAILBOX_WINDOW_PAGES` in the prior report] | Full snapshot | It re-runs *all* queries on *every* write, even unrelated ones; harmless at 100 rows, wasteful at 2,000 |

**AI- and rule-derived sort keys [I].**
- Store the rank as a small **bucket**: important, normal or low, plus `source` and `rankedAt`. Avoid a continuous score.
- Sort Home by `(bucket, lastMessageAt, id)`. Bucket changes are rare, so windows churn less.
- Put the sort-key values in each row, so a client can place optimistic inserts with binary search, as Overture does.
- Later grouped by date sorts on `(dueDay, lastMessageAt, id)`. A group-count query gives the section headers (0.4 ms [M]).

---

## 4. Tooling

### 4.1 RPC frameworks

| | oRPC | tRPC v11 | ts-rest | Effect RPC (Effect 4) | Cap'n Web |
|---|---|---|---|---|---|
| Version / activity [V] | 1.16.1 stable (2026-10-22); main branch is **2.0.0-beta.46** (2026-10-24); canonical repo `middleapi/orpc`, 5.7k★ | 11.22.0, pushed 2026-10-25, 40.7k★ | 3.52.1; last commit on main **2025-06-02**; newest tag 3.53.0-rc.1 | `effect` 4.0.6 (2026-10-22); README says "LTS, at least three years" [C] | 0.12.0, pushed 2026-10-23 |
| MessagePort link | **First-party** client and server adapters; accepts Electron `MessagePortMain` (`packages/client/src/adapters/message-port/message-port.ts`); Electron guide (`docs/adapters/electron.mdx`) | None first-party (links: http, batch, stream, subscription, ws, local); community `electron-trpc`, last pushed 2025-07-28 | None (REST only) | Worker, socket, HTTP and stdio protocols (`rpc/RpcClient.ts`, `RpcServer.ts`); a MessagePort needs a custom Worker layer [I] | First-party MessagePort, WebSocket and HTTP batch [V README] |
| Streaming / subscriptions | Async-iterator procedures over SSE, resumed by `lastEventId` with `withEventMeta` (`docs/async-iterator-object.mdx`) | SSE and WebSocket subscriptions; `tracked()` event IDs (`stream/tracked.ts`) | **None** | Streams via ndjson / jsonRpc serialization | Callbacks via capabilities |
| OpenAPI / JSON Schema for Swift | **First-party generator, OpenAPI 3.0/3.1/3.2.** SSE is described as `text/event-stream` (`openapi-generator-operation.ts:590-612`). Standard JSON Schema converter (`json-schema/src/standard-json-schema-converter.ts`) | `@trpc/openapi` **11.22.0-alpha**; analyses TS types statically; README TODO lists "SSE subscriptions" | `@ts-rest/open-api` is pinned to **zod ^3** via `@anatine/zod-openapi` | RPC has none; `OpenApi.fromApi` exists only for `HttpApi` (`http-api/OpenApi.ts:312`) | **None, by design**: "no schemas" (README:14) |
| Contract-first | Yes (`@orpc/contract`) | No (types are inferred from the implementation) | Yes | Yes (`RpcGroup`) | No (TS interfaces; `capnweb-validate` generates validators at build time) |
| Extras that matter | Batch plugin, MCP registrar (`packages/mcp`), CORS/CSRF plugins | Mature ecosystem | none | Typed errors, AOT schema compiler | Promise pipelining, capability security |
| Size, gzip (bundlephobia) | client 3.6 KB, server 7.5 KB, contract 3.6 KB (v1.16.1) | client 10.5 KB, server 5.2 KB (11.19) | core 3.1 KB | `effect` 244 KB whole package | 15.7 KB |
| Neutral engine bundle | Contract and client import no `node:` modules in source [V rg] | n/a | n/a | Runtime too heavy for the 400 KB budget [I] | Yes |
| Wire stability | **v2 changed the RPC serializer and error format; v1 RPC clients cannot call a v2 server** (`docs/migrations/from-v1.mdx`) | Stable | Stalled | Stable in the 4.x LTS [C] | 0.x |

**Verdicts.**
- **tRPC:** no contract-first, alpha OpenAPI without SSE, and no first-party MessagePort.
- **ts-rest:** stalled for 16 months, zod 3 only, and no streaming.
- **Effect:** adopting it means rewriting the engine in Effect's paradigm, and RPC has no OpenAPI.
- **Cap'n Web:** schemaless, no OpenAPI and no Swift implementation. Its capability model is elegant but changes the security reasoning.
- **oRPC** is the only real framework candidate.

I still recommend the in-house registry first, for four reasons [I]:
1. The transports already exist and work (`engine-rpc.ts`, about 100 lines; `server.ts`, 74 lines).
2. The engine must import only schemas, never a framework.
3. The receipt, state and window semantics are application-level either way.
4. Adopting a beta major now means a wire migration later.

**Switch to oRPC when** v2 is GA *and* at least one of these holds: the in-house layer passes about 800 lines, or MCP, batching or typed errors become hand-maintained burdens. oRPC accepts Standard Schema, so zod schemas carry over unchanged.

### 4.2 Schema libraries

| | zod v4 | Valibot | TypeBox | Effect Schema |
|---|---|---|---|---|
| Version / licence [V] | 4.6.7, MIT, 44k★ | 1.5.0 (to-json-schema 1.8.0), MIT | 1.4.3, MIT, one maintainer | Effect 4.0.6, MIT |
| JSON Schema | Built in: `toJSONSchema` with targets draft-04/07/**2020-12**/**openapi-3.0** (`core/to-json-schema.ts:45-49`); a whole registry → `$defs` with `id` metadata (docs `json-schema.mdx:600`) | Separate package with ⚠️ caveats (lazy, record keys, enums) [V README] | **The schemas are JSON Schema**, so there is no conversion loss | `toJsonSchemaDocument`, `toStandardJSONSchemaV1` (`Schema.ts:1410`) |
| Standard Schema / Standard JSON Schema | Yes / yes | Yes / via `toStandardJsonSchema` | n/a | Yes / yes |
| Eval and CSP | Object JIT via `new Function`, with a probe and a `jitless` switch (`core/util.ts:517`); `z.compile` is also eval-based, about 7 KB gzip [C docs] | No `new Function` in the library [V rg] | JIT with an automatic interpreted fallback under a restrictive CSP [V docs] | AOT compiler (marked unstable), no eval |
| Hot-path cost | 76-377 ns per parse uncompiled, 27-68 ns compiled, across their benchmark shapes [C docs bench] | Small and fast [C] | Fastest when compiled [C] | n/a |
| Size | Whole package 89 KB gzip; tree-shaken typical use 6-13 KB, Mini 2-4 KB [C docs] | 14.7 KB whole, tree-shakes to a few KB | 18.6 KB | 244 KB |
| Agent familiarity [I] | Highest | Medium | Medium | Low |

**Choice: zod v4 (classic API) [I].**
- It has the best native JSON Schema path for OpenAPI 3.1, where JSON Schema 2020-12 is native, plus named components via `.meta({id})`.
- Its codecs can keep wire types as ISO strings while the engine works with richer types.
- It fits the engine's remaining ~250 KB of budget easily.
- Agents write it fluently.

**Rules for using it.**
- Validate **inputs** at every host boundary: renderer, HTTP, MCP.
- Validate **outputs** only in tests and dev builds. Every test call checks the output schema, which catches drift; production skips it.
- Set `z.config({jitless:true})` in the renderer, because of its CSP.
- At 100 rows per window, input validation costs tens of microseconds [C-derived], which is noise next to structured clone and IPC [I].

**TypeBox is the fallback** if Swift codegen fidelity proves painful. Its schemas *are* the OpenAPI components.

**Swift [V].**
- swift-openapi-generator 1.14.2 (2026-10-19) supports OpenAPI 3.0 and 3.1, 3.2 in preliminary form, and streaming bodies. Its runtime ships SSE decoding (`Sources/OpenAPIRuntime/EventStreams/ServerSentEventsDecoding.swift`).
- quicktype (Apache-2.0, active) can generate `Codable` types from the same JSON Schema.

**Contract rules this implies [I]:**
- every union is a discriminated `oneOf` of *named* object schemas;
- no tuples, no `Date`, `Map` or `BigInt` on the wire, and no zod transforms in wire schemas;
- evolving string enums are documented as open strings with known values, until a Swift spike confirms how unknown enum values decode [open].

---

## 5. The recommended contract, sketched in my own words

### 5.1 Envelope

- **Call:** `{v:1, id, method:"Thread/act", args}`. `id` is per connection and used only for multiplexing.
  - Over HTTP: `POST /v1/call/Thread/act` with `args` as the body and the client's `opId` as `Idempotency-Key`.
- **Reply:** `{id, ok:true, result}` or `{id, ok:false, error:{type, message, detail?, retryAfterMs?}}`.
  - Error types: `invalidArguments`, `notFound`, `stateMismatch`, `cannotCalculateChanges`, `tooManyChanges`, `unsupported` (for example a desktop-only method over HTTP), `authRequired`, `quotaPaused`, `unavailable`.
  - `message` stays the human sentence the UI shows today.
- **Push frames,** one stream per client:
  - `state {epoch, seq, types:{Thread, Message, Draft, Submission, Event, Account, Summary, AiJob, Operation, Settings}}`, coalesced over 50-250 ms;
  - `window {windowId, state, ids, total, changed}`;
  - `progress {requestId, …}`, ephemeral (Ask tokens, transcription), never logged;
  - `reset {reason}`.

  SSE uses `id: <seq>`, so `Last-Event-ID` resumes; MessagePort and WebSocket send `{since}` on reconnect.
- **Optional later:** `POST /v1/batch` with independent calls answered from one read snapshot. There are no back-references; `query` and `watch` accept `fetch:{properties}` instead.

### 5.2 Verbs (T is any type below)

- `T/get {ids, properties?}` → `{state, list, notFound}`.
- `T/changes {sinceState, maxChanges}` → `{oldState, newState, hasMore, upserted[], destroyed[]}`.
  - Aplos merges JMAP's created and updated into `upserted`, since clients refetch either way.
- `T/set {opId, create?, update?, destroy?, ifInState?}` → `{newState, created, updated, destroyed, notX, receipt}`.
- `View/query {spec, after?, limit≤200, fetch?}` → `{state, ids, next?, total?, rows?}`, for one-shot reads (CLI, MCP, search).
- `View/watch {spec, fetch?}` → the first `window` frame plus a `windowId`. `View/move {windowId, anchor}` scrolls it, and `View/unwatch` ends it.
- **Commands that aren't CRUD:**
  - `Thread/act {opId, ids, action, args}`, where action is done, later, trash, spam, read, bookmark, snooze or unsubscribe;
  - `Operation/undo {opId}`;
  - `Submission/set`, which covers send, undo-send and send-later as one `notBefore` mechanism;
  - `Sync/request`;
  - `Ai/request {kind, threadId}` → `AiJob`.
- **Blobs over plain HTTP:**
  - `GET /v1/blob/:id` serves attachments and raw MIME. On MessagePort the same bytes travel as a transferable `ArrayBuffer`, never base64.
  - `GET /v1/html/:messageId` serves sanitized HTML from a separate origin (SYNTH §10.8).

### 5.3 Core object types (field sketch)

Every row carries `id`, `accountId` and `rev`.

- **Account:** provider, email, display name, capabilities, and `status {state: ok | syncing | backfilling | paused | authRequired | error, detail, resumeAt}`.
- **Thread** (a body-free list row):
  - subject, snippet, participants, `lastMessageAt`, message count, unread, label IDs, has-attachments;
  - `workflow` (below);
  - `rank {bucket, source: ai | rule | user | heuristic, at}`;
  - `summaryId?`, `listUnsubscribe?`.
- **Message:**
  - `threadId`, `internetMessageId`, from, to, cc, reply-to, sent and received times, snippet;
  - flags (seen, flagged, answered), label IDs, attachment metadata (with blob IDs);
  - `bodyState: absent | fetching | present | evicted`, which is the lazy-body marker from SYNTH §5;
  - `references`.

  `MessageBody` is a separate `get` returning text, the sanitized-HTML URL and quoted ranges.
- **Label:** name, `role` (inbox, sent, drafts, trash, spam, archive, starred, important), `kind` (label or folder), and counts.
- **Draft:** mode, `threadId?`, from and recipients (as `{name, email}` arrays), subject, HTML, attachment blob IDs, `revision` (saves are compare-and-set), and `remote {providerDraftId, syncedRevision}` for future Gmail draft sync.
- **Submission:** `draftId`, the stable `messageId`, `notBefore`, `state` (queued, sending, sent, **uncertain**, failed, cancelled), `attemptAt`, error.
  - This takes over today's `pendingSendAt`, `sendAttemptAt` and `resendConfirmed` fields on Draft.
- **Event:** `calendarId`, title, start, end, all-day, location, description, guests, `etag`, `readOnlyReason?`, `threadId?`. **Calendar:** name, colour, primary.
- **Aplos-private types:**
  - **WorkflowState** is embedded in Thread but has its own `updatedAt` and `deviceId` for the hidden-label sync. Fields: status (new, done, later, trash, spam), bookmarked, `replyStatus`, `dueDate`, `reminderAt`, `todo`, `hiddenFromHome`.
  - **Summary:** `threadId`, `inputHash` (content-keyed, so a label change doesn't invalidate it), model, text, `action` (one preset suggested action), `state` (ready or stale).
  - **AiJob:** kind (summary, classify, plan, transcribe), target, `state` (queued, running, done, failed, skipped), attempts, `nextAt`, usage. Jobs make AI visible off the sync path (F5).
  - **Operation**, the receipt: `opId`, kind, targets, `state` (applied, queued, syncing, synced, failed, conflict), `appliedState`, error.
  - Also Conversation (Ask), Settings (a singleton), and later Rule and SenderRule.

### 5.4 Optimistic operations [I]

- **On the desktop:** the engine applies locally inside the commit, which is a few milliseconds away. The command returns `receipt {opId, appliedState}`, and the client drops its overlay once a window frame reaches a `state` at or beyond `appliedState`. This generalizes today's `compact:true` acks.
- **For remote clients:** borrow Overture's discipline. Apply "preemptive" edits locally, never send a preemptively added ID as an anchor, and on catch-up invert and re-compose the edits.
- **Rows moving under the cursor:** `View/watch` accepts `holdIds`. The engine keeps those rows at their old positions until they're released or until about 2 s after the last keystroke, so AI re-ranks don't move the row being triaged.

---

## 6. Transport bindings

| Client | Binding |
|---|---|
| Electron renderer | Main creates a `MessageChannelMain` and transfers one port to the engine. Electron's `child.postMessage(message, [transfer])` accepts `MessagePortMain[]` [V, electronjs.org utility-process docs]. The other port goes to the window through preload. Calls then skip main. Main keeps only native methods (`window.*`, `file.*`, `system.*`, `update.*`), and the main-side `latestState` mirror is dropped. Preload checks the generated allowlist |
| Browser preview, CLI | Loopback HTTP: `POST /v1/call/*`, `GET /v1/events` (SSE with `Last-Event-ID`), and blob and HTML routes, all with per-client bearer tokens (SYNTH §10). The OpenAPI document is served at `/v1/openapi.json` |
| MCP agent | A small adapter over the registry. Methods tagged `scope: read | draft` become tools; `send` and `destroy` need a scope grant |
| Phone (later) | The same HTTP binding over pinned TLS or Tailscale. Swift client from swift-openapi-generator; SSE via its runtime; maybe WebSocket later |

---

## 7. Migrating from `invoke` and `{epoch, rev}`

**Step 1 (2-3 days): registry with today's names.**
- Write zod input schemas for the 47 engine methods and 19 desktop methods.
- Make `host: engine | desktop` a registry field.
- Generate a static `methods.generated.ts`. Preload imports that file, not zod.
- Derive the `electron.ts` and `server.ts` sets from it.
- Add one test asserting the three hosts agree.

No wire change: the registry is a typed wrapper around `invoke`.

**Step 2 (3-5 days): typed client and validators.**
- `api.thread.update(...)` is inferred from the registry, and the roughly 60 renderer call sites migrate mechanically.
- Hand-written validators are replaced one method at a time, keeping their human messages.

**Step 3 (with F2/F3, 1-2 weeks): persisted change log.**
- Add `changelog(seq INTEGER PRIMARY KEY, type, id, op)`, indexed on `(type, seq)`, written in `store.write`'s transaction from the `StoreDiff` it already computes.
- Add a per-type state cache and `T/changes`, with a `floor` after 50k entries or 30 days → `cannotCalculateChanges`.
- The state token is base64 of `{dbEpoch, seq}`, plus an HMAC for network clients.
- **During initial backfill, write one coarse entry per page**, not per thread, so a 100k-thread import doesn't flood the log [I].

**Step 4 (1.5-3 weeks): windows.**
- Move the predicates from `shared/mailbox.ts` (`threadInView`, `isHomeNew`, and the rest) into SQL view specs.
- Add `View/watch`.
- Replace `createLiveState`'s whole-array model with a per-window ID list plus an ID-keyed row cache.
- Keep `state.get` only for small singletons until they move to `get`/`changes`.

**Step 5 (3-5 days): HTTP binding** with tokens, SSE resume and the OpenAPI emitter. Add a golden-file test that diffs the generated `openapi.json`, which is EmailEngine's discipline (SYNTH §6).

**Step 6 (1-2 days): Swift spike.** Generate a client from `openapi.json`, then call `View/query` and consume the SSE stream. The aim is to prove the codegen constraints before a phone is ever scheduled.

**How today's state maps across:**

| Today | New |
|---|---|
| `epoch`: a UUID per engine start | `dbEpoch`: a UUID per database creation, reset or restore |
| `rev`: an in-memory counter | `seq`: the persisted change-log key |
| `StateChanges` with full rows | A `state` frame with per-type states, plus `window` frames with IDs; rows come from `get` |
| Re-snapshot on a gap | `changes(since)` catch-up; reset only below the floor or on an epoch mismatch |
| `compact:true` → `{epoch, rev}` | `receipt {opId, appliedState}` |
| The `ops` table's unique `id` | The `opId` used as the idempotency key |

**Method mapping (abbreviated):**
- `state.get` → `Session/get` plus per-type `get`;
- `threads.page` and `search` → `View/query`;
- `thread.update` and `home.hide` → `Thread/act`, and `thread.undo` → `Operation/undo`;
- `draft.save` and `draft.delete` → `Draft/set`, and `draft.send` and `draft.undoSend` → `Submission/set`;
- `ai.summarize` → `Ai/request`, with the result arriving as a Summary change;
- `ai.ask` → `Ask/run` plus `progress` frames;
- `attachment.get` and `data.export` → blob routes;
- `calendar.*` → `Calendar` and `Event` get/set/query;
- `sender.block` → `SenderRule/set`.

---

## 8. Risks and effort

**Risks [I unless marked].**
1. **Window re-run storms during backfill.** Mitigate with per-window coalescing, account and type gating, and coarse log entries during backfill.
2. **Bugs in `changes`.** Bulwark shipped two delta bugs (SYNTH §11 A). Mitigate with a replay test: apply a random op sequence, then check that `snapshot(seq0) + changes` equals `snapshot(seqN)`.
3. **Reordering churn** from AI ranks. Mitigate with buckets and `holdIds`.
4. **Schema evolution across TypeScript and Swift.** Allow only additive changes, a `v` in the envelope, capability flags in `Session/get`, and a golden OpenAPI diff in CI. Swift's behaviour on unknown enum values is unverified.
5. **zod JIT under CSP:** set `jitless` in the renderer [V for the mechanism].
6. **Validation error UX:** zod's messages are not user-facing, so keep the engine's human errors.
7. **If oRPC is adopted early,** expect its v1→v2 wire break [V].
8. **The HTTP binding inherits every listener-security item** in SYNTH §10.
9. **Base64 payloads** in `ai.transcribe` and attachments must move to blob routes or transferables, or memory spikes will persist.

**Effort (one developer with agents) [I].**

| Item | Estimate |
|---|---|
| Registry and generated allowlists | 2-3 days |
| Typed client and validators | 3-5 days |
| Change log and `changes` | 3-5 days (needs F2's normalized rows for full value) |
| Windows and renderer migration | 1.5-3 weeks |
| HTTP binding and OpenAPI | 3-5 days |
| Swift spike | 1-2 days |
| MCP adapter | 1-2 days |
| **Total** | **About 4-6 weeks, much of it overlapping F2/F3** |

Steps 1-2 are independent of the storage rewrite and can start now.

---

## 9. Open questions

1. Should Aplos ever speak real JMAP to third-party clients? The recommendation assumes not, and a JMAP adapter remains possible later.
2. How does swift-openapi-generator decode unknown string-enum values? Settle this in the Swift spike before choosing between closed and open enums.
3. Does Stalwart's `queryChanges` report the displaced representative email when `collapseThreads` is on? It doesn't decide the plan, but it is relevant if Aplos ever leans on Fastmail's `queryChanges` as a client.
4. Change-log retention: a fixed entry count (Stalwart 10k, Superlocal 10k) or time-based? Phone clients that sleep for days argue for time-based plus compaction (one entry per ID).
5. Should windows push changed rows inline when there are only a few of them, to save the `get` round trip on MessagePort? Measure once windows exist.

## Sources

**Aplos files.** `API.md`, `src/shared/live.ts`, `src/shared/types.ts`, `src/shared/mailbox.ts`, `src/main/{engine-rpc,engine-host,electron,preload,server,jmap}.ts`, `src/engine/{service,store,ports}.ts`, `tests/portability.test.ts`, `MOBILE.md`, `index.html`.

**Specifications.** RFC 8620 §5.5-5.6 and §7; RFC 8621 §4.4.3-4.5 (rfc-editor.org).

**Clones** (under `aplos-research/src/`, commit in brackets): `stalwart` [aa47d8e], `fastmail-overture` [a64b92e], `fastmail-jmap-js` [43627b4], `deltachat-core` [4ad5332], `inbox-zero` [9946df5], `orpc` [4a9ad5b], `trpc` [8d09833], `ts-rest` [dd7239b], `effect` [16fe800, sparse], `capnweb` [7666553], `zod` [afdac65], `valibot` [2d29dbf], `typebox` [ed9d84a]. The files read are cited inline.

**Web:** `gh api` repository metadata (read 2026-10-25); bundlephobia.com size API; electronjs.org utility-process docs; the apple/swift-openapi-generator README and `Supported-OpenAPI-features.md`; the open-rpc/generator README.
