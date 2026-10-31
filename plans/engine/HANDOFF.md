# Engine thread handoff (rewritten 2026-10-31 for a fresh Engine thread)

The Engine thread runs the engine lanes (eng-store, eng-views, eng-contract, eng-time, eng-ai, eng-html, eng-host) from one worktree. Rules that bind: never merge to `main` (never PR #21), never publish, send real mail, change visibility or rotate credentials; never force-push; no bare `git stash`; guard every `rm -rf`; commits as Kainoa Newton with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; headless only. Routing (roadmap 5.1a): quality first; Devin SWE-2 for well-specified non-UI code, tests and first-pass reviews; Sonnet for tricky logic and the one Claude review per PR; Opus for contract changes, security code, store commit path and a data-loss review of anything that can overwrite or delete the other device's copy. Name the model on every subagent.

## State (everything below is on `revamp` unless stated)

Merged since the last handoff: store, views, clock/time, notifications (#147, #150, #154 retry timer and banner text), html image proxy and tests (#131, #137, #148, #155 flake fix), the whole draft-port series (#153 gaps 3 and 4, body delivery, `supersedes`; #157 `DraftUpload.supersedes`; #159, #160 bundle cut; #161 sender; #162 inline parts; #163 deferral note; #164 `adoptCopy` only for proven-ours copies). `packages/contract` was never changed (all port changes are additive and optional inside `v:1`).

Open and not mine: **#156** (providers, Gmail adapter for the draft ports; waiting on their duplicate-header fix) and **#158** (superseded by #156, to be closed). Nothing of mine is open. Branches I leave behind are merged and can be deleted: `rv/eng-contract/*`, `rv/eng-time/*`.

## What the draft engine now guarantees (read DECISIONS.md, sections 2026-10-30/31 "draft port gaps", "BINDING")

One rule runs through ten Opus rounds: the other device's only copy, or a sent message, is never silently overwritten, deleted or resurrected; an unexplained difference is a conflict, never a guess. Concretely: `remove` carries the expected message id; a copy is taken as ours (echo, adoption, base move) only with a closed-world content proof (`DRAFT_CONTENT_FIELDS` in `outbox/draft-state.ts`, `outbox/draft-proof.ts`); a clean draft is never replaced silently when it holds a Bcc, attachments, `signatureSource`, or the copy changes the sender or carries inline parts (`cid:`); `_sync.earlier` / `prints` / `wrote` remember given-up attempts; two rows never share a remote draft.

## Budget and hygiene

Engine bundle (portability test, minified, `legacy/` excluded): 391,352 of 400,000 bytes. Measure per file with esbuild `bytesInOutput` on the test's own bundle before cutting; the big real code is sync, store, outbox. Run ONE `npm run check` at a time, in the background with a done-file; `npm run check` stops at the owners step for cross-lane files, so also run `format:check`, `lint`, `typecheck`, `test:engine`, `npm test`. Cross-lane files need `Lane-Approved: <lane>` trailers on every commit or a PR label `lane-approved:<lane>`. DECISIONS.md is append-only with dated headings (use the machine date). STATUS.md: pull first, append, push at once, then check `grep -cE '^(<<<<|====|>>>>)' plans/STATUS.md` is 0. The Integrator merges with a head guard; after a push, post READY with the new head. Settle your own thread when parked.

## Next actions, in order

1. **Draft-sync wiring** once providers' #156 is on `revamp` (the Integrator then runs the end-to-end Opus review). Put the Integrator's four LOW follow-ups from #164 into the same change: compute `holders` whenever `row.remote_draft_id !== w.remoteDraftId` (`synced`); drop an unproven shown copy's id from `earlier`; require `hasAttachments === false` in `showsEveryField` (adapters must always report attachments); `sameCopy` should also refuse a shown copy that is already `sent`.
2. **Before the Graph or IMAP/JMAP draft sync is wired:** Graph keeps the message id across edits, so `sameCopy` / `remote_message_id` equality needs a change-key comparison; alias comparison and the known `cid:` gaps are decided (DECISIONS: deferred on purpose, trigger recorded).
3. **eng-host:** host-1 to host-3 and the composition root that wires power, reminders and notifications (`apps/desktop/src/host/notifications.ts` exists and is merged, not yet connected to `src/main`, which still runs the legacy engine).
4. **eng-html:** sanitizer html-3/html-4 and the Opus security review (sanitizer and proxy are security code).
5. **eng-ai:** ai-3 onwards (jobs, Ask, providers, `eval:groq`/`eval:ask` dev and held-out splits per roadmap 5.1c). **eng-views:** views-5 is blocked on the conformance runner (UI/integrator).
6. **Small follow-ups listed in DECISIONS:** `onAccountRemove` hook, `views/remote.ts` pass `partial`, `file_removals` drain, `Draft/set` close flag, the notification claim-loop wiring.

Lane cards: `plans/lanes/eng-{store,views,ai,time,html,host}.md`; lane plan `plans/engine/phase1-lanes.md` (seams at lines 76-100, eng-time at 313-384). Test with `npx tsx --test <paths>`; engine suites live in `packages/engine/tests/<lane>/`, host tests in `apps/desktop/tests/<lane>/`. Do not poll or sleep; use background commands with done-files. Known flake to watch: `apps/desktop/tests/calendar-recurrence-fuzz.test.ts` hung once for 58 minutes (not mine, rerun passed).
