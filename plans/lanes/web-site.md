# Lane card: web-site (feature 14, the aplos.email website)

**Goal.** Finish the approved website cleanup: snapshot, one review, PR into `revamp`, squash-merge (roadmap 12.3 steps d-g). Nothing is left to build. The new logo and the redesign are a later follow-up; do not start them.

**State.** Owner APPROVED on 2026-10-28 (STATUS 13:41). Approved branch `rv/web/q5-truth` at `c84e327`, pushed, 26 files (`apps/web/**` plus `apps/desktop/build/dmg-background.html`). Approved screenshots, walkthrough and capture script: `/tmp/aplos-web-review/` on the Mac. Worktree: `rv-web-q5`. Handoff: `plans/platform/HANDOFF.md` on `rv/thread/platform`.

**Owned paths** (`plans/OWNERS.md` row `web`, line 61): `apps/web/**`, `apps/desktop/build/dmg-background.html`. Touch nothing else. No Vercel settings.

**Read, and only these.**
- `plans/00-roadmap.md` 12.3, lines 656-682 (steps d-g, material-change rule); 5.1a, lines 333-380 (one Sonnet review, no panels).
- `plans/40-platform-quality.md` Q5A lines 310-338 and Q5B lines 589-609 (what the site may claim; claims tied to proof).
- `plans/50-thread-briefs.md` line 548 on (Platform brief), section 14 only.

**Steps.**
1. In `rv-web-q5`: `git merge origin/revamp` (squash-merge later, since the branch carries commits that #28 squashed), re-run the checks below.
2. Snapshot: copy `/tmp/aplos-web-review/` to `~/Library/Application Support/Aplos Mail Review/F14/c84e327/` (demo data only). Append `APPROVED | web` with the SHA to `plans/STATUS.md` on `revamp` (tiny commit, `git pull --no-rebase` first).
3. One Sonnet review of `git diff origin/revamp...HEAD` (not Opus; the site touches no mail HTML, tokens or sending). Fix what it finds.
4. `gh pr create --base revamp --attach <approved screenshots>`: plain summary, snapshot SHA, results.
5. Merge rule: re-run `capture.cjs` at the PR head, image-diff against the snapshot, list changed strings. A visible change from what the owner approved is material: stop and ask. Otherwise `gh pr merge --squash`, then post `MERGED | web`.

**Done when.** PR squash-merged, `MERGED` line posted with the link, checks green, no material diff.

**Tests and checks** (from the repo root).
- `npm run typecheck`; `npm test`; `npm run check` (includes the owners check).
- `npm run build -w @aplos/web` (runs `check-claims`; a preview build only warns on unproven claims, a production build fails by design, decision 2026-10-27 23:04).
- `npm run test:checks -w @aplos/web`; `npm run check:external -w @aplos/web` (the built site requests no foreign host).
- Never an AI sparkle glyph; no Windows or Linux claims; Gmail is "available to invited testers".
