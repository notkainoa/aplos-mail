# Plan 007: One test opens a real email through the composed engine, end to end

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- apps/desktop/src/main/engine-utility.ts apps/desktop/src/host/compose.ts apps/desktop/tests/eng-host/compose.test.ts packages/engine/src/mail packages/engine/src/methods/mail.ts`
> `engine-utility.ts` and `methods/mail.ts` are **expected** to have changed
> (the fix this plan depends on). Check only that the `realHostPorts` function
> described below exists; anything else that contradicts the excerpts is a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (test-only)
- **Depends on**: the in-flight "fix email bodies" work (branch
  `rv/fix/email-bodies`, adds `realHostPorts()` to
  `apps/desktop/src/main/engine-utility.ts`). Do not start until it is merged
  into `revamp`.
- **Category**: tests
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Claude Sonnet 5.5 (test wiring across several modules)

## Why this matters

Opening an email is the reason the app exists, yet no automated test runs it
through the engine **as the app composes it**. Each piece is tested alone:
`packages/engine/tests/mail/frame.test.ts` drives `Mail/frame` over a
hand-built store with an injected sanitizer, the sealed frame has browser
specs, the Gmail adapter has sync rigs. The seam between them is untested, and
that is exactly where the owner's "Couldn't load this email" on every HTML
message came from: the real composition (`realComposeOptions` in
`apps/desktop/src/main/engine-utility.ts`) never passed the `html` port, so
`MessageBody/get` answered `unavailable` for every HTML body, and every test
still passed. The fix thread adds a narrow pin that the ports exist; this plan
adds the end-to-end check that would have caught the bug by behaviour: sign in
to an emulated Gmail, sync, open an HTML email that was not yet fetched, and
get a sanitized document and its inline image back.

## Current state

- `apps/desktop/src/host/compose.ts` — `composeEngineHost(options)` builds the
  whole engine host. `ComposeOptions` (line 74 onward) takes `dataDir`,
  `fetch`, `clock`, `vault`, `googleClient`, `postNotification`, and an
  optional `ports` (extra host ports such as `html` and `images`).
- After the fix lands, `apps/desktop/src/main/engine-utility.ts` exports:

```ts
export function realHostPorts(): NonNullable<ComposeOptions['ports']> {
  return { html: mailHtml, images: createImageProxy() };
}
```

  and `realComposeOptions` passes `ports: realHostPorts()`.

- `apps/desktop/tests/eng-host/compose.test.ts:25-130` — a complete emulated
  world to copy: `createGmailEmulator`, `emu.oauth.addClient`,
  `emu.seedMailbox`, a `DraftBridge` fetch, `fakeClock`, `memoryVault`,
  `fakeBrowser`, then `composeEngineHost(options)` and `connectOwner(w, host)`,
  which signs in through `Account/connect` and pumps the fake clock until the
  actor starts. Key excerpt (lines 119-131):

```ts
/** Signs the emulated owner in through the engine's own `Account/connect`, and waits for the actor to finish its sync. */
async function connectOwner(w: World, host: Awaited<ReturnType<typeof composeEngineHost>>) {
  const session = host.engine.connect();
  const frames: Frame[] = [];
  session.subscribe(frame => frames.push(frame));
  await session.call('Account/connect', { provider: 'google', loginHint: w.address });
  const connected = () =>
    frames.find(f => f.frame === 'connect' && f.state === 'connected') as
      (Frame & { accountId?: string }) | undefined;
  await pump(w, () => connected() !== undefined, 'the sign-in to finish');
  const accountId = connected()!.accountId!;
  await pump(w, () => host.accounts.status(accountId)?.status !== undefined, 'the actor to start');
  return { session, accountId };
}
```

  `world`, `pump`, `withHost` and `connectOwner` are **not exported**; copy
  them into the new file (or, if the new file grows past ~250 lines, move them
  to a new `apps/desktop/tests/eng-host/support/compose-world.ts` and import
  from both files; then `compose.test.ts` is in scope for the import only).

- The emulator can add a raw MIME message:
  `packages/emulators/src/gmail/mailbox.ts:499` `addRaw(raw: Buffer, options: InsertOptions = {}): MessageView`.
- How the engine's own tests call the body methods and the frame server:
  `packages/engine/tests/mail/harness.ts:175-200` (`frameOf`, `tokenIn`,
  `serve`). Message ids look like `<accountId>:<remote message id>` (e.g.
  `'acct-1:nope'` in `packages/engine/tests/mail/frame.test.ts:107`).
- Body loading on a cold message: `packages/engine/src/mail/message.ts:72-86`
  (`loadBody` reads the store, else calls `services.accounts.openThread` on the
  interactive lane, then reads the store again).

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| The new test | `node scripts/audit/electron-node.mjs --import tsx --test apps/desktop/tests/eng-host/open-email.test.ts` | all pass |
| Existing compose test (if you touched it) | `node scripts/audit/electron-node.mjs --import tsx --test apps/desktop/tests/eng-host/compose.test.ts` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Desktop tests | `npm test -w @aplos/desktop` | all pass |
| Full gate | `npm run check` | exit 0 |

(`electron-node.mjs` runs Node with Electron's SQLite build, which the engine
needs; plain `tsx --test` may fail to open the database. If the desktop `npm
test` glob already picks up the new file and it passes there, that is fine
too.)

## Scope

**In scope**:
- `apps/desktop/tests/eng-host/open-email.test.ts` (create)
- optionally `apps/desktop/tests/eng-host/support/compose-world.ts` (create) and the import lines of `apps/desktop/tests/eng-host/compose.test.ts`

**Out of scope**:
- Any file under `apps/desktop/src/**` or `packages/**/src/**`. This plan adds
  a test only. If the test exposes a bug, report it; do not fix it here.
- Electron, the renderer and the sealed iframe (covered by the browser specs).

## Git workflow

- Branch from `origin/revamp` **after** the fix-bodies PR is merged:
  `rv/improve/007-open-email-e2e`.
- Commit style: `Tests: open an HTML email through the composed engine on emulated Gmail (improve 007)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Step 1: Confirm the dependency

**Verify**: `grep -n "export function realHostPorts" apps/desktop/src/main/engine-utility.ts` → one match. If none, STOP.

### Step 2: Build the world

Create `open-email.test.ts`. Copy `world`, `recording`, `pump`, `withHost` and
`connectOwner` from `compose.test.ts`. In `world`, before returning, seed one
extra message with `emu.mailbox.addRaw(Buffer.from(raw))` where `raw` is a
`multipart/related` MIME message from another sender to the owner's address
(`emu.users()[0].email`) containing:
- a `text/html` part with a paragraph `<p id="hello">Hello from the e2e test</p>`,
  a `<script>` element, an `<img src="https://tracker.example/p.gif">`, and an
  `<img src="cid:logo@test">`;
- an `image/png` part with `Content-ID: <logo@test>` and any small valid PNG
  (base64 of a 1x1 PNG is fine).

Keep the returned `MessageView` (its `id` and `threadId`). Pass
`ports: realHostPorts()` in `ComposeOptions` (import it from
`'../../src/main/engine-utility'`).

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Open the email the way the reader does

In one `test(...)`: `withHost(w, async host => { ... })`, `connectOwner`, then
pump until the account's baseline sync is done (see `accountBaselineDone` in
`compose.test.ts:259` for the check, or wait until `Thread/open` stops
answering `notFound`). Then, with `messageId = \`${accountId}:${view.id}\``:

1. `await session.call('MessageBody/get', { messageId })` → resolves (does not
   reject); `bodyKind` is `'html'`; the text contains `Hello from the e2e test`.
2. A window session: `host.engine.connect(...)` the way
   `packages/engine/tests/mail/harness.ts` makes its `windowA` (read
   `mailWorld` in that file for how a window caller is made). Call
   `Mail/frame` with `{ messageId, imagePolicy: 'block' }` → a `url` starting
   `aplos-mail://m/`.
3. Serve the document through `Mail/serve` as main's relay would: path `''`
   (empty) with the token from the URL and the calling window's id, exactly as
   `serve(w, frame.url, '', w.ids.windowA)` does in
   `packages/engine/tests/mail/frame.test.ts:41`. Assert: status 200, the body
   contains `Hello from the e2e test`, has exactly one `<script` (the frame's
   own reporter, which the engine appends: `html.split('<script').length === 2`;
   see `frame.test.ts:48-49`), so the mail's script is gone, and contains no `tracker.example`.
4. **After** the document (an inline part is `notFound` until the document
   has been served, `frame.test.ts:40`), serve `cid/0` → status 200 and
   `content-type` `image/png`.

**Verify**: the new test command → 1 pass.

### Step 4: Prove the test guards the real bug

Temporarily change `ports: realHostPorts()` in your test to `ports: {}` and run
it: step 3.1 or 3.3 must fail (that is the owner's bug). Revert the temporary
change.

**Verify**: with `ports: {}` → fails; restored → passes. Say so in your report.

### Step 5: Full gate

**Verify**: `npm run typecheck && npm test -w @aplos/desktop && npm run check` → exit 0.

## Test plan

The whole plan is the test. Pattern files: `apps/desktop/tests/eng-host/compose.test.ts`
(world and sign-in) and `packages/engine/tests/mail/frame.test.ts` /
`harness.ts` (frame and serve calls).

## Done criteria

- [ ] `apps/desktop/tests/eng-host/open-email.test.ts` exists and passes
- [ ] It fails with `ports: {}` (Step 4 evidence in the report)
- [ ] No file under `apps/desktop/src` or `packages/*/src` changed
- [ ] `npm run check` exits 0
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- `realHostPorts` does not exist on `revamp` (the fix has not landed).
- The emulator rejects the multipart MIME or drops the `cid` part: report
  what `emu.mailbox` stored; do not change the emulator.
- `MessageBody/get` or `Mail/serve` fails with the real ports in place: that is
  a real bug. Report the error type and reason code (no message content) and
  stop; it belongs to the reader thread.
- The test needs more than ~60 s of fake-clock pumping or real time to sync
  one message: report; do not raise timeouts blindly.

## Maintenance notes

- When the reader's load path changes (deduplicated `openThread`, cancellable
  fetches, cached inline parts; see `plans/improve/reader-load-notes.md`), this
  test is the regression net; extend it rather than adding a parallel one.
- Natural next steps once this exists: a second message whose body part is
  served only by attachment id, and a 429 injected into the emulator while
  opening (the "paused" case in the reader notes).
