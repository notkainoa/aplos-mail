# Providers thread: handoff (lean mode, Linux, written 2026-10-31 evening)

> **What this means:** the lease, workflow channel, token source, sign-in flow, Account handlers and vault are merged. The Gmail write side (send, filters, drafts) is built. A few PRs are open or about to open; the fresh thread finishes them, then waits on other lanes.

Linux: `source ~/.nvm/nvm.sh && nvm use 24`. Worktrees under `~/.t3/worktrees/aplos-mail/`. A new worktree needs `cp -a ../rv-prov-gov/node_modules ./node_modules` and then `npm install --no-audit --no-fund --ignore-scripts` (the #104 scorer devDeps). **STATUS posting:** `/tmp/status-post.sh "<line>"` (appends to origin/revamp from the throwaway worktree `rv-prov-status`; recreate with `git worktree add --detach ../rv-prov-status origin/revamp` and the script body: fetch, checkout origin/revamp, append, commit, `git push origin HEAD:revamp`). Full `npm run check` takes 10-25 min: run it in the background with `timeout: 3600000` writing `/tmp/<name>.log` plus an `exit N` line, wait with `until [ "$(pgrep -f '^npm run check' | wc -l)" -eq 0 ]; do sleep 20; done` (never `sleep` alone). Known load flakes (engine-owned, pass alone): `packages/engine/tests/outbox/killpoint.test.ts` (two rows), calendar `splitFollowing` (loosened in #102). `/tmp` is a 7.5 GB tmpfs: tests must remove their scratch dirs; the owner approved clearing `/tmp/{aplos-,ui-,f-,h-}*` older than 4 h.

**Model routing (roadmap 5.1a, corrected 2026-10-31):** every subagent names a model; Sonnet by default and for every review; Opus ONLY for contract changes, security code (auth/tokens/credentials, send guard), store commit path, sync correctness and the final review of those; Devin SWE-2 (`delegate_task`, `acpRegistry_devin`, `swe-2-high`) for well-specified non-UI code. This thread overspent Opus: use SWE-2/Sonnet first, and settle each delegate child thread after using its result.

## PR state

Merged: #53 #56 #59 #38 #65 #67 #69 #70 #72 #71 #73 #75 #78 #81 #86 #90 #91 #92 #95 #100 #101 #102 #127 (lease D1-D3) #128 (filters) #129 (Gmail send + findSent) #132 (vault temp name).

Open / to open (check `gh pr list --state open` first):
- **#133** killpoint-gmail (Gmail send adapter through the engine kill-point harness, test-only): open, READY.
- **#135** vault grace tests deterministic: open, READY.
- **#136** Gmail drafts API: open, READY (check green).
- **Built, check was running (logs `/tmp/sf-c.log`, `/tmp/lf2-c.log`, `/tmp/hd-c.log`, each ends with `exit N`):** (a) `rv-prov-sf` branch `rv/prov-gmail-write/send-followups` = #129 follow-ups (redirect manual, log, DECISIONS, 4 tests, SENT-list fallback in findSent); (b) `rv-prov-lf2` branch `rv/prov-gov/lease-followups2` = #127 follow-ups (clock set back, restart mid-lift real bug, forgotten own copies re-read); (c) `rv-prov-hd` branch `rv/prov-gmail-write/http-delete` = `GmailRequest.httpMethod` admits DELETE and filters.ts drops the cast. For each with `exit 0`: `git push -u origin <branch>`, `gh pr create --base revamp` (body: what, tests, models: Opus wrote lease/send parts, Sonnet reviewed), `link_pull_request`, post HANDOFF-READY. (a) and (b) are sync/send-adjacent: the Integrator gives them an Opus review.
- **`rv/prov-gmail-write/unsub`** (pushed, no PR): List-Unsubscribe executor (33 tests), BLOCKED: it reuses the SSRF classifier from the unmerged, PR-less `origin/rv/eng-html/image-proxy`; REQUEST posted to eng-html/Integrator. When the image proxy is on revamp, merge revamp into the branch, drop the stacking commit, check, open the PR (security code: Opus final review by the Integrator). It also needs an `UnsubscribePort` + `HostPorts.unsubscribe` seam from eng-contract.

## Waiting on / open items

- Composition root (eng-host): calls `createGoogleHostConnect` with `boundedKnownSubject` and `accountIsCommitted`, builds the lease/workflow host. Nothing is wired in production; workflow is opt-in via `GoogleProviderOptions.workflow`; `useDraftsSend` defaults false.
- Port gaps for eng-contract/eng-time: the draft engine cannot receive the other device's draft body (`RemoteDraftFact.body?` or `ProviderAdapter.openDraft`); `DraftUpload.supersedes?`; engine `payloadOf` still names `remoteDraftId` after an attempt; `UnsubscribePort`; sendPortContract shared-id case in `send-port-contract.ts`.
- `sendPortContract` on the Microsoft adapter: no Microsoft adapter exists in `host/providers/` yet; run it when that lane lands.
- Live gates (Mac, via the Integrator, plans/LIVE-RUNS.md): revoke scope (per token vs whole grant), workflow insert endpoint (`/messages/insert` vs `POST users/me/messages`), `from:@example.com` subdomain match, `drafts.send` honours uploaded bytes, Gmail keeps the client Message-ID and strips Bcc (probe steps are in the send follow-up report: S-self send with a `+bcc` alias, list SENT and search timings, raw read).
- Small leftovers: fold `draft-mime.ts` and send.ts header guards into one module; digest eviction by copy age; `keyring.ts` fixed `.tmp` name without fsync (platform); `main/vault.ts` is prov-gov's.
- Later (PV3/PV4 rest): P4 prefetch via `openThread(..., 'prefetch')`, Logger catalog wiring, G10 `progress.read`, prov-cal GoogleCalendarAdapter, feature-1 owner loop, the owner's day-9 sign-in. Read STATUS (`git diff` since the last read) and answer any Integrator REQUEST addressed to providers first.

## Rules that bit

- Subagent worktrees lack node_modules/devDeps (see above). A lane commit touching another lane's file needs `Lane-Approved: <lane>` on every commit touching it (owners:check ignores merge commits).
- When a stacked PR's base is squash-merged, rebuild the branch from `origin/revamp` and re-apply only your files (cherry-pick or `git show branch:path`), merging produces conflicts in DECISIONS.md/adapter.ts/unit.test.ts (keep both sides; check for leftover `<<<<<<<` before a background check, which otherwise fails on prettier).
- Do not run two full checks at once; the machine load causes the engine flakes above.

## Update 2026-11-02 (end of second Linux session): where the work stands

- **Merged since the last update:** #127-#129, #132-#133, #135-#141, #151 (and eng-contract's #153, #157, #159 which my adapter work depended on).
- **#156 (single Gmail adapter PR for drafts: deleteDraft with expectedMessageId, create-path conflict, body + `message` delivery with strict charset/size/duplicate-header/Reply-To/U+FFFD rules, per-pass fetch bound)**: base revamp, READY at f2d94c1, with the Integrator for the final merge. Worktree `rv-prov-dp`, branch `rv/prov-gmail-write/draft-ports`.
- **#158 (stack branch `rv/prov-gmail-write/draft-supersedes`, worktree `rv-prov-ds`)**: to be CLOSED as superseded once #156 merges. The only part not in #156 is the Gmail create lookup honouring `DraftUpload.supersedes` (PORT GAP 2): commit **4aef940** (`drafts.ts`, `draft-compare.ts`, `tests/prov-gmail/drafts-supersedes.test.ts`, DECISIONS). The Integrator will ask for it as a NEW small PR on revamp after #156: branch from revamp, cherry-pick 4aef940, merge latest revamp, re-run the tests (#157 is already on revamp), full check, open the PR, READY line. Recorded-hash decision: in-memory record, conflict after a restart (eng-contract agreed). Data-loss-sensitive: Opus review by the Integrator.
- Open elsewhere: eng-host composition root; Mac live probes; Microsoft adapter for `sendPortContract`; `keyring.ts` fsync (platform).
- Known load flake outside my lane: eng-html `inline: hostile bodies of 1000000 characters are scanned in linear time` (~250 ms bound).
