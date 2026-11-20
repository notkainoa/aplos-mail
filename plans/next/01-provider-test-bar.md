# Job 1: a test bar for mail providers, and the list of Gmail-only leaks

## In plain English

Today only Gmail works in the new engine. Later, Outlook, iCloud, Fastmail and providers written by other people must plug in without changing anything above the engine. This job writes the tests any provider has to pass, proves Gmail passes them, and lists every place where Gmail-only ideas have leaked out of the Gmail code.

## What exists

- The plug-in point is already defined: `ProviderFactory` and `ProviderAdapter` in `packages/engine/src/ports/provider.ts`, with `Capabilities` saying what a host can do.
- The only real provider is `apps/desktop/src/host/providers/google/` (`adapter.ts` is the entry), wired in `apps/desktop/src/host/compose.ts`.
- `packages/emulators` is a fake Gmail and Google Calendar server with a fault kit and a fake clock.
- The engine's own sync tests are in `packages/engine/tests/`.

## Part A: the leak list (first pull request, a document only)

Write `plans/next/provider-leaks.md`. Search these for `gmail`, `google`, label ids such as `INBOX` and `CATEGORY_`, and Gmail-shaped assumptions:

- `packages/engine/src` (not `legacy/`), outside any provider folder;
- `packages/contract/src` (not `legacy/`);
- `apps/desktop/src/renderer` (not `legacy/`, not tests).

For each hit give the file and line, one sentence on what it assumes, and one of: `fine` (wording or a comment), `behind a capability` (already guarded by `Capabilities`), or `leak` (code that would be wrong for a provider with folders and no labels). For each leak, propose the smallest fix. Change no code in this part.

## Part B: the test bar (second pull request)

Add a reusable suite, `runProviderConformance(make)`, in a new folder `packages/engine/tests/conformance-provider/`. `make` returns a `ProviderFactory` plus a handle to a fake server it talks to. The suite must not mention Gmail. It checks, through the public port only:

1. connect, then a first sync that returns mail in pages and can resume after a stop;
2. an incremental sync that picks up new mail, a flag change and a removal;
3. opening a thread returns every message and body;
4. a flag change and a move made locally reach the server, once, and survive a retry;
5. a send is delivered once, and an interrupted send is found again instead of sent twice;
6. a throttled or failed request is reported with the right error class and never loses data;
7. the adapter only ever touches the account it was opened for;
8. every `Capabilities` flag the adapter sets to `false` is honoured (the suite skips that area and the adapter refuses it cleanly).

Then run the suite against the Google adapter on `packages/emulators`. If a check cannot pass without changing the adapter or the port, do not change them: mark it `todo` with the reason and list it in the pull request.

## Not part of this job

- Loading a provider written by a user. That waits for the block design.
- Porting Outlook, iCloud or Fastmail.
- Fixing the leaks from part A.

## Done when

- `plans/next/provider-leaks.md` is merged.
- The suite runs in `npm run test:engine`, passes against Google on the emulator, and each of the eight checks fails when its behaviour is broken on purpose (say how you checked).
- `npm run check` passes.
