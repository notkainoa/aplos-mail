# Integrator 3 handoff (written 2026-11-04 ~15:20, for a fresh Integrator 4)

Read `plans/STATUS.md` (append-only, newest at the bottom), this file, and `plans/integrator/HANDOFF.md` (older background). Standing owner rules still apply: never merge to main, publish, send external mail, change repo visibility or rotate credentials; never print keys; commits are authored as Kainoa Newton <k@kainoa.me> and end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; headless only (no visible windows, no Cua foreground).

## Where things stand

`revamp` carries everything through #277, #273 and #276 (merged 64a17495; #275 closed as contained in it). The owner decided on 2026-11-04: the live Gmail send check is SKIPPED (nobody asks for the OAuth secret); a second merge lane, "Revamp: Integrator UI" (SWE-2), merges pure-UI PRs (so #272 and #279 and the other screens are NOT yours: do not touch them); Opus final review only for send / auth / tokens / storage-commit / contract / freeze paths; findings that cannot be reached today become follow-up tickets (a NOTICE line: lane + one line), not blockers; ONE fix round, then merge; the owner wants real Gmail on the spare account around Nov 8-9.

### Open PRs when I stopped (heads are the author's; resolve-decisions.sh pushes a merge head on top)

| PR | Head | What it is | Waits on |
|---|---|---|---|
| #276 | MERGED 64a17495 | eng-html WP3 mail gaps (body codec default, htmlToText, global remoteImages, allowImages audit row; contained #275's commit). One extra engine-3 commit (7cde01c8, entity regex + readRemoteImages pins) landed after my checked head: I verified revamp after the merge (engine tsc clean, mail/outbox/host tests 89/89, bundle 437,522 B) | done |
| #275 | CLOSED | contained in #276 (comment posted) | done |
| #278 | f5e754fd | eng-time: isEmpty shares emptyMarkup + mutation pins (a #274 follow-up, draft-state.ts) | READY line + check + a read of the delta (draft path; Opus only if isEmpty semantics widen) |
| #281 | ce48a175 | eng-html: ProviderPort.original gains `{signal}` and the unavailable mapping | CORRECTION (engine-3, after I wrote this): the huge diff was the PR opened against base=main by mistake; it is retargeted to revamp and now reads about 3 files / ~132 lines. Verify the base is revamp, then check + a delta read. Port change = additive optional argument (contract-adjacent: Opus delta read) |
| #280 | 73e8898d | DECISIONS: Event/set series scope on an occurrence id shifts time fields (13 lines, docs) | a read; no READY line seen |
| #282 | ad87db23 | eng-host HANDOFF: audit_log age-out + target redaction follow-ups (7 lines, docs) | a read |
| #279 | ed23df96 | F6 Calendar (UI-only) | NOT YOURS: the UI integrator lane |

### Gates before APLOS_ENGINE=real (the owner's priority)

1. #270 Message/original: MERGED (1081ec96). 2. Gmail `original()` (providers-4): #273 MERGED (bab8a15e). 3. #276 mail gaps: see above. 4. #281 original abort signal (non-blocking but wanted). 5. ui-reader's `mail-key` wiring (I posted the requirements: handle `aplos:mail-key` only when the sealed iframe is `document.activeElement`, match on the key letter not the shift flag, Escape must not close Compose/dialogs; STATUS has no READY for it) and `sealed.browser.spec.ts:330` forgery string (replace `host.postMessage(`), both ui-reader. 6. The owner's packaged-app hand-check (J/K acts once, the sealed letter is its own process in Activity Monitor, mailto/https links route). Engine bundle: 437,522 B of 450,000 (12.5 KB left after #276): watch it (see gotchas); every engine PR should report its size.

## Standing Opus-gated list (my own final review, a foreground `Agent` with model opus and a long brief)

Send path and send guard (`outbox/*`, prov-gmail send/draft MIME headers), draft sync and draft data-loss (fingerprint, echo, adoptCopy), anything in the store commit path (`store/*`, `runtime/blobs.ts` held/FR-7), host file stores (`host/blobs.ts`, `host/files.ts`), the sealed frame (reporter, sanitizer, reading CSS, relay, key relay, link classifier), auth/tokens/vault/keyring, SSRF/image proxy, contract and freeze (`contract-v1` is frozen: only additive/optional changes within v:1), audit log. Everything else: my own read plus the local check.

## Merge rules and gotchas that actually bit me

- Gate = the local full check (GitHub Actions was down for a long time; PR-triggered checks only show Macroscope/CodeRabbit). Every PR: `sh ~/.cache/aplos-integrator/resolve-decisions.sh N` (unions DECISIONS.md and plans/STATUS.md, merges revamp into the PR branch and PUSHES a new head; prints `OTHER CONFLICTS: <files>` and aborts on anything else, then resolve by hand in a scratch worktree), then check THAT head, then merge head-guarded.
- Merge: poll `gh pr view N --json mergeable` until MERGEABLE (UNKNOWN is common); `gh pr merge N --squash --match-head-commit <FULL SHA> --subject ... --body ...`; verify `gh pr view N --json state` is MERGED BEFORE posting a MERGED line (I once posted early). The resolver pushing a new head makes `--match-head-commit` refuse: re-read the head, confirm the delta since the checked head is only STATUS/DECISIONS/revamp content (`git diff --stat <checked> <new>`), merge again.
- Known load flakes (machine load 20-45): calendar fuzz oracle, `drafts.inline` 1 MB linear time, `drafts.echo` fingerprint timing, mail-html corpus p99 / 20,000 style attributes / "long run of [", `hillclimb-lock` race in test:audit, kill-point matrix cells, `messageBytes`. Rerun the one test solo (`npx tsx --test <file>` from the package dir): if it passes alone, note it in the MERGED line and merge. `test` runs BEFORE `build` in check-multi, so tests that read `dist/` can read a stale build. The reviewer environment's borrowed node_modules shows env-only failures (mail-html frameset 050 x2, bundle size): ignore those there.
- A real failure is a real failure: the engine bundle budget test (`packages/engine/tests/portability.test.ts`, 450,000 B) caught a contract-ROOT value import pulling zod (+100 KB). Engine files import values from `@aplos/contract/contract-error` and use `import type` for the rest.
- Owners step: `plans/OWNERS.md` is mine; the check reads OWNERS from the BASE, so a PR that adds its own OWNERS row still fails once (add the row to revamp first, or approve with `--approved`). Acting lanes must be real lane names (a made-up lane aborts the step with "unknown lane"). Approve cross-lane tsconfig/eslint-suppression/docs edits with `--approved plat-ci,integrator,...` only for what is needed (find it by narrowing `node scripts/audit/owners-check.mjs --base origin/revamp --head HEAD --lane X --approved Y`).
- NEVER `rm -rf` a path built from an unquoted zsh variable (zsh does not word-split; I once deleted 69 worktree folders). Guard every removal with an exact-path `case`.
- Kill a check properly: `kill -9 $(pgrep -f "check-multi.sh N")` (pkill alone left the chain), then `rmdir /tmp/aplos-integrator/check.lock` (or `check2.lock`).
- Pushes to revamp race with other lanes: `git pull --no-rebase origin revamp`, union-resolve `plans/STATUS.md` conflicts, retry. GitHub throws transient 500s.
- STATUS line format (queue.mjs parses it): `YYYY-MM-DD HH:MM | integrator | TYPE | <lane or -> | text`, TYPE in MERGED, REQUEST, NOTICE, DECIDED, PARKED, HANDOFF-READY; REQUEST/NOTICE text starts `to <thread>:`.
- Reviewers: name a model on every subagent; at most 4 concurrent; brief Opus with the previous findings and "try to break it"; ask for mutation tables and own probes; judge finding by finding whether it is reachable NOW (block) or not (ticket). Stop my own check when an Opus verdict is FIX (it cannot merge).
- A subagent once downloaded Electron into `rv-integrator-check2/node_modules/electron/dist` despite "no network": left in place.
- `WAITING ON OWNER:` lines must end the final message when blocked on the owner; "waiting on you" is a banned phrase (DESIGN 10).

## Commands that work

- Worktrees (all under `/Users/knewton/.t3/worktrees/aplos-mail/`): `rv-integrator-check` (script `check-multi.sh`), `rv-integrator-check2` (`check-multi2.sh`), `rv-integrator-live` (live runner, pinned to a revamp SHA), my thread worktree `rv-thread-integrator-3`. If one vanished: `git worktree prune; git worktree add --detach <abs path> origin/revamp`.
- `cd ~/.cache/aplos-integrator && nohup sh check-multi.sh <pr> <branch-lane> <sha8> <acting-lanes,> <approved-lanes,> > /tmp/aplos-integrator/pr<N>.out 2>&1 &` (ONE chain per worktree; macOS has no setsid; results in `/tmp/aplos-integrator/pr<N>.txt` as `merge= install= format:check= lint= test:lint= test:audit= lint:css= typecheck= test= owners= build=`, logs `pr<N>-<step>.log`). Wait with `timeout 590 bash -c 'until grep -q "^build=\|^stopped" file; do sleep 15; done'`.
- Reviewer unit-test recipe: `git archive <sha> | tar -x -C /tmp/<dir>`, node_modules from `rv-integrator-check2/node_modules` with `@aplos/*` linked to the copy's own packages, `npx tsx --test <files>`, delete the temp dir.
- Thread hygiene: `mcp__t3-code__t3_thread_organize` (unsettle when work arrives, settle when parked; a settle applies at turn end).
- Live runner (tiers, guard, state files) is documented in `plans/LIVE-RUNS.md`; the owner SKIPPED the last live send check, nothing to run.

## Follow-up tickets (not blockers; each is a NOTICE/REQUEST already in STATUS unless noted)

- eng-host: `audit_log` has no prune/cap (a looping listener wrote 1,000 rows in 1 s) and its `target` holds a sender address: age-out by `at`, redact in any export (#282 is the note).
- providers-4: Gmail `original` response has no size cap on `response.text()` and holds ~4.6x the decoded size (a 45 MB message ~210 MB per call); drop the copy in `fromBase64Url` (return the Buffer).
- ui-reader: no host freeze "after N reports of any kind" (it would freeze letters during resizes): exempt width-changed reports if `reports.ts` is touched; `mail-key` wiring and the forgery-spec string above.
- engine-3: #274 follow-ups (an `&amp;`/`&lt;` pin, DECISIONS line on ignored attributes on empty containers, the image-only `isEmpty` quirk, maybe covered by #278); `isEmpty` now treats bodies of only `<svg>/<title>/<select>/<iframe>/<object>` as empty (accepted); per-message `Message/original` blobs are reused per (principal, message).
- hostile-letter lows (availability only, bounded by the host's 200,000 px clamp and 100-step growth freeze): font-size/font-size-adjust on html/body from the mail's own style; Node-side note that `htmlToText` re-derives per call (~1-2 s for a hostile 5 MB body).
- Reachable only with a future listener transport: per-client quotas assume stable owner-granted client ids.
- Owner optional tidy-up of the spare Gmail account (Drafts `aplos-live-probe 2026-11-04`, Sent/Inbox `aplos-live-probe-send ...`); blocks nothing.

## Next 3 actions for Integrator 4

1. (Done at the park: #276 merged and #275 closed.) Check that eng-host knows #275 is closed and rebases nothing.
2. Triage #281 first (the +500,655-line diff is not source: send it back), then #278 (check + read the delta), then #280/#282 (docs reads). Post MERGED/REQUEST lines as usual.
3. Chase the gates: ping ui-reader for the `mail-key` wiring READY, make sure the owner's packaged-app hand-check list is in front of them (STATUS NOTICE 05:xx), and post the exact remaining gate list + ETA when the owner asks for real Gmail on the spare account (~Nov 8-9). Keep UI-only PRs with "Revamp: Integrator UI".

## Added after the park (notices from integrator-ui)

- `plans/STATUS.md` now merges as a UNION via `.gitattributes` on revamp: append lines freely and never edit an existing line in place (a correction is a new line). `LIVE-RUNS.md`, `RESUME.md`, `PROGRESS.md`, `DECISIONS.md` and `TODO.md` are NOT union (`resolve-decisions.sh` still unions DECISIONS.md and STATUS.md by hand for my merges: with the gitattributes rule the STATUS part should just work).
- `allow_auto_merge` is false on the repo, so `gh pr merge --auto` is unavailable: green PRs merge on integrator turns, after the review ladder and the local check.

## Local CI (from Platform 3, 2026-11-04; the owner will not pay for GitHub Actions)

`scripts/local-ci.sh <ref> [--package] [--no-e2e] [--no-web] [--keep]` runs every ci.yml job in a scratch worktree (usage in `plans/integrator/LOCAL-CI.md`). Owner rule: run it on the head of every Opus-gated or engine PR before merging, and once per day on `origin/revamp`. Roughly 17 minutes. First daily run: `origin/revamp` at dd63b32b was all green. Do not wait on or re-run GitHub CI; the `plat-ci` label is not a merge gate.

## Process slip to avoid (2026-11-05)

Twice I chained `owners-check ...; resolve; merge` in ONE command, and the merge ran although owners-check had printed FAIL (the chain used `;`, not `&&`). Both were benign (plans/STATUS.md; eng-contract's calendar.test.ts, which I had read), but run owners-check as its own step, READ its last lines, and gate the merge on it: `node scripts/audit/owners-check.mjs ... --approved <lanes> && echo OWNERS-OK` then merge in a separate call. Always include `plat-ci` (for plans/STATUS.md) and `eng-contract` (for packages/engine/tests/**) in --approved when the PR touches them.

## Direct pushes to revamp (2026-11-05 slip by platform)

`git push origin HEAD:revamp` from a feature branch lands the WHOLE branch (platform's f8105204). Before any direct push of STATUS lines run `git log --oneline origin/revamp..HEAD` and push only if every listed commit is a STATUS or HANDOFF commit; otherwise open a PR. My own thread branch (rv/thread/integrator-3) holds only STATUS/OWNERS/HANDOFF commits and `git pull --no-rebase origin revamp` merges, so the push is safe there.

## Gate the merge on the head you CHECKED (2026-11-06 slip on #346)

`resolve-decisions.sh` pushes a merge head, and the PR author may ALSO push new commits while CI runs. On #346 two providers commits (a live gcal tier-R probe, a sign-in scope change) arrived after my CI and my `git diff --stat` printed them only AFTER the merge command in the same chain. Before `gh pr merge`: `git log --oneline <checked-sha>..<head-to-merge>` and read every commit that is not a `Merge ... revamp` or a STATUS commit; if there is one, either run the check on the new head or read the delta first. Do the diff in a separate call BEFORE merging, not in the same chain.

