# Architecture judge scorecard: evolve vs local-server vs portable

Judge: `deepseek`. Reviewed the three proposals, spot-checked against `SYNTH-architecture.md` and the gap/protocol reports. Planning only.

## In plain English

All three plans agree on the important part. Aplos's engine needs the same repairs: headers first and bodies later, page-by-page saves, a real database, careful spending of Google's allowance, a change log that survives restarts, AI off the sync path, and email HTML locked in a box. They differ on where the brain lives and how much future they buy now.

"Evolve" keeps the brain where it is, adds a menu-bar resident mode so mail and reminders survive closing the window, and puts a local doorway last. "Local server" builds that doorway early and treats the phone as a Mac client. "Portable" makes the brain a shared library on every device, so the phone works while the Mac sleeps.

Evolve wins reliability, product fit and safety. The other two have better parts than plans: local-server's security checklist and daemon packaging, portable's shared engine and quota leases. This scorecard weighs those differences.

> **What this means:** The plans share most of the work; evolve reaches dependable Gmail soonest.

## Score table

| Proposal | Reliability and performance | Product and roadmap fit | Execution risk (higher = safer) | Mean |
|---|---:|---:|---:|---:|
| **Evolve** | **9** | **9** | **8** | **8.7** |
| **Local server** | 8 | 7.5 | 7 | 7.5 |
| **Portable** | 6.5 | 7 | 6 | 6.5 |

> **What this means:** Evolve is the strongest base, widest on reliability.

## Lens 1: reliability and performance

**Evolve (9).** The governor uses provider units, lanes, one retry layer and five error classes; pages commit with their resume token, generations are swept, and poison items are quarantined. Crucially it defines effective state: pending operations replayed over provider truth in one transaction, plus a mutation fence (evolve §5; `SYNTH` §4.5). Send safety separates "provably not sent" from "uncertain", and overdue sends suspend rather than fire late. Storage follows the measured schema and supervises the WAL, which grew to 104-938 MB in 2.5 s. Two dings: parsed-body-only storage (§2) blocks re-render or re-index without spending quota; and its 2,000-unit floor lets three devices hit 6,000 with no headroom and four exceed it.

**Local server (8).** The foundation is the consensus, and raw MIME is better for integrity and future sanitizers. But it never covers confirmed-versus-effective state or the mutation fence, so "UI flips back" has no explicit fix, and it assumes one Mac owns the budget.

**Portable (6.5).** On one Mac it is the same foundation minus operational care: no quarantine, no WAL supervisor, thinner governor taxonomy. Its topology hurts under verified limits: Gmail's 6,000 units are per user per project, so Mac and phone contend; Graph's four in-flight and iCloud's connection cap are shared; its leases are soft and fail open into mutual 403s (portable §4, §9.3, §14).

> **What this means:** Evolve is the only plan that says how local edits and incoming mail stay in agreement.

## Lens 2: product and roadmap fit

**Evolve (9).** Live evidence first: a 0.2.4 patch within a week that thins the first window, classifies the 403 and makes reconnection obvious. Gmail is daily-drivable around week 5, iCloud and Fastmail around week 8. Resident mode lands in M1, so send-later, Later and reminders work early. Heuristic Home works with AI off. It gives a real action for Testing mode (Production unverified, 100-user cap) and a private-repo update plan. Its phone sees mail only while the Mac is awake.

**Local server (7.5).** Provider outcomes match evolve's; its tokenised API helps agents. But its own recommendation defers the phone six months, removing most of that payoff; timed features wait for A0 at M7, roughly 8-12 weeks, because resident mode is bundled with the listener; and no week-one patch delays real Gmail evidence. It names Testing mode but gives no owner action.

**Portable (7).** The Mac experience is the same foundation. A phone that works while the Mac sleeps is the only option matching `MOBILE.md` without an asterisk. But it is months of phone work needing OAuth, AI keys and Store review; it doubles AI spend unless summaries sync; and it taxes the Gmail budget daily. Lowest near-term value, highest long-term fit.

> **What this means:** Evolve is the only plan that improves real Gmail in week one and has reminders working early.

## Lens 3: execution risk (higher = safer)

**Evolve (8).** Additive and evidence-gated: `aplos.db` stays as a rollback copy, the shim keeps the old UI alive, `service.ts` is split before two threads touch it, and the contract is frozen with a fixture engine. Risks: an 11-week scope, M4 gated on the UI thread, a throwaway M0, and an unverified OOPIF keyboard path.

**Local server (7).** Also additive through A0, and candid that A1 costs 3.5-5 weeks and is blocked on a keychain-access-groups profile, not signing. But listener security is the commonest failure, the migration table lacks per-step acceptance evidence, and A1/A2 add a lifecycle.

**Portable (6).** Package extraction is cheap insurance; the recommended target is not. Phone protocol, Store review, CloudKit profile, leases and quota thrash are the least reversible commitment.

> **What this means:** All three keep the app usable, but only evolve's risky choices are late and easy to undo.

## Spot-checks and corrections

Verified: Gmail's 6,000 units/user/project/min and prices; 500 full threads ≈ 60,000 units; 0.04-0.07 ms per 50-row page, 0.5 ms unread versus 26 ms for joins, and a 16 KB FTS cap giving an 18% smaller index with 9-20% fewer deep hits; date-ordered rowids turning 32-40 ms search into 0.05 ms; AES 4.2x/14x; Electron 44 requiring macOS 13; and 0.12 ms versus 39 ms/1.2 MB windows at 100k threads. All three correctly identify profiles, not signing, as the A1 blocker.

Corrections: evolve's device floor should become a lease, and evolve should keep raw MIME for opened or attachment-bearing mail. Local server omits effective state. Portable's framing relies on the email-only precedent, which the phone report widens.

> **What this means:** The numbers hold; disagreements are design choices.

## The best ideas to graft

1. **Keep compressed raw MIME beside the parsed record** (localserver §2.2, portable §2.2), at least for opened or attachment-bearing mail.
2. **Extract `packages/engine` and `packages/contract`, extend `SqlDatabase` for BLOBs** (portable §1.2, M4).
3. **`quota_leases` plus visible budget state** (portable §4, §9.3), replacing evolve's divide-by-devices heuristic.
4. **Localserver's listener matrix** (§10): scoped tokens, per-device revoke, exact Host/Origin, no CORS reflection, and a tokenised preview.
5. **Localserver's A1 packaging** — Node SEA in `Contents/Library/LoginItems`, never the Electron binary — as an appendix.
6. **The change-log replay property test**, coarse backfill entries, an explicit floor and `cannotCalculateChanges` (evolve §2, M2).
7. **Heuristic-first Home with rank buckets and `rank_source`** (evolve §6).
8. **Compute a summary once and sync the ciphertext** (portable §6) with evolve's content-keyed `input_hash`.

> **What this means:** The final plan is evolve's spine with better organs from the other two.

## Decisions for you

1. **Which plan do we build on?** (a) Evolve with these grafts **(recommended)**; (b) local server; (c) portable. (a) gives daily Gmail around week 5 and keeps later options; (b) delays timed features; (c) delays value until the phone exists.
2. **Must a phone work while the Mac sleeps within six months?** (a) No, keep the engine portable-shaped as insurance **(recommended)**; (b) yes, commit to portable. (a) avoids daily quota contention; (b) costs months.
3. **Ship the 0.2.4 patch?** (a) Yes **(recommended)**; (b) no. (a) buys real Gmail evidence in week one.
4. **Move Google OAuth to Production (unverified)?** (a) Yes **(recommended)**; (b) wait. (a) stops weekly reconnects but caps users at 100; (b) means reconnecting weekly.
5. **Store raw MIME too?** (a) Opened, starred and attachment-bearing mail **(recommended)**; (b) parsed only; (c) everything. (a) protects future rendering at modest cost; (b) is one-way; (c) wastes space.

> **What this means:** Choose evolve now; the phone decision can wait without losing the work.

## Verdict

Evolve is the plan to execute. It is the most rigorous about what actually breaks mail: quota spending, page commits, local edits versus provider truth, uncertain sends and restart safety. It gets the owner to a real Gmail client fastest, gives reminders and send-later early through resident mode, and keeps the risky local doorway and phone as late, reversible options. Local-server is a sound foundation wrapped around a payoff it recommends deferring, and it leaves the "UI flips back" defect unaddressed. Portable is the right long-term answer only if a sleep-independent phone becomes a near-term requirement; until then its shared quota and months of phone work tax the Mac. Graft the raw-MIME record, the engine package, quota leases, the listener security matrix, the replay test and single-synced summaries. Its weakest assumption is the eleven-week schedule; its strongest is that every milestone has live evidence.

> **What this means:** Build on evolve, take the best parts from the other two, and decide the phone separately.
