# Draft identity when the provider rewrites our Message-ID (Gmail)

Written 2026-11-03 by the old Engine thread after the Integrator's 23:01 NOTICE (first live draft probe: Gmail does not keep the Message-ID we upload on a draft; the Gmail draft id survives an API save, the Gmail message id changes on every save).

> **In plain words.** The engine recognises "this remote draft is the one I uploaded" in four ways: the provider's draft id, the provider's message id from the upload answer, our own per-revision Message-ID, and the content fingerprint. On Gmail the third is gone. The first two and the fourth still work, so nothing is lost or overwritten silently. What breaks is every case where the answer to an upload never arrived: there the engine can no longer recognise its own copy, so the owner sees a duplicate draft or a conflict between two identical texts. Both are visible and can be discarded; neither deletes or replaces anything that was not proven ours.

## What depends on our Message-ID, and what happens on Gmail now

"Normal" = the upload's answer arrived and was recorded. "Lost reply" = the app died or the network dropped between the provider storing the copy and us recording it.

| # | Path (file) | Needs our Message-ID? | On real Gmail | Direction |
|---|---|---|---|---|
| 1 | `isEcho` rule 1: history reports the message id the row holds or wrote (`draft-writes.ts`) | no (provider message id) | works, normal case | safe |
| 2 | `isEcho` rule 2: new message id under a Message-ID we used, plus content proof | yes (`wrote.includes(w.internetId)`) | never true | spurious conflict or duplicate, see 3 |
| 3 | A history fact for our own upload that arrives BEFORE the answer is recorded (`explainedByAttempt`, `provenOurs`: `uploading.internetId === w.internetId`) | yes | fails: the copy is shown as someone else's | spurious conflict or duplicate even in the normal case, if a push-driven history pass overlaps an upload |
| 4 | `supersedesOwn`: replaced message id plus content proof | partly: `holdsOurContent` needs no id, `explainedByAttempt` does | works when the content equals the current fingerprint | safe |
| 5 | `adoptCopy` after a lost-reply create (`provenOurs` keyed by `meta.prints[w.internetId]`) | yes | never adopts; the copy is inserted as a remote draft | DUPLICATE draft |
| 6 | Create-conflict adoption (`remoteInternetId === internetId`, `draft-proof.ts:282`, `draft-writes.ts:108`) | yes | the Gmail adapter searches `rfc822msgid:<ours>` and finds nothing, so it never reports the conflict | DUPLICATE draft after a lost-reply create |
| 7 | `supersedes` / `earlier` (offer unanswered earlier creates to the next create) | yes | dead: the next create makes a second copy | DUPLICATE draft |
| 8 | Send: `messageIdOf` / `payloadOf` reuse the copy's Message-ID (`remote_internet_id`) | the engine records OUR id from the upload answer, so the reuse still matches | `useDraftsSend` is off by default: every Gmail send is `messages.send` of the pinned MIME, and the engine deletes the draft copy itself | safe today |
| 9 | `findSent` (uncertain send recovery, `rfc822msgid:` in Sent) | yes, for SENT mail | UNKNOWN: the comment at `send.ts:601` assumes Gmail keeps our Message-ID on `messages.send` (TODO(live)); the probe only measured drafts | if Gmail rewrites it on send too, an uncertain send is never found and stays "may have been sent" for the owner to decide; nothing is sent twice (uncertain sends are never retried automatically) |
| 10 | IMAP, Graph, JMAP | they keep the Message-ID | unaffected | n/a |

Nothing in this table loses mail, overwrites a copy that is not proven ours, or deletes one: the closed-world content proof (`DRAFT_CONTENT_FIELDS`) and "a Message-ID alone proves nothing" were already the rules. The cost is duplicates (5, 6, 7) and false conflicts (2, 3), and an open question on sending (9).

## What survives on Gmail, to build on

- The Gmail **draft id is stable** across API saves (probe: `updatedDraftIdKept=1`). For an UPDATE the row already knows `remote_draft_id`, so "same draft id plus the content of the running upload" is a sufficient echo proof with no Message-ID at all.
- The Gmail **message id from the upload answer** is recorded (`wrote`), which is why the normal case works.
- The content fingerprint and the closed-world proof need no id.

## Proposed redesign (items 1 and 2 built 2026-11-03, see DECISIONS; items 3 and 4 wait for the live answers)

1. **Engine, updates (no new measurement needed):** `explainedByAttempt`, `provenOurs` and `isEcho` accept `w.remoteDraftId === row.remote_draft_id` as the identity of the copy when the row already has one, in place of the Message-ID match; the content proof stays mandatory. This closes 2 and 3 for every update on Gmail and loses nothing on providers that keep the Message-ID. Small, in `draft-proof.ts` and `draft-writes.ts`; test: the existing echo tests rerun with an adapter that reports another Message-ID on every fact.
2. **Engine, port: the answer reports what the copy shows.** `DraftSaved`/create results may carry `copyInternetId` (the Message-ID the provider now shows for the copy, one `drafts.get` metadata read). The engine remembers it next to ours (`wrote`/`prints`), so a later fact under it with the right content is an echo and the lost-reply search can use it. Additive, optional, `v:1`.
3. **Adapter (providers), creates:** a lost-reply create has no draft id yet, so the Gmail adapter needs an identity that Gmail keeps. Preferred: a custom header carrying an opaque per-revision token (`X-Aplos-Draft`), if the probe shows Gmail keeps it across create, save and a phone edit; the adapter then reports `internetId` = our id for a copy whose token matches (the engine already treats `internetId` as opaque, so it needs no change), finds the copy by listing Drafts (bounded, as today) and reading the header. Fallback if no header survives: list Drafts newer than the attempt and match the canonical content (`draft-compare.ts`) against the upload; at worst a visible duplicate, never an adoption without the content proof.
4. **Sending:** measure `messages.send` before `useDraftsSend` is ever switched on (needs a send to the agent account itself; owner's go). If Gmail rewrites the Message-ID on send, `findSent` needs the same kind of identity (a header token on the Sent copy, or a search on subject, recipient and time window with the content proof), and until then an uncertain Gmail send stays uncertain by design.

## What I need measured (Integrator's REQUEST to providers-3 already covers a, b, c)

a. Is Gmail's own Message-ID stable across API saves and a phone edit? (decides how much `copyInternetId` buys)
b. Is a custom header kept on create, save and phone edit, and visible in `drafts.get` metadata? (decides 3)
c. Which search finds a draft by Gmail's id? (`rfc822msgid:` on Gmail's value)
d. **New, not yet asked:** does `messages.send` of the pinned MIME keep our Message-ID on the Sent copy? (decides 4 and the whole `findSent` design; send to the agent's own address, with the owner's approval)

## What I am NOT changing now

The real path is off and the live answers (b, d) decide the adapter side. Items 1 and 2 are engine-side and independent of those answers; I will build them as one Opus-reviewed PR when the Integrator says go, or earlier if you want them before the probe results come back.
