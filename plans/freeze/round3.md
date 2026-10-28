# Freeze review round 3 (2026-10-28)

Two fresh Claude Opus verifiers checked the round-2 must-fix list ([round2.md](round2.md)) plus R2B-2 to R2B-6 and R2H-3 on PR #28 at a4a2a88. For each fix they reverted it in a temporary copy and confirmed its test then fails.

## In plain English

Almost everything holds. One new problem must be fixed before the freeze: a tool with limited permissions could undo the owner's discard of a waiting email and put the send back on schedule. Two test-mode problems are left, and the release app still honours two developer settings. Those are in app code that can change after the freeze, and they are assigned now so they're fixed well before any release build.

## Outcome

| Item | Verdict | What is left | Gate |
|---|---|---|---|
| R2H-1 | partly-fixed | The requirement to refuse 'any folder not created for the run' does not hold, for two reasons. (1) APLOS_TEST_ROOT (:66-67) is only checked to be absolute and to exist. With APLOS_TEST_ROOT=/ the probe accepted APLOS_DATA_DIR=/usr/local, and with APLOS_TEST_ROOT=$HOME it accepted ~/Library. tmpdir() also comes from TMPDIR, so TMPDIR has the same effect. (2) Paths are compared case-sensitively, and… | before the release candidate (eng-host) |
| R2H-4 | partly-fixed | The release bundle still honours APLOS_DATA_DIR. electron.cjs:987 (source apps/desktop/src/main/engine-host.ts:162) runs `engineInit(process.env.APLOS_DATA_DIR // app.getPath('userData'))`. So a release app launched with APLOS_DATA_DIR keeps its mail database and engine-key.bin in that folder, with no check, while Electron state stays in the real folder. That contradicts the 'ignores APLOS_TEST an… | before the release candidate (eng-host, plat-release) |
| R2G-1 / FR-31 | fixed |  |  |
| FR-20 | fixed |  |  |
| R2G-3 | fixed |  |  |
| R2G-4 | fixed |  |  |
| R2H-2 = R2B-1 | fixed |  |  |
| FR-7 | partly-fixed | Not blockers; each is a doc or additive fix. (1) plans/20-providers-sync.md:339 is the prov-gmail-write (PV4) brief, and it still says 'drafts.send when a remote draft exists'. A lane following its own brief rebuilds the hole, the same way the stale eng-time brief kept FR-2 open in round 2. Align it with ARCH 7.1. (2) sendsRemoteDraft passes when baseChangeKey is absent (provider.ts:567), but 0001… | docs fixed by the integrator; additive points to prov-gmail-write and eng-time |
| FR-2 | fixed |  |  |
| R2B-2 | partly-fixed | The same effect can still be reached through Operation/undo. A window's Draft/destroy of a held draft writes an undoable op (engine.ts:306 defaults undoable to true) that records scope 'draft'. A read+triage+draft socket listener can then call Operation/undo on it, and restore() (engine.ts:390-401) puts the Submission back in 'scheduled' and relocks the draft. The probe at /tmp/r3verify.ocNg/probe… | freeze: see NB-1 |
| R2B-3 | fixed |  |  |
| R2B-4 | fixed |  |  |
| R2B-5 | fixed |  |  |
| R2B-6 | fixed |  |  |
| R2H-3 | fixed |  |  |

## New blocker

### NB-1: A draft+triage tool can undo the owner's Draft/destroy and put a cancelled send back on schedule

- **Problem:** Operation.scope is frozen as 'the scope of the method that made it'. The stand-in records the dispatched method's base scope (callScope = def.scope). So when the owner discards a draft that has a held send, the Draft/destroy op records 'draft', even though that call needed 'send' under R2B-2. The op is undoable by default. Operation/undo (base scope triage, scopeRule originating) then needs only draft+triage, and restoring the before-images puts the Submission back in 'scheduled' with the draft relocked. A socket or HTTP listener without 'send' can therefore re-arm a send the owner discarded. In the real engine, sub_due would then send it at not_before. This is the 'cheap scope reaches a dearer effect' pattern that FR-3 and R2B-2 removed, reached by another path. MCP is not affected (Operation/undo is not in mcpMethods). It is a safety hole and should be settled before the freeze: the frozen meaning of Operation.scope decides it, and every real lane will follow that meaning.
- **Evidence:** packages/contract-fixture/src/engine.ts:306 (undoable defaults to true), :313-316 (scope = opts.scope ?? callScope), :735 (callScope = def.scope), :390-401 (restore puts the 'before' rows back); packages/contract-fixture/src/methods/compose.ts:278-289 (Draft/destroy requires send but writes without scope:'send' or undoable:false); packages/contract/src/schemas/mail.ts:265-272 (Operation.scope = 'the scope of the method that made it'); packages/contract/src/api/mail.ts:175-183 (Operation/undo scope triage, originating). The probe at /tmp/r3verify.ocNg/probe1.ts was run with tsx in a temp copy. Window: Submission/set send with notBefore +1h, then Draft/destroy, whose op records scope 'draft'. A listenerCaller with ['read','triage','draft'] then ran Operation/undo, which passed. Submission state went from 'cancelled' back to 'scheduled', and draft.submissionId was restored.
- **Fix:** Freeze that Operation.scope is the strongest scope the call actually required, including a scopeRule elevation. A Draft/destroy that cancelled a live send records 'send', the same way Ask/decide already does for guests (ai.ts:550-556). In the stand-in, pass `scope: sub ? 'send' : undefined` (or make that write undoable:false) at compose.ts:286. Reword the Operation.scope doc at mail.ts:265-271. Add a conformance case in which a draft+triage listener's Operation/undo of a window's held-draft destroy is refused.

## Verifier summaries

Round 3 check of PR #28 at a4a2a88, my items only. Four are fixed: R2G-1/FR-31, FR-20, R2G-3 and R2G-4. Their tests pass, and each fails when I revert its fix in a temp copy. R2H-1 and R2H-4 are partly fixed. Neither leftover needs a v:1 contract change, and the fixes add no new blockers.

**R2H-1, test mode's data-folder check.** It refuses /, home, the temp root, the exact real and preview folders, symlinks, relative paths and `..`, and the real mailbox is also protected by its key file. The gap is the new APLOS_TEST_ROOT escape hatch, which accepts any existing folder as the root (TMPDIR has the same effect). With APLOS_TEST_ROOT=/ or $HOME, test mode accepted /usr/local and ~/Library. Because path checks are case-sensitive, it also accepted a lower-case path to the real Preview folder. I reproduced all three with the real function on the real filesystem.

**R2H-4, test mode in release builds.** I built a release bundle (APLOS_RELEASE_BUILD=1) in a temp copy. APLOS_TEST does nothing there (electron.cjs:501, `compiledIn = false`). But the bundle still honours APLOS_DATA_DIR at electron.cjs:987 (engine-host.ts:162): it moves the engine's mail database and key file to that folder, unchecked. That contradicts DECISIONS.md:5 and plan 40's verify-hardening rule.

**Smaller leftovers.** On R2G-1, an explicit uidValidity: null, which the port docs say clears the value, still makes the next real UIDVALIDITY change fail with the UNIQUE error (reproduced); no adapter sends null today. On FR-20, contract schemas/calendar.ts:43 still describes occurrence ids in the old UTC-only form.

**Outside my items.** The release bundle also honours APLOS_RENDERER_URL (electron.cjs:25). I worked only in temp copies, deleted them afterwards, and the candidate checkout is unchanged.
Seven of my nine items hold, and FR-7 and R2B-2 are only partly fixed. I checked every fix in a temp copy of a4a2a88 (contract 217/217, stand-in 26/26, engine 84/84, typecheck clean) and reverted each one: every revert makes its test fail. R2H-2/R2B-1, FR-2, R2B-3, R2B-4, R2B-5, R2B-6 and R2H-3 are fixed. FR-7's code and port fix holds, but the prov-gmail-write brief (plans/20-providers-sync.md:339) still says to use drafts.send whenever a remote draft exists. A few additive points remain, such as Graph's change-key precondition having no store column. There is one new blocker (NB-1). The frozen rule records an operation's scope as the base scope of the method that made it. So the owner's Draft/destroy of a held send records 'draft', and a socket or HTTP tool holding only draft and triage can undo it and put the cancelled send back on schedule. The probe at /tmp/r3verify.ocNg/probe1.ts reproduced this. That is why R2B-2 is partly fixed. The fix is to record the scope the call actually required ('send' here), or to make that destroy non-undoable, and add a conformance case.
