# Storage engine and schema validation at 100k-1M messages

2026-10-25. Gap research for `SYNTH-architecture.md` §5 and §11 F2. **[V]** means I measured it or read it in code or official docs (evidence given). **[I]** means inference. **[C]** means a project's own claim that I did not verify. Every benchmark script is original and lives outside the repo in `/Users/knewton/.t3/aplos-research/bench/storage/`: `gen.mjs`, `schema.mjs`, `bench.mjs`, `compress.mjs`, `fts-legacy.mjs`, `probe*.mjs` and `results/*.json`. No third-party code was run except the two npm drivers under test, installed with `--ignore-scripts`. Generated databases were deleted after each run.

## 0. Answer in brief

1. **The synthesis schema holds up at 1M messages.** Normalized messages, a SQL-aggregate thread rollup, message and thread label tables, a same-transaction change log, a compressed body table and a contentless FTS5 table give constant-time list pages (**0.04-0.07 ms per 50 rows, at any depth**). Unread counts take **0.5 ms**, a label change commits in **0.2 ms p50**, and a fresh process shows the first screen in **about 10 ms**. Its RSS is **65 MB** in Electron, of which 57 MB is the runtime's own baseline. 1M-scale numbers are in §4. The whole-mailbox-in-memory model cannot reach this scale: Electron's V8 heap is capped at **4,192 MB** even with `--max-old-space-size=16000` [V], and 200k realistic messages carry **5.2 GB** of HTML.
2. **Full-text indexing is about 80% of write cost.** With FTS off, page commits run at **11,469 msgs/s**; with it on, at **2,284 msgs/s** [V]. Two fixes matter:
   - **Write FTS rows last in each transaction.** FTS5 flushes its pending index whenever a later statement opens a savepoint, and doing this gave **1.8x** [V].
   - **Move indexing to a paced background job**, off the sync commit.
3. **Driver: keep `node:sqlite` for now. The driver is not the bottleneck.** better-sqlite3 13 is only **6-8% faster** on page commits and about **30% faster** on bm25-ranked search. The old reason for avoiding it (Electron ABI rebuilds) has gone: v13 ships Node-API prebuilds that loaded unchanged in Node 24 and Electron 44 [V]. **Extend the `SqlDatabase` port to carry BLOBs**, so a later switch touches one file.
4. **Bodies: a separate table of zstd-3-compressed BLOBs, not content-addressed files.** The files variant used **32% more disk** (4 KB APFS blocks), opened threads **4.5x slower**, and spent **54 s** creating 200k files [V]. Brotli-5 saved only 6% of space at **4.8x the compression CPU** [V].
5. **Search sorted by date is the slow query.** Newest-50 results for a common term take **32-40 ms at 200k** and grow with the number of hits. If message rowids are made date-ordered, the same query becomes an FTS `ORDER BY rowid DESC` and takes **0.05-0.07 ms** [V; results in §4.3].
6. **Encryption at rest costs too much to adopt by default.** SQLCipher-compatible AES (through SQLite3 Multiple Ciphers) made page commits **4.2x slower** and cache-missing reads **up to 14x slower**; ChaCha20 cost **2.2x** and **6.5x** [V]. It would also force a driver change, because `node:sqlite` cannot load a codec [V docs]. Rely on FileVault plus 0600 files and Keychain-wrapped secrets, as Delta Chat chose (`arch/deltachat-core.md:212`).

## 1. Setup

**Machine [V].** MacBook Pro, Apple M1 (4 performance and 4 efficiency cores), 16 GB RAM, internal APFS SSD (88-94 GB free), macOS 26.6.2 (25G83), on AC power. Other agents shared the machine, so treat differences under ~10% as noise. Each configuration ran **once**.

**Runtimes [V].**
- Electron 44.7.2 run as Node (`ELECTRON_RUN_AS_NODE=1`; Node 24.21.0, ABI 149, bundled SQLite 3.53.4).
- Homebrew Node 24.21.0 (ABI 137). It links Homebrew's shared `libsqlite3`, so `select sqlite_version()` returns **3.54.0** even though `process.versions.sqlite` says 3.53.4 [V `otool -L`].
- better-sqlite3 13.0.3 and better-sqlite3-multiple-ciphers 13.0.3, both on SQLite 3.53.4; the second adds SQLite3 Multiple Ciphers 2.4.0.

**Data [V `gen.mjs`, `compress.mjs`].** Deterministic synthetic mailboxes, with no real mail:
- 50,000 threads / 202,873 messages, and 250,000 threads / ~1M messages.
- Thread sizes: half singletons, a tail up to 80 messages, mean 4.06.
- Bodies: lognormal HTML, measured **median 8,230 B, 5.0% over 100 KB, mean 26.9 KB**, capped at 2 MB. Bodies under 20 KB are personal-style paragraphs; larger ones are mostly newsletter tables with unique tracking URLs.
- Words follow a Zipf distribution over a 30k-word synthetic vocabulary.
- Each message gets 1-4 labels from 9 system labels and 30 user labels. INBOX is on ~18% of older mail and 85% of recent mail; 6-40% of mail is unread.

Caveat: synthetic HTML compresses about 3.8x. Real newsletters are often more repetitive, so real ratios may be better [I].

**Schema [V `schema.mjs`].** `STRICT` tables:
- `messages`: indexed columns plus a `parts` bitmask, `UNIQUE(account_id, remote_id)` and an index on `(thread_id, date)`.
- `threads`: rollup recomputed per touched thread by an `UPDATE … FROM (SELECT max/min/count/sum … GROUP BY)` aggregate.
- `message_labels`: a `WITHOUT ROWID` table.
- `thread_labels(thread_id, label_id, last_date, unread)`, with a keyset index on `(label_id, last_date DESC, thread_id DESC)` and a partial index `WHERE unread > 0`.
- `changes(seq INTEGER PRIMARY KEY, …)`: one row per message and per thread, written in the same transaction.
- `bodies(message_id, codec, raw_size, data BLOB)`.
- `fts5(subject, people, body, content='', contentless_delete=1)`, sharing the message rowid. Body text is capped at 64 KB.

Pragmas, identical for every driver: WAL, `synchronous=NORMAL`, `cache_size=-32000` (32 MB), `temp_store=MEMORY`. Commits are 100 messages per `BEGIN IMMEDIATE` transaction. Compression and file writes happen outside the transaction and are timed separately.

**Cold open** spawns a fresh process of the same runtime. It opens the database, reads the first INBOX page, reads unread counts for all labels, decompresses one body and runs one FTS query. The OS page cache was warm, because `purge` needs root, so these are warm-cache process starts.

## 2. Verified runtime facts (task 1)

| Fact | Electron 44.7.2 | Homebrew Node 24.21.0 | Evidence |
|---|---|---|---|
| `sqlite_version()` | 3.53.4 (bundled) | 3.54.0 (system `libsqlite3`) | `probe.mjs` |
| FTS5, JSON (`->>`, `jsonb`), math functions | yes | yes | `ENABLE_FTS5`, `ENABLE_MATH_FUNCTIONS`; queries ran |
| `contentless_delete=1` (3.43+) and `contentless_unindexed=1` | work | work | delete and requery ran |
| trigram tokenizer | yes | yes | |
| Session, preupdate hook, dbstat, percentile | yes | yes | compile options |
| `ENABLE_STAT4`, `ENABLE_API_ARMOR` | **no** | yes | compile options |
| `MAX_VARIABLE_NUMBER` | 32,766 | 250,000 | compile options |
| `ENABLE_RBU` | yes | no | compile options |
| V8 heap limit | **4,192 MB, even with `--max-old-space-size=16000`** | 4,288 MB default, 16,192 MB with the flag | `v8.getHeapStatistics()` |
| node:zstd | available | available | Stability 1, Experimental (Node 24 docs); `dictionary` option since 24.20 |

**`node:sqlite` API status** (Node 24 docs, nodejs.org/docs/latest-v24.x/api/sqlite.html) [V]:
- **Stability 1.2, Release candidate, since v24.15.0.** It has been unflagged since 22.13/23.4. No warning is printed in either runtime [V].
- Available APIs:
  - `function()` (22.13) and `aggregate()` with window `inverse` (24.0);
  - `sqlite.backup()`, async (23.8);
  - `createSession`/`applyChangeset` (22.12);
  - `StatementSync.iterate()` (22.13), `setAuthorizer` (24.10), `createTagStore` (24.9), `serialize`/`deserialize` (24.16), `limits` (24.15), and `defensive` on by default (24.14);
  - BLOBs in as TypedArray/ArrayBuffer and out as `Uint8Array`.
- Gaps:
  - No virtual-table API.
  - No encryption.
  - Everything is synchronous except `backup()`.
  - The part of the docs I read says nothing about threads. I verified that a `worker_threads` worker can open **its own** `DatabaseSync` against the WAL database and read while the main thread writes (§4.4). Electron's `utilityProcess` was not tested.

**Aplos-specific [V].**
- The engine's SQL port (`apps/desktop/src/engine/sql.ts:5`) types values as `string|number|null`, so it **cannot carry BLOBs** today.
- Aplos's own `bench:mailbox` (`apps/desktop/scripts/mailbox-benchmark.ts:14-20`) uses 2 messages per thread and a repeated 2,000-character body. That does not represent real mail.
- Running the worktree's `node_modules/.bin/electron` triggered Electron's lazy binary download into `node_modules/electron/dist` (gitignored; `git status` unchanged).

## 3. Driver comparison (task 2)

| | `node:sqlite` | better-sqlite3 13.0.3 | better-sqlite3-multiple-ciphers 13.0.3 | op-sqlite 18.2.5 (mobile) | expo-sqlite 58 (mobile) |
|---|---|---|---|---|---|
| License | MIT (Node); SQLite is public domain | MIT | MIT (SQLite3MC MIT) | MIT | MIT |
| Maintenance | Node core; RC | v13.0.0 on 2026-07-21, 13.0.3 on 08-05; monthly cadence [V npm] | Tracks better-sqlite3; 13.0.3 on 08-07, 13.0.4-beta on 09-21 [V npm]. One maintainer, who is also a better-sqlite3 maintainer [C README] | Last publish 2026-09-20 [V npm] | Expo SDK |
| SQLite version | **Follows the host runtime** (3.53.4 Electron, 3.54.0 Homebrew Node) | Bundled 3.53.4; same in every runtime | 3.53.4 plus codec | Bundled and compiled from source; `iosSqlite` opt-in uses the system SQLite [V docs] | Self-compiled [I docs] |
| Electron rebuild | none | **None since v13.** Node-API 10 prebuilds are bundled for darwin, linux and win32 on x64 and arm64, with no install script. The same `.node` loaded in Node ABI 137 and Electron ABI 149 [V]. Packaging must still unpack the `.node` file from asar [I] | same | n/a | n/a |
| Encryption | **none.** SQLite3MC is a patched amalgamation and VFS shim, not a pure loadable extension [V utelle.github.io/SQLite3MultipleCiphers docs] | none | ChaCha20-Poly1305 (default), SQLCipher v1-4 formats, AES-CBC and others, via `PRAGMA cipher/key`; raw hex keys supported [V ran] | SQLCipher via the `"sqlcipher": true` build flag; not combinable with `iosSqlite` [V docs] | `useSQLCipher` plugin. **If the binary lacks SQLCipher, `PRAGMA key` silently does nothing** [V docs] |
| FTS5 | yes | yes | yes | **Off unless `"fts5": true`** [V docs] | On by default on native (`enableFTS`) [V docs]; this supersedes `MOBILE.md:17`'s doubt |
| Synchronous API | everything | everything | everything | `executeSync`, which is **"Not available in transactions"**; the docs also say **"DO NOT OPEN MORE THAN ONE CONNECTION PER DATABASE"** [V docs] | `runSync`, `getAllSync`, `withTransactionSync`, sessions; `useNewConnection` [V docs] |
| Reader connections in threads | one `DatabaseSync` per worker [V] | documented worker support [C README]; worked here [V] | worked here [V] | one dedicated native thread | multiple connections |
| BLOB type | `Uint8Array` | `Buffer` | `Buffer` | `ArrayBuffer`/typed arrays | `Uint8Array` |
| Notable build defaults | `THREADSAFE=1`, `defensive` | `THREADSAFE=2`, `DEFAULT_MEMSTATUS=0`, `STAT4`, `DQS=0`, 16 MB cache, WAL `synchronous=1` [V `deps/defines.gypi`] | same | | |

Also seen: `@signalapp/sqlcipher`, used by Tuta, is **AGPL-3.0** (`arch/tuta-desktop.md:5`). It is unusable unless Aplos accepts AGPL.

**Measured driver differences** (200k scale; same SQLite 3.53.4 in Electron):
- better-sqlite3 commits pages **7% faster** (2,441 vs 2,284 msgs/s).
- bm25 top-50 queries are **about 30% faster** (135 vs 203 ms for the very common term).
- Label changes are slightly faster (0.13 vs 0.19 ms p50).
- Opening costs **~4 ms more** (native addon load).

Everything else is equal. I attribute the bm25 gap to `THREADSAFE=2` and `MEMSTATUS=0`, which skip a mutex on each of FTS5's many auxiliary API calls [I].

## 4. Results (task 3)

### 4.1 Load: 100 messages per transaction

| Run (200k msgs unless noted) | DB-only msg/s | End-to-end msg/s (excl. generation) | Page txn p50/p95/max ms | FTS insert + commit s (of txn s) | DB size MB |
|---|---|---|---|---|---|
| node:sqlite, Electron | 2,284 | 1,910 | 45 / 69 / 136 | 43 + 41 (89) | 2,552 |
| node:sqlite, Homebrew Node (3.54.0) | 2,266 | 1,900 | 46 / 69 / 94 | 42 + 41 (89) | 2,517 |
| better-sqlite3, Electron | 2,441 | 2,020 | 43 / 64 / 89 | 39 + 40 (83) | 2,517 |
| better-sqlite3, Node | 2,472 | 2,046 | 42 / 64 / 125 | 39 + 40 (82) | 2,517 |
| **FTS off** (node:sqlite, Electron) | **11,469** | 5,825 | 4 / 22 / 45 | 0 + 14 (18) | 1,580 |
| FTS rows interleaved, not last | 1,523 | 1,347 | 58 / 128 / 169 | 17 + 33 (133) | 2,516 |
| FTS body text capped at 16 KB | 2,698 | 2,189 | 41 / 54 / 94 | 37 + 34 (75) | 2,347 (FTS 766 vs 932) |
| Date-ordered rowids, inserted newest-first | **1,285** | 1,158 | 69 / 132 / 197 | 103 + 50 (158) | 2,932 (FTS 1,305) |
| Reverse-date rowids | ⟨REVDATE⟩ | | | | |
| brotli-5 instead of zstd-3 | 2,325 | **1,194** | 45 / 67 / 156 | 42 + 41 | 2,428 |
| bodies as files | 2,262 | 1,260 (54 s writing files) | 45 / 70 / 194 | 43 + 42 | 1,057 + 1,790 blob dir |
| SQLCipher v4 (bs3-mc, raw key) | **547** | 522 | 199 / 333 / 783 | 49 + 317 (371) | 2,659 |
| ChaCha20 (bs3-mc, raw key) | 1,018 | 937 | 108 / 172 / 377 | 42 + 153 (199) | 2,641 |
| ⟨1M rows⟩ | | | | | |

At 2,284 msgs/s, a 200k-message mailbox commits in about 90 s of database time. Gmail's quota, not SQLite, limits sync speed. At 6,000 units/min, with `messages.get` at 20 units and `threads.get` at 40, metadata arrives at a few hundred messages per minute (`SYNTH-architecture.md` §0.1). FTS cost still matters for a different reason: **the write lock is held during each 45-136 ms page commit**, so a keyboard triage action queued behind a sync page waits that long. IMAP and JMAP bulk loads are not quota-bound either [I].

### 4.2 Read path and single-message writes (200k, p50 unless noted, ms)

| Run | First INBOX page | Keyset walk, 200 pages, p50/p95 | Unread INBOX (threads, partial index) | Unread, all 39 labels | Unread INBOX messages (join) | Open thread (3-8 msgs, decompress) p50/p95 | Label change p50/p95/p99 | Delete msg p50/p99 | FTS delete statement |
|---|---|---|---|---|---|---|---|---|---|
| node:sqlite, Electron | 0.042 | 0.071 / 0.43 | 0.48 | 5.0 | 26 | 0.17 / 0.79 | 0.19 / 0.68 / 18 | 0.30 / 17.5 | 0.008 |
| better-sqlite3, Electron | 0.022 | 0.053 / 0.37 | 0.47 | 4.8 | 23 | 0.18 / 0.91 | 0.13 / 0.34 / 17 | 0.22 / 19 | 0.006 |
| bodies as files | 0.043 | 0.065 / 0.074 | 0.49 | 5.1 | 25 | **0.77 / 1.55** | 0.13 / 0.30 / 16 | 0.45 / 18 | 0.008 |
| SQLCipher | 0.022 | 0.32 / 0.63 | 0.52 | 4.9 | **376** | 0.43 / 1.69 | 0.74 / 1.5 / 59 | 1.33 / 63 | 0.031 |
| ChaCha20 | 0.022 | 0.15 / 0.43 | 0.48 | 4.9 | 166 | 0.28 / 1.18 | 0.37 / 0.79 / 34 | 0.64 / 36 | 0.016 |
| ⟨1M⟩ | | | | | | | | | |

The p99 spikes of ~16-19 ms in plaintext runs are WAL auto-checkpoints, which run inside the committing call. A body of 150 KB or more reads and decompresses in 0.37 ms (DB) or 0.43 ms (file).

**Current Aplos pattern [V `fts-legacy.mjs`].** With 50k FTS rows, deleting by an `UNINDEXED` id took **23.9 ms per row**; deleting by rowid with `contentless_delete` took **0.04 ms**. `store.ts` does the slow delete for every changed thread on every save.

### 4.3 Full-text search (200k; ms; top-50 queries)

| Query (hits) | count(*) | ORDER BY rank | ORDER BY rowid DESC | JOIN messages ORDER BY date DESC |
|---|---|---|---|---|
| very common term (169,491) | 4.7 | 203 | 0.06 | 39 |
| common term (57,122) | 1.5 | 60 | 0.06 | 32 |
| mid term (5,846) | 0.17 | 5.9 | 0.05 | 2.0 |
| prefix `roy*` (67,938) | 7.5 | 83 | 6.5 | 40 |
| phrase (1,199) | 2.1 | 5.6 | 0.22 | 2.6 |
| `people:` column filter (28,102) | 1.0 | 30 | 0.06 | 23 |
| rare token (1 hit) | 0.014 | 0.03 | 0.014 | 0.016 |
| ⟨1M rows⟩ | | | | |

- These are node:sqlite numbers in Electron. Under SQLCipher, the date-sorted join for common terms took **412-436 ms**.
- `INSERT INTO fts(fts) VALUES('optimize')` took **10.7 s** at 200k and **did not change query latency** (±3%).
- FTS size was **932 MB for 1,812 MB of indexed text (51%)**. That matches SQLite's own email example: 743 MiB of `detail=full` index for 1,636 MiB of mail; 340 MiB with `detail=column`, 134 MiB with `detail=none` (sqlite.org/fts5.html).

### 4.4 Concurrency, WAL and checkpoints

- **Worker-thread reader [V].** A `worker_threads` reader on its own connection ran INBOX page plus unread-count reads (p50 0.6 ms, p99 2.5 ms) while the main thread committed label changes (p50 0.24 ms, max 57-106 ms). This was identical on both drivers. Under SQLCipher, read p99 rose to 34 ms.
- **WAL growth [V].** With that reader busy all the time, the WAL **reached 104-938 MB in 2.5 s**. WAL reset needs a moment with no readers; `wal_checkpoint(TRUNCATE)` afterwards took 3-24 ms in plaintext and 112 ms under SQLCipher.
- **Write amplification [V].** With auto-checkpoint off, 2,000 single-message changes wrote **~140 MB of WAL (~70 KB, about 17 pages, per change)**. TRUNCATE then took **115-160 ms** in plaintext, 260 ms with ChaCha20 and 441 ms with SQLCipher.
- **Change log [V].** It grew by about 1.3 rows per message (268k rows, 4.4 MB at 200k). It is negligible in size but needs a compaction floor (`SYNTH` §5).

### 4.5 Space (200k)

| Component | MB |
|---|---|
| Raw HTML generated | 5,191 |
| Bodies: zstd-3 stored bytes / table pages | 1,354 / 1,474 |
| FTS5 (all shadow tables, 64 KB text cap) | 932 |
| messages + indexes | 67 |
| threads, thread_labels, message_labels (with indexes) | 14 + 8 + 8 |
| changes | 4 |
| **Total DB** | **2,552** (12.6 KB per message) |
| Files variant: DB + blob directory (logical 1,350) | 1,057 + **1,790** |
| ⟨1M rows⟩ | |

### 4.6 Cold open and memory

| Run | Process wall ms | Open ms | First page ms | All unread counts ms | First body ms | RSS MB |
|---|---|---|---|---|---|---|
| node:sqlite, Electron | 70 | 0.8 | 0.1 | 7.5-8 | 0.7 | 65 |
| node:sqlite, Homebrew Node | 48 | 0.9 | 0.1 | 8.5 | 0.8 | 19 |
| better-sqlite3, Electron | 72-91 | 4.0-4.5 | 0.1 | 7.5 | 0.6 | 67 |
| SQLCipher (raw key) | 100-118 | 4.3-5.8 | 0.3 | **35-40** | 0.8 | 67 |
| ChaCha20 (raw key) | 83-109 | 4.5 | 0.2 | 19-25 | 0.8 | 67 |
| ⟨1M⟩ | | | | | | |

Opening is independent of mailbox size, because nothing is loaded eagerly. Measured idle baselines were 57 MB for Electron-as-Node and 12.5 MB for Node, both unchanged by importing `node:sqlite` [V `probe-open.mjs`]. Opening the database and rendering the first screen therefore adds only about 6-10 MB, mostly page cache. `gaps/macos-daemon-lifecycle.md:80` measured 64 MB for an idle Electron-as-Node daemon. The benchmark process itself peaked at 360-410 MB (`/usr/bin/time`), mostly the generator.

## 5. Findings to design around

1. **FTS5 flushes at every savepoint [V].** `fts5SavepointMethod` calls `sqlite3Fts5FlushToDisk` (SQLite 3.53.4 amalgamation, `sqlite3.c:263599-263608`). An upsert, or any statement that opens a statement journal, after an FTS insert in the same transaction forces a flush of the pending index. Profiling showed message upserts absorbing the cost. Moving every FTS insert to the end of the transaction raised throughput from **1,686 to 3,004 msgs/s** (node:sqlite) and from **1,968 to 3,363** (better-sqlite3) on a 7.6k-message run. At 200k scale the gain was **1.5x** (1,523 vs 2,284 msgs/s). In the interleaved run, the FTS statements themselves took only 17 s, because the flushes they triggered were charged to the upserts that followed them.
2. **FTS is the write bottleneck, not bodies or rollups [V].** Over 200k messages, body inserts took 0.6 s, rollups 1.4 s, FTS inserts 43 s, and commits (mostly FTS flushes) 41 s. Inbox Zero's desktop already indexes in paced batches of 100 as a backlog job (`arch/inbox-zero-client.md:238`).
3. **Sort search by date without a join [V/I].** For common terms, `ORDER BY rank` and joins sorted by date cost O(hits): 30-200 ms at 200k. `ORDER BY rowid DESC` costs 0.05 ms. Make the rowid date-ordered (for example `unix_seconds × 4096 + sequence`) and both newest-first search and keyset paging over results become nearly free. ⟨DATEID result⟩.
4. **Count threads, not messages [V].** The partial index on `thread_labels` answers unread counts in 0.5 ms. Counting messages through a join costs 26 ms (p95 335 ms cold) and grows with the label's size. All 39 labels at once take 5 ms, so a sidebar refresh is cheap enough.
5. **WAL needs a supervisor [V].** A continuous reader lets the WAL grow by hundreds of MB in seconds. A long-held iterator or read transaction would do the same indefinitely. Keep read transactions short, run `wal_checkpoint(TRUNCATE)` when idle, and set `journal_size_limit` [I]. This matches Delta Chat's 200 MB WAL (`SYNTH` §5).

## 6. Recommendation (task 4)

**Driver.** Stay on `node:sqlite` through F2, with these changes:
- Add `Uint8Array` to `SqlValue`, which every target driver supports.
- Add `iterate()` to the port.
- Keep the one-writer rule.

Plan a switch to better-sqlite3 only if one of these becomes true:
- (a) encryption is required;
- (b) the engine moves into a runtime whose SQLite you do not control. Homebrew-style shared builds or a future Node SEA would change the SQLite version and compile options under you; better-sqlite3 pins them;
- (c) `node:sqlite` regresses in an Electron upgrade.

The switch is now cheap: no rebuild step, and one adapter file. The 7% throughput gain alone does not justify it.

**Body placement.** Use a separate `bodies` table holding codec-tagged compressed BLOBs (zstd-3, codec id per row, `0` = stored raw) keyed by message rowid. Store the sanitized render form or the raw MIME, not both [I].
- Do not put bodies in the message row. SQLite keeps up to about 4 KB of a row's payload on its leaf page, so a typical 2 KB compressed body would sit inline, fit only a couple of rows per page, and slow every list or rollup scan of `messages` [I from the SQLite file-format rules].
- Do not use content-addressed files for bodies. They lose on disk use, read latency, write time and atomicity, and dedup barely helps HTML bodies.
- Do use files for **attachments**, which are large, streamable through `GET /blob/:id` (`gaps/engine-contract-rpc-stack.md:283`), and can live in a `.noindex` directory [I].

**FTS layout.**
- One contentless FTS5 table with `contentless_delete=1`, sharing the message rowid, `detail=full` (phrase search needs it), and no prefix index (prefix queries took 7.5 ms to count).
- Insert FTS rows last in the transaction. Better still, have a job index messages whose `parts` lack the FTS bit, in batches of about 100.
- Cap indexed body text at about 16 KB. A 16 KB cap made the index 18% smaller (766 vs 932 MB) and commits 18% faster. Hits for terms buried deep in long newsletters fell 9-20% (common term 57,122 → 52,163; mid 5,846 → 4,675) [V]. Subject and people are always indexed in full. Under this size distribution, roughly 10% of messages have more than 16 KB of text [I].
- Keep it in the main database. A separate droppable FTS database would give up atomic consistency with `changes` and messages: in WAL mode, a transaction across ATTACHed databases is atomic per file but not across files (sqlite.org/wal.html). The index can be rebuilt by clearing the FTS bit instead.
- Set `secure-delete` only if deleted-mail recovery from the file is a threat (sqlite.org/fts5.html).

**Compression.** zstd level 3 through `node:zlib`: 3.83x, 360 MB/s to compress and about 1 GB/s to decompress, 0.015 ms to decompress a median body [V `compress.mjs`]. Brotli 4-6 is only 2-8% smaller and 3-5x slower. zstd is Experimental in Node 24, so keep a codec id per row and a gzip or none fallback. Mobile must supply the codec through a port or store `codec=0` [I].

**Retention and eviction.** Metadata, labels and the FTS index are cheap and stay forever. The FTS index keeps evicted mail searchable, because contentless FTS does not need the body. Bodies are what grow (about 7 KB stored per message here). Suggested policy [I]:
- keep bodies for 90 days plus anything opened, starred or unread;
- cap total body bytes (for example 2 GB) with LRU by `last_read_at`;
- clear the body bit and refetch on demand;
- create the database with `auto_vacuum=INCREMENTAL` and run `incremental_vacuum` paced, so evicted pages return to the OS.

This is Mailspring's 90-day rule plus Nylas's size-capped LRU (`SYNTH` §5). At Gmail's quota, refetching a body costs 20-60 units, so eviction must not be aggressive.

**Encryption at rest.** Not now. FileVault already protects the powered-off case. SQLCipher-class encryption would protect against same-user processes and stray backups, but costs 2-4x on writes, 6-14x on cache-missing reads, and a driver change. If the owner later requires it, prefer:
- bs3-mc with ChaCha20 (cheaper than AES-CBC plus HMAC-SHA512 on this M1);
- a raw 256-bit key, unwrapped from Keychain by main exactly as `engine-key.bin` works today, with no KDF at open. A raw key opened in 0.1-0.2 ms; a passphrase took 148 ms (SQLCipher v4 PBKDF2) or 25 ms (ChaCha20 default). A wrong key fails at the first read with `SQLITE_NOTADB` [V `probe-open.mjs`];
- a larger page cache, since mmap is unavailable with a codec [I].

Encrypting only body BLOBs in JavaScript (AES-GCM) would keep `node:sqlite` but leave subjects, senders and the FTS index (which can reconstruct text) in plaintext [I].

**Daemon runtime.** Nothing in this storage design depends on Electron. The SQL work is identical in plain Node, and the cold open costs about 10 ms in-process. If the daemon runs as a separate Node binary, ship a pinned runtime, or use better-sqlite3 for a pinned SQLite. This matters because `gaps/macos-daemon-lifecycle.md` recommends turning the RunAsNode fuse off, which removes "Electron binary as Node" as the host. One writer connection belongs to the daemon. UI or API reads can use worker-thread read connections.

**Mobile.**
- The schema, the FTS row ordering and the date-ordered rowids are all plain SQLite and port as they are.
- Risks:
  - op-sqlite's "one connection per database" and "`executeSync` not available in transactions" conflict with the engine's synchronous `BEGIN IMMEDIATE … COMMIT` port. Prove this on a device before committing to op-sqlite. expo-sqlite's `withTransactionSync` fits the port more naturally.
  - `contentless_delete` needs SQLite 3.43 or later, so never use an OS-provided SQLite.
  - FTS5 must be explicitly enabled in op-sqlite.

## 7. Risks

- **Synthetic data.** Compression ratios, FTS term distributions and thread shapes are modelled, not real. Validate with one real mailbox's statistics (sizes and counts only, no content) before fixing caps.
- **Single runs on a shared machine.** Treat differences under about 10% as noise. The cold opens were warm-cache.
- **`node:sqlite` is RC, and its SQLite version follows Electron.** An Electron bump can change SQLite and compile options. Pin a CI check of `sqlite_version()` and the required options.
- **Date-ordered rowids** mean a wrong provider date gives a wrong id. Use the provider's internal date, and treat the id as opaque.
- **WAL growth** under always-on readers, such as a daemon serving several clients, needs a supervisor.
- **better-sqlite3's Node-API port is three months old.** v13.0.2 fixed "process aborting from terminating worker threads" (GitHub releases).

## 8. Open questions

1. Does the owner's threat model require encryption beyond FileVault (shared Mac, Time Machine to an unencrypted disk)? The answer decides the driver.
2. What body retention does the owner want offline, given that Gmail quota makes refetches cost 20-60 units?
3. Store raw MIME (one parser for every provider, as Stalwart suggests) or sanitized HTML? This changes body sizes and the compression ratio.
4. Can op-sqlite run the engine's synchronous transaction port on a device, or should mobile target expo-sqlite?

## Sources

- Node 24 `node:sqlite` and `node:zlib` docs: nodejs.org/docs/latest-v24.x/api/sqlite.html and zlib.html
- SQLite FTS5: sqlite.org/fts5.html. SQLite 3.53.4 amalgamation, read only, inside the better-sqlite3 13.0.3 tarball (`deps/sqlite3/sqlite3.c`)
- better-sqlite3 releases: github.com/WiseLibs/better-sqlite3/releases. Tarball files: `binding.gyp`, `deps/defines.gypi`, `lib/binding.js`
- better-sqlite3-multiple-ciphers 13.0.3: README and `deps/sqlite3/sqlite3.h`. SQLite3MC architecture docs: utelle.github.io/SQLite3MultipleCiphers
- op-sqlite: github.com/OP-Engineering/op-sqlite and op-engineering.github.io/op-sqlite/docs/installation and /api
- expo-sqlite: docs.expo.dev/versions/latest/sdk/sqlite
- Sibling research: `SYNTH-architecture.md` §5 and §11; `arch/deltachat-core.md`, `arch/tuta-desktop.md`, `arch/inbox-zero-client.md`, `arch/mailspring.md`; `gaps/macos-daemon-lifecycle.md`; `gaps/engine-contract-rpc-stack.md`; `research/inbox-zero/aplos-architecture.md` §2
- Aplos (read only): `apps/desktop/src/engine/sql.ts`, `src/main/store.ts`, `scripts/mailbox-benchmark.ts`, `package.json` (`build.asar`), `DECISIONS.md` 2026-10-15
