# Send identity: recovering an uncertain Gmail send (engine item 4, `findSent`)

Status: design note, 2026-11-05 (written before the code, as the Integrator asked). Owner of the note: Engine (eng-contract / eng-time), with prov-gmail-write for the adapter half.

> **Superseded (2026-11-05, Integrator DECIDED):** the Gmail adapter adds `X-Aplos-Send` at transmit and `findSent` matches it, as designed in `plans/providers/findsent-token.md` (providers #224); the engine and its pinned MIME stay untouched, so the `mime.ts` part below is NOT built. Kept for the measurements and the reasoning.

## What the live probe measured (Integrator 03:01, tier S-self `gmail.send-message-id`)

- `messages.send` REWRITES our Message-ID (`sentKeptMessageId=0`); `rfc822msgid:<ours>` never finds the Sent copy (`sentFoundByRfc822msgidOurs=0`).
- A CUSTOM HEADER on the sent message SURVIVES on the Sent copy (`sentHeaderKept=1`).
- Gmail's search index lags a few seconds behind a send (found on the 4th try, `sentSearchTries=4`).

So an uncertain Gmail send (bytes out, answer lost) can today never be recovered: it stays "may have been sent" for the owner to decide. That is the safe state (uncertain sends are never retried automatically, nothing is sent twice), and `useDraftsSend` stays OFF until this lands.

## Design

1. **Token.** The pinned send MIME carries `X-Aplos-Send: <token>` where the token is an opaque random id fixed once per submission attempt. The engine already generates one random id per submission (`newMessageId`, 128 random bits, `<hex@domain>`, kept by `abandoned()`/`wrote` rules across restarts of the same attempt), so the token is the hex local part of that Message-ID. No port change: `findSent(internetId, since, ctx)` derives the token from `internetId`. It is visible to recipients under "Show original" (an opaque random id, no content, no address); say so in DECISIONS.
2. **Engine (mime.ts).** `writeMime` emits the header on SENT mime only (never on a draft copy: drafts carry `X-Aplos-Draft`, a different token with a different purpose and lifetime), exactly once, CRLF-safe (hex only). The pinned bytes and their fingerprint include it, so a replay of the same attempt sends the same header.
3. **Adapter (google/send.ts).**
   - `checkHeaders` allows `X-Aplos-Send` on the send path (and still refuses any other custom header), and requires it to equal the token of the submission's Message-ID.
   - `findSentCopy` keeps its Message-ID match (other providers, an eventual future where Gmail keeps the id) and additionally accepts a Sent, non-DRAFT message whose `X-Aplos-Send` header equals the token (read with `messages.get format=metadata&metadataHeaders=X-Aplos-Send` added to the existing candidate read; no body is read).
   - Candidate set: Sent only, bounded by `after:` (the attempt's time window, with the existing `AFTER_SLACK_MS`), the existing `recentSentCopy` newest-first listing with its bounded pages; the existing proof conditions stay (Sent label, not DRAFT, time window).
   - **Index lag:** the answer "absent" is only given after a bounded retry: the search is repeated up to N times over a bounded total (measured: the 4th try, a few seconds; use e.g. 6 tries with 2 s spacing capped at ~12 s of the clock port, one `lane: interactive` budget), and the recent-listing fallback (which does not depend on the search index) runs on each try. If the final answer would be absent but the listing was partial, the existing `incomplete` error stays (uncertain, never absent).
   - A hit found only by token still goes through the engine's existing uncertain-send settlement (`found` -> sent); nothing in the engine changes there.
4. **What does not change.** Uncertain sends are never retried automatically; a send is only marked sent when `found`; `useDraftsSend` stays OFF; the draft token `X-Aplos-Draft` is untouched (the pinned bytes never carry it, and still must not).

## Risks to check in review

- A hit by token must not be able to bind the WRONG message: the token is 128 random bits; compare exactly; also require Sent label + not DRAFT + `internalDate >= since - slack`. An attacker who can put a header on a message in the owner's Sent already controls the owner's account.
- The token must not leak anything linkable beyond the Message-ID we already put on the same mail (non-Gmail providers keep our Message-ID visible anyway).
- Retry must not hide a real failure: a thrown listing error stays an error; only a clean empty result is retried and only for the bounded time; the total stays inside the interactive lane budget.
- Replays: the same attempt resends the same bytes (same token); a NEW attempt (new revision) gets a new token, and a Sent copy of an OLDER attempt's token must not satisfy a newer attempt.
- Emulator: the Gmail emulator must keep custom headers on `messages.send` and lag its index (fault knob) so both are tested; the live evidence is the Integrator's 03:01 line.

## Out of scope

Providers other than Gmail (their `findSent` is unchanged); the Mac live re-probe of the full path (owner/Integrator after merge).

## 2026-11-05 update: SUPERSEDED by providers' design (plans/providers/findsent-token.md, #224, implemented in #226)

providers-3 built the adapter half before this note could be implemented, with a better split: the Gmail adapter stamps `X-Aplos-Send: <internetId>` at send time (`transmit`), so there is NO engine change (the engine's pinned MIME stays token-free, as for `X-Aplos-Draft`), and `findSent` accepts a Sent copy by token or by Message-ID. One deviation from the design above, which I accept: no retry loop inside `findSent` (it stalled the kill-point matrix on a fake clock); the engine's own re-check after 60 s covers the few-seconds index lag (the engine asks again before it asks the owner). This note stays as the record of the engine-side alternative that was not built.
