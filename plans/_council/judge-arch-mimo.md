# Judge scorecard: three architecture proposals (mimo)

## In plain English

Three proposals say how Aplos's brain should be rebuilt. "Evolve" repairs the engine where it sits. "Local server" turns it into a small local server other tools can talk to. "Portable" lifts it into a shared package so a phone can run it too. I read all three in full and spot-checked their loudest claims against our research: Gmail quota math, database speed results, memory footprints, window-query numbers, and phone precedent. The numbers hold up.

This matters because the next few months depend on this choice, and the first real Gmail sync already failed once. Getting it wrong costs weeks; getting it right means a mail app you can live on every day.

What changes for you: a recommended base plan, eight ideas to graft in from the others, and the questions only you can answer.

> **What this means:** Rebuild Aplos in place first, add the local server next, then the phone — in that order.

## Scores

| Proposal | Reliability & performance | Product & roadmap fit | Execution risk (safer = higher) | Total |
|---|---|---|---|---|
| **arch-evolve** | 9 | 9 | 8 | **26** |
| **arch-localserver** | 8 | 8 | 8 | **24** |
| **arch-portable** | 7 | 7 | 7 | **21** |

### 1. Reliability and performance

**Evolve — 9.** Most operationally complete. First sync priced at published rates (50 threads ≈ 1,000 units, 500 ≈ 10,000; `SYNTH-architecture.md` §4.1); error taxonomy with escalation (60 s → 5 min → 1 h) and a persisted `governor` table so restarts cannot hammer a paused account. Mutation fence replays pending ops over provider state in one transaction, killing the "UI flips back" heuristics. Storage follows `gaps/storage-engine-benchmark.md`: zstd body table not files, paced FTS job (page commits hold the write lock 45–136 ms), WAL discipline (104–938 MB in 2.5 s under a busy reader). Uncertain sends never replay; acceptance runs against a 6,000-units/min emulator with zero 403s. Deductions: device-aware budget is crude (admitted); M0 is a stopgap in the old model.

**Local server — 8.** Same foundation, well executed: reserve-before-send, one retry layer, classify by reason *and* message text, persistent cooldowns, pause aborts siblings, 75% target (§4.4 of the synthesis). Send intent before the network with the provably-not-sent / uncertain split; replay tests budgeted. Thinner on escalation detail and on coordinating multiple Macs sharing one Gmail quota.

**Portable — 7.** Mac-side reliability equals the foundation, but multi-device correctness is half-solved: soft leases fail open, and its own §9.3 admits two uncoordinated first syncs ≈ both 403. iCloud's connection cap is shared, and short iOS background time makes a phone copy stale without CloudKit pushes. The phone bet adds failure modes the other two defer.

> **What this means:** All three fix sync. Evolve is most precise about quotas, crashes and sending; portable carries extra risk the moment a second device exists.

### 2. Product and roadmap fit

**Evolve — 9.** Fastest honest path to daily driving: week-0/1 patch (0.2.4) gets real Gmail working in a limited way; Gmail daily-driver week 5, iCloud and Fastmail week 8, hardening week 11 — named releases with a live acceptance gate per provider. Resident menu-bar mode delivers timed features with the window closed and says plainly nothing runs while the Mac sleeps. Google Testing mode, scope choice and CASA are listed as external prerequisites. Decision 10 fixes the private-repo update-feed 404 without forcing early open-sourcing; remote images blocked by default keeps the privacy story clean.

**Local server — 8.** Foundation plus A0 is a comparable 8–12 weeks, and staging A0 → A1 → A2 with A1 *default-deferred* (blocked on a profile that does not exist) is honest discipline. Sleep-ceiling and phone-precedent honesty is best in class (A2 precedent medium-high outside email, nil inside; `gaps/phone-mac-connectivity.md`). Loses a point: no quick Gmail patch like evolve's M0; A1 packaging can distract.

**Portable — 7.** The only path where the phone works while the Mac sleeps, matching `MOBILE.md`'s recorded intent (engine bundles platform-neutral; ran in JavaScriptCore). Strongest privacy pitch. But near-term cost is real: package extraction, leases, CloudKit (profiles missing), and a phone that is "months, not weeks" of App Store work. If a sleep-independent phone becomes a near-term must, this rises; the brief does not make it one.

> **What this means:** Evolve gets you living on real mail soonest with clear checkpoints. Portable wins only if a sleep-independent phone is a near-term must.

### 3. Execution risk (higher = safer)

**Evolve — 8.** Built for how the work will run: two architecture threads with explicit module ownership, `service.ts` split first with 227 tests green, contract freeze plus fixture engine at end of M1 so the UI thread never waits on the store, per-milestone acceptance, rollback drill, `aplos.db` kept two releases. Fully reversible — A0 is a transport added late. Deductions: largest surface (11 milestones); change-log bugs are subtle (Bulwark shipped two; replay tests mitigate, not eliminate).

**Local server — 8.** Equally safe sequencing: additive F → A0 → A1 → A2, fallback to an evolved `utilityProcess` through M7, A1 deferred, effort ranges honestly flagged as disagreeing up to 3×. Deductions: M2/M3 cutover is vaguer than evolve's compat-shim plan; the 1.5–3 week window migration is named as a stall risk without the same thread-splitting mitigation.

**Portable — 7.** M4 extraction is one reversible week and phone work never blocks Mac releases — good. But the phone protocol becomes a compatibility commitment once shipped, leases and CloudKit dual-write add moving parts, and its own risk list warns against combining strategies until each works alone. Safest *if* the phone waits; the proposal asks you to commit earlier.

> **What this means:** Evolve and local server are both safe to execute; evolve plans the two-thread split in more detail. Portable asks for a longer commitment before the payoff.

## Ideas to graft into the final architecture

1. **M0 quick Gmail patch** (evolve §12): thinned ~40-thread first window, classified error logging, `srcdoc` HTML stopgap, rotating redacted log — real Gmail evidence in week 0–1.
2. **Governor escalation ladder + persisted `governor` table** (evolve §4): 60 s → 5 min → 1 h; daily quota stops until Pacific midnight; cooldowns survive restart.
3. **Mutation fence** (evolve §5): replay pending ops over incoming provider state in one transaction; rollback for free, no more "UI flips back."
4. **One timer loop over `not_before` / `reminder_at`**, durable notification outbox, and the overdue-while-off suspend rule (evolve §5, localserver §5.3; Bulwark's laptop rule).
5. **Contract freeze + fixture engine at end of M1**, then staged migration to live windows with ID-only pushes (evolve §7; `gaps/engine-contract-rpc-stack.md`: 0.12 ms vs 39 ms / 1.2 MB at 100k threads).
6. **A0 → A1 → A2 staging with A1 default-deferred** and honest cost tables (localserver §1, §13): resident mode first, LaunchAgent only when "sync after ⌘Q" hurts.
7. **Tokenized listener replacing today's unauthenticated `server.ts`**, with `Last-Event-ID` / `reset.required` resume (localserver §7.2, §10.1; `SYNTH-architecture.md` §10).
8. **Cross-device soft quota leases plus `packages/engine` portability tests as insurance** (portable M4, M11): cheap now, mandatory the day a second device exists.

> **What this means:** Keep these eight regardless of which plan wins; they are the best pieces spread across all three documents.

## Verdict (150 words)

Choose **arch-evolve** as the base. It is the only proposal that pairs a week-one Gmail rescue with a fully reversible eleven-week path, a governor priced in provider units with a real escalation ladder, and an execution plan that matches how the work will actually run: two architecture threads, a contract frozen early for the UI thread, live acceptance gates at every provider milestone, and the old database kept as a rollback net. Local-server's staged A0→A1→A2, tokenized-listener rules, and resume semantics are the right sequel when a CLI or phone appears — but its LaunchAgent must stay deferred. Portable's package extraction and quota leases are cheap insurance to bake in now, while the phone itself waits until the Mac is daily-drivable on real Gmail, iCloud and Fastmail. Reject nothing wholesale; reject only the sequencing.

> **What this means:** Evolve now, local server as the next act, portable as insurance — never the LaunchAgent or the phone engine first.

## Decisions for you

1. **Which proposal is the base plan?** (a) Evolve **(recommended)**; (b) local server; (c) portable. (a) ships Gmail soonest and stays reversible. (b) works as an alias for (a) until A0 — but its A1 must not start early. (c) commits to the phone bet before the Mac is proven.
2. **Ship the week-one 0.2.4 Gmail patch first?** Yes **(recommended)**, or skip to the rebuild. Yes buys real quota evidence within days; skipping saves those days but real mail waits ~5 weeks.
3. **When does the local listener (CLI/MCP) land?** (a) After the store and contract are stable, ~M9 **(recommended)**; (b) as early as possible. (b) adds attack surface — the commonest failure in the corpus (`SYNTH-architecture.md` §0.10) — before there is much to call.
4. **Phone strategy for now?** (a) Thin client of the Mac after the listener is solid **(recommended)**; (b) portable engine now; (c) no phone until asked. (a) is cheap and quota-safe but sees mail only while the Mac is awake. (b) is the only sleep-independent path but costs months and shared quota. (c) defers safely.

> **What this means:** Pick evolve as the base, ship the quick Gmail patch first, and defer both the LaunchAgent and the phone engine until the Mac is something you live in.
