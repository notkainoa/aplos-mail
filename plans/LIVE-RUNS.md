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

1. **create**: `npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier M --account agent --confirm-mutating --phase create --expect-sha <sha>`. It first looks through the newest 25 drafts: if a probe draft is already there it creates nothing and fails with `probeDraftsExisting` (discard the old probe draft by hand, then run `create` again). Otherwise it creates the draft, saves it once more over the API (the guard allows an update only of a draft the same run made) and reports `created`, `createKeptMessageId`, `updatedDraftIdKept`, `updatedMessageIdChanged`, `updatedKeptMessageIdHeader` (each 0 or 1).
2. **the owner edits that draft once**, on the phone or in Gmail on the web (type a word, let it save). Without this step only the API-save answers exist.
3. **inspect**: the same command with `--phase inspect` (tier M always needs `--confirm-mutating`, although this phase writes nothing). It looks at the newest 25 drafts, finds the probe draft by its fixed subject (`draftsScanned`, `draftsMatching`, `draftFound`), and reports `messageIdIsOurs` (the Message-ID header is still ours) and `bodyUnchanged` / `bodyEdited`. It writes nothing.

With more than one probe draft in the newest 25, `inspect` fails and gives no verdict (`draftsMatching` says how many): the owner discards the older probe drafts first. `--phase <word>` runs only the probes that declare phases, so `--phase inspect --confirm-mutating` never authorises another tier M probe.

The probe draft stays in Drafts: the guard refuses every draft delete in every tier (permanent), and nothing here empties Trash. The owner discards it by hand. A run with no `--phase` (or another word) is a skip.

## Reading the evidence: `emptyAnswers` and `bad-body`

- `emptyAnswers=1` means a list call (the draft probe's `drafts.list`, the auth probe's `messages.list`) came back 200 with nothing in the body (empty, `null` or `{}`): the account has no such items. That is a normal state of the spare account, not an error.
- Error class `bad-body` means a 200 whose body was not readable JSON or not a JSON object. It is a real error of its own, named without any of the body text.

## Probe `gmail.draft-message-id-after-edit`, version 2 (after the live finding that Gmail does not keep our Message-ID)

Never compares with our value alone. Each read records a short salted hash of the Message-ID header (never the value) and its shape, and the probe adds a custom `X-Aplos-Probe` header and read-only `rfc822msgid:` searches. Owner steps, in plain words: (1) discard the old `aplos-live-probe <date>` draft in the agent account's Drafts (the probe refuses to start while one exists); the integrator runs `--phase create`; (2) the owner opens the NEW `aplos-live-probe <date>` draft in Gmail on the phone, types one word and lets it save; (3) the integrator runs `--phase inspect`.

- **State file.** `create` writes `gmail.draft-message-id-after-edit.json` under `~/Library/Application Support/Aplos Mail Review/live/state/` (folder 0700, file 0600): a random salt, hashes and shape words only, from an allowlist in `scripts/live/state.ts` (an address, Message-ID or text is refused, naming the field). `inspect` compares with it; without it `stateMissing=1` and no stability flag is reported.
- **Shape codes** (`messageIdShapeCreate`, `messageIdShapeSave`, `messageIdShapePhone`): 0 absent, 1 ours, 2 Gmail-style `<...@mail.gmail.com>`, 3 other.
- **Flags (0/1):** `messageIdStableAcrossApiSave` (hash after create equals hash after our API save), `messageIdStableAcrossPhoneEdit` (hash now equals the one after the save), `customHeaderKeptAfterCreate` / `...AfterApiSave` / `...AfterPhoneEdit` (our `X-Aplos-Probe` token is still there; the phone step compares its hash), and the same three for `X-Aplos-Draft` (`engineHeaderKeptAfterCreate`, `...AfterApiSave`, `...AfterPhoneEdit`), the header name engine's draft-identity proposal (plans/engine/draft-identity.md) would use.
- **Search counts** (`create` after the save, `inspect` after the phone edit; no ids): `searchDraftsOursCreate`, `searchDraftsReportedCreate`, `searchMessagesOursCreate`, `searchMessagesReportedCreate`, and the same four with `Phone`: how many drafts / messages `q=rfc822msgid:<ours>` and `q=rfc822msgid:<the Message-ID Gmail reports>` return (0 = not found). Gmail's search index lags, so a 0 right after `create` may become 1 by `inspect`.

## Running the emulator as real Gmail behaves

`APLOS_EMU_DRAFT_IDENTITY=rewritten` (any test that creates a Gmail emulator) makes every `drafts.create` / `drafts.update` replace the draft's Message-ID with `<hex@mail.gmail.com>`; `APLOS_EMU_DROP_DRAFT_HEADERS=X-Aplos-Probe,X-Other` also drops those headers. The same are the `draftIdentity` and `dropDraftHeaders` options of `createGmailEmulator`. The emulator's `drafts.list` now also honours `q=`.

## Probe: `gmail.send-message-id` (tier S-self, one mail to the agent account itself)

Measurement (d) of engine's draft-identity note: does `messages.send` of our MIME keep OUR Message-ID on the Sent copy? It decides how `findSent` can recover an uncertain send and whether `useDraftsSend` can ever be switched on. Command: `npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier S-self --account agent --confirm-mutating --expect-sha <sha>`. Guard unchanged: the only send path is `messages.send` with every recipient the account itself.

It sends ONE message to the account's own address, subject `aplos-live-probe-send <date>`, a one-line body, a known Message-ID and the `X-Aplos-Draft` header. The address is read from the profile inside the probe, used for that one `To:` header and never stored, logged or reported. It refuses to send (`probeMessagesExisting`, fail) while a probe message of the same day exists, so a run sends at most once a day. The guard refuses deletes, so the message (one copy, labelled Sent and Inbox) stays; the owner discards it by hand.

Counts: `sent` (1 = the send went through), `sentKeptMessageId` (0/1), `sentMessageIdShape` (0 absent, 1 ours, 2 Gmail-style, 3 other), `sentHeaderKept` (our `X-Aplos-Draft` token is on the Sent copy), `sentFoundByRfc822msgidOurs` and `sentFoundByRfc822msgidGmails` (Sent messages `rfc822msgid:` finds for our id and for the id Gmail shows), `sentSearchTries` (the searches are repeated up to 4 times, 3 s apart, while an index may still be catching up).

Emulator: `sendIdentity: 'rewritten'` (or `APLOS_EMU_SEND_IDENTITY=rewritten`) makes `messages.send` replace the Message-ID like the draft finding, to run suites as if Gmail does that on send too.
