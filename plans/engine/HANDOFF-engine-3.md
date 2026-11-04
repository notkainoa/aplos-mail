# HANDOFF — engine-3 (2026-11-04)

Successor: engine-4. This thread ended on an orchestrator freeze + handoff request. Read this,
plans/STATUS.md, plans/OWNERS.md, DECISIONS.md before acting. Commit author: Kainoa Newton
<k@kainoa.me>. Worktree map below.

## Owner freeze in force

Only work that gates `APLOS_ENGINE=real` continues. Everything else is FROZEN until the owner is
using the app: WP3 mail-gap leftovers, html-5 slice 2 (SUBFRAME_DOCUMENTS/Mail/serve), File/save +
File/open host side, further blob packages, WP4 items (Graph change-key before Graph draft sync;
held-newer-copy after undo/failed send). Opus findings unreachable today are follow-up tickets, not
blockers — one fix round max, no gold-plating.

## Gate list (what still gates the real engine)

1. ~~#270 `Message/original`~~ — MERGED (`339e239c`).
2. PR #281 `ce48a175` (`rv/eng-html/original-signal`) — integrator REQUEST, awaiting review: extends
   `ProviderPort.original(account, remoteMessageId, options?)` with `options.signal` (per-fetch
   AbortController fired by `total.stopped` — lane stop OR the 120 s deadline aborts the adapter's
   HTTP read), and maps a provider `ContractError('unavailable')` to the sentence "This part of Aplos
   is not running yet." Touches `ports/engine.ts` (eng-contract lane) under explicit integrator
   request. `original.test` 20/20.
3. Gmail adapter `original()` — prov-gmail's lane; must consume the new optional `options.signal`.
4. ui-reader mail-key wiring, packaged-app hand-check support — other lanes, engine-3 only answers
   REQUESTs.

## Open PRs (heads exact)

- #276 `d866b4de` (`rv/eng-html/mail-gaps`, over resolved `e213407a`): WP3 mail gaps — body-codec
  reads (codec-0 bypasses host codec), htmlToText fallback for HTML-only mail (incl. whitespace-only
  text stubs), global `Settings.mail.remoteImages`, `Mail/allowImages` audit rows via
  `auditWrites(caller, method, target)` in the same commit as the allow-list write. Stacks on #275's
  branch (merged in-tree; eng-host's #275 itself is NOT on revamp — `packages/engine/src/host/` does
  not exist there yet; it must land first or together).
- #278 `f5e754fd` (`rv/eng-time/empty-html-2`): #274 follow-up — `isEmpty` shares `emptyMarkup`;
  reference-bearing attributes (`background`, `src|href|poster|action=`, `style` with `url(`/
  `content:`, `cid:`) fail empty; wider emptied-container set. FROZEN until owner lifts.
- #281 `ce48a175` — see gate list.
- #275 `ed6062b` (`rv/eng-host/audit-writer`): eng-host's audit writer; MAX_FIELD=1000 matches
  contract `Id`.

## Merged (mine)

#254 async outbox reads; #263 reporter lifetime; #264 blob references; #265 AttachmentFiles;
#267 Attachment/get (head `014cd17f`, merge `40fd4964`); #269 files LOWs; #270 Message/original;
#274 empty-html draft proof.

## Gotchas learned (do not relearn)

- Engine bundle budget 450 000 minified bytes; currently ~433 128. NEVER value-import from
  `@aplos/contract` root (pulls zod) — type-only root imports; `ContractError` from
  `@aplos/contract/contract-error`; `principalOf` from `@aplos/contract/access`.
- `plans/STATUS.md` now has `.gitattributes` `merge=union` (#283) — STATUS conflicts should resolve
  by keeping both sides; still rebase-and-push on non-fast-forward.
- Committing STATUS while on a detached HEAD lands it on the wrong branch — always
  `git checkout rv/thread/engine-3` first, then `git push origin HEAD:revamp`.
- `mail/deadline.ts` `deadline()` racing never cancels work — close late iterators explicitly; pass
  an abort signal to the port when the read itself must stop (see #281).
- `htmlToText`: skip-content probe window must fit the longest tag name + boundary char (9 chars for
  `noscript`/`textarea`/`template`); named entities are case-sensitive; whitespace-only `text` stubs
  must fall through to HTML (`body.text.trim()`).
- `emptyMarkup` (draft-state.ts) is the narrow trivially-empty rule; bounded to bodies < 8 KB for
  fingerprint cost. An attribute that references content is content wherever it sits.
- `auditWrites` is evaluated while building `writes[]` before `store.commit` — replay-safe because
  `applyCommit` returns `replayed` first; window callers produce no row.
- Timing pins (drafts.echo/inline, fingerprint 500 ms perf check) flake under load — rerun solo.
- `npm run typecheck` at root can exceed 5 min; scoped `cd packages/engine && npx tsc --noEmit`
  verifies engine changes quickly.

## Commands that work

- `npm run check` (format/lint/owners/typecheck/tests; ~5 min) before commits.
- `npm run format:check && npm run lint && npm run typecheck && npm run test:engine && npm test` —
  the full required chain for READY lines.
- Targeted: `npx tsx --test packages/engine/tests/mail/<file>.test.ts` from the worktree root.
- Scoped typecheck: `cd packages/engine && npx tsc --noEmit`.
- Push STATUS: `cd <main worktree> && git checkout rv/thread/engine-3 && git rebase origin/revamp &&
  <edit STATUS> && git commit -am "..." && git push origin HEAD:revamp` (resolve union-merge
  conflicts keeping both sides).

## Worktrees

- Main/status: `/Users/knewton/.t3/worktrees/aplos-mail/t3-aa34423c` (`rv/thread/engine-3`)
- mail-gaps: `.../t3-aa34423c-mailgaps` (`rv/eng-html/mail-gaps`, may sit detached at resolved heads)
- empty-html: `.../t3-aa34423c-emptyhtml2` (`rv/eng-time/empty-html-2`)
- original-signal: `.../t3-aa34423c-orig` (`rv/eng-html/original-signal`)
- Dead: `rv/eng-time/blob-4-wire` superseded by #254 — do not revive.

## Next 3 actions

1. Wait for #281's review (gate item); fix in one round and post READY/head on STATUS.
2. When #281 merges, confirm prov-gmail consumes `options.signal` for `original()` (their lane —
   hand over via STATUS NOTICE, don't implement it).
3. On owner unfreeze: land #276 (needs #275 merged first or together — its audit calls fail
   otherwise) and #278, then resume WP4 items.
