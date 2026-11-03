# Live runs on the agent test account

The integrator runs every automatic live check against the owner's spare Gmail (the agent test account), on this Mac only, because its OAuth grant lives in this Mac's Keychain. Threads on the Linux box (`kainoas-linux-mba`) can't reach it. They ask through `plans/STATUS.md`, and the integrator answers there. The account rules are in [00-roadmap.md](00-roadmap.md), "Decisions already made", "The agent test account". The runner is `apps/desktop/scripts/live/` (lane `prov-emu`) and plan 20 section 5.4.

## In plain English

Another thread asks for a live check in the shared log. The integrator reads the exact command, makes sure it goes through the guarded runner and stays within the rules, runs it here, and posts back a result that names no address and no mail.

## How to ask

Post one line: `REQUEST | prov-<lane> | to integrator: live-run <tier R|M|S-self> | <exact command, run from the repo root> | <commit SHA of the runner and probes> | <what it proves, and the expected units per minute>`.

## What the integrator checks before running

1. The command is a single `node` or `npx tsx` call of `apps/desktop/scripts/live/run.ts` at the named SHA, which must be on `revamp` or in an open PR the integrator has checked. Nothing else: no shell pipes, no extra scripts, no environment overrides beyond the runner's documented flags.
2. The guard at that SHA includes the fixes from PR #38's security review (draft ids, label and filter keys, query keys, the account binding). Until #38 merges, no live run happens.
3. The tier is allowed: read-only tier R first. Tier M and S-self run only after a clean tier R run on the same SHA, and only with the probes the request names.
4. One Gmail run at a time, under 3,000 units a minute (the runner's pacer), and never overlapping an AI eval run on the account.
5. The account's `reconnectBy` is more than a day away. Otherwise the run is skipped with a plain note, and the owner reconnects at the weekly reconnect.

## How it runs

- From this worktree, on a clean checkout of the named SHA, headless, with no window.
- The grant and the Groq test key come from the Keychain inside the runner. They are never printed, logged or copied.
- Evidence is the runner's content-free report, kept outside the repo in `~/Library/Application Support/Aplos Mail Review/live/<date>/`. Before anything is posted, it is checked for any `@` or address-like text, any subject or body text, and any token.

## How the result comes back

One STATUS line: `NOTICE | prov-<lane> | live-run <tier> at <sha>: <pass or fail>, <units per minute peak>, <refusals by class>, <what was proven>`. The detail goes in the evidence file. A failure that looks like a guard refusal is reported as is; the integrator never loosens the guard to make a run pass.

## Never

No mail to any address but the account's own. No permanent delete, emptying Trash, unsubscribe, RSVP or attendee. No settings change. Nothing on the owner's main account; those checks are the owner's own, by hand, on days 14 to 16.

## Probe: `gmail.auth-results-shape` (tier R, no write)

Checks the assumptions of the #180 `Authentication-Results` parser (`google/list-auth.ts`) on real mail. It lists up to 200 recent Inbox messages, reads each one as metadata (`Authentication-Results`, `DKIM-Signature`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `From` only) and keeps counts of structure, never a header value, address, subject or id. About 4,000 units, paced under the 3,000 a minute limit (a couple of minutes).

Command (from the repo root, on the commit under test): `npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier R --account agent --expect-sha <40-char sha>`. It runs with the other tier R probes.

What the evidence lines mean (all counts; `...Max`/`...Min` are the largest/smallest seen):

- `withAuthResults` / `withoutAuthResults` / `severalAuthResults`: messages with the header, without it, with more than one.
- `googleParsed` / `notGoogleOrMalformed`: the strict parser accepted the header / refused it. `notTokenizable` (an unterminated comment or quote) and `foreignAuthservId` (the topmost header is not `mx.google.com`) say why the loose reading found nothing.
- `shapeExpected` / `shapeUnexpected`: the method kinds, read loosely, are in Google's order (dkim, arc, spf, dmarc) or not. `arcBeforeDkim`, `spfBeforeDkim`, `dmarcBeforeSpf` name the broken pairs; `withDara` and `withUnknownMethod` count methods outside those four.
- `noDkimResult`, `severalDkimResults`, `dkimResultsMax`: how many dkim results a header carries.
- `headerBMin`, `headerBMax`, `headerBNotEight`, `dkimNoHeaderB`: the length of `header.b` (the parser assumes 8 characters) and how often it is missing or another length.
- `withQuote`, `withNestedParens`, `commentsMax`: quotes in the value, nesting deeper than one parenthesis, most comments in one header.
- `authTrue` / `authFalse` / `authUnknown` / `authNotJudged`: the real `listAuthenticated` verdict for mail with List-Unsubscribe; `authUnknown` is no `Authentication-Results` at all; `authNotJudged` is mail without List-Unsubscribe (the app does not judge it). `falseNotGoogle`, `falseNoListPair` (List-Unsubscribe and -Post not exactly once each), `falseNoFromDomain`, `falseOther` split the `false` ones.

## Probe: `gmail.draft-message-id-after-edit` (tier M, two phases, one draft)

Answers the open `TODO(live)` at `google/drafts.ts`: does Gmail keep a draft's own `Message-ID` header when the draft is saved again, and when ANOTHER client edits it? It touches one draft in the agent account, with no recipient at all (so it holds no address), a fixed subject `aplos-live-probe <date>` and a known Message-ID.

1. **create** (the integrator runs it, the owner does not wait for it): `npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier M --account agent --confirm-mutating --phase create --expect-sha <sha>`. It creates the draft, saves it once more over the API (the guard allows an update only of a draft the same run made) and reports `created`, `createKeptMessageId`, `updatedDraftIdKept`, `updatedMessageIdChanged`, `updatedKeptMessageIdHeader` (each 0 or 1).
2. **the owner edits that draft once**, on the phone or in Gmail on the web (type a word, let it save). Without this step only the API-save answers exist.
3. **inspect**: the same command with `--phase inspect` (no `--confirm-mutating` is needed to read, but tier M asks for it; pass it). It looks at the newest 25 drafts, finds the probe draft by its fixed subject (`draftsScanned`, `draftsMatching`, `draftFound`), and reports `messageIdIsOurs` (the Message-ID header is still ours) and `bodyUnchanged` / `bodyEdited`. It writes nothing.

The probe draft stays in Drafts: the guard refuses every draft delete in every tier (permanent), and nothing here empties Trash. The owner discards it by hand. A run with no `--phase` (or another word) is a skip.
