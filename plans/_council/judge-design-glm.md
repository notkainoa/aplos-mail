# Judge scorecard: three design-direction proposals (JUDGE: glm)

2026-10-27. Proposals: `plans/proposals/design-skypaper.md` (Skypaper), `plans/proposals/design-tactile.md` (Carried), `plans/proposals/design-precision.md` (Instrument). Context read in full: `research/email-clients/SYNTH-ui.md`, `research/email-clients/gaps/identity-collision-audit.md`, `research/email-clients/ui/aplos-baseline.md`.

## In plain English

This file is my judge's scorecard for the three design proposals for the Aplos revamp: Skypaper (mail as paper on a cool sky), Carried (a warm tactile desk) and Instrument (a cool precision tool). I read all three in full, plus the UI synthesis, the identity collision audit and the Aplos baseline audit, scored each 0–10 on the three lenses asked for: owner taste and beauty, identity and independence, and speed, craft and feasibility. The craft gap is small; the ranking turns on taste-fit and identity. The owner's icon is a sky with an airmail envelope over a green hill, and the owner wants an app that cannot be mistaken for Avec. Skypaper maps that icon story directly into the interface and hardens every risky element the audit flagged: the name is renamed, the blue moves to an ink blue measured 13.8 CIEDE2000 from Avec's, the stripe is kept to two places, and the serif "Aplos speaking" voice is unique among audited mail clients. Carried is the warmest and closest to what the owner loves but keeps Avec's canvas family and puts the summary above the sender. Instrument is the best-engineered but drops the icon story and leaves Space unspecified in the reader. Winner: Skypaper, with engineering grafted from the others.

> **What this means:** the winner is Skypaper; the losers are not wasted, because their best parts are grafted onto it below.

## Method and score table

Anchors: 9–10 adopt with confidence; 7–8 strong with real trade-offs; 6 or below gaps a revamp would inherit. The two audits act as tie-breakers: computed contrast and ΔE00 clearance, the screenshot-level is-this-Avec test, and whether agent crews can enforce the system with lint, skills and CI gates.

| Lens (0–10) | Skypaper | Carried | Instrument |
|---|---|---|---|
| 1. Owner taste and beauty | **9** | **8** | **7** |
| 2. Identity and independence | **9** | **7** | **7** |
| 3. Speed, craft and feasibility | **9** | **8** | **8** |
| **Total /30** | **27** | **23** | **22** |

**Winner: Skypaper (27/30).**

> **What this means:** owner-fit and identity weigh first, engineering second — and all three clear the engineering bar.

## Why the scores

### Skypaper — 27/30 (winner)

**Taste and beauty (9):** every taste item is mapped in its section 11; decision 4 reconciles sender-first with big summaries (sender and date as the first line, the serif summary beneath, identical 20/28 everywhere), decision 5 fixes Done-leaving-Home, decision 9 puts the cool canvas to the owner with a warm fallback. Beauty is structural: a flap instead of Avec's floating cluster, a margin rail for due dates and the "why it is in Home" line, the Newsreader letter voice, sky kept to four earned moments.

**Identity (9):** follows the collision audit clause for clause — the name renamed, ink blue at ΔE00 13.8 from Avec (today's 4.8), moss Done at 21.6, the post edge in two ownable straight edges, and a seven-point not-Avec acceptance test. No audited client sets AI text in a serif; that letter voice is the most ownable asset in the whole set.

**Feasibility (9):** eighteen named motions with computed spring zeta compiled to `linear()`, a p95 budget table (triage key to paint in one frame at 10k threads; palette under 80 ms), commit-first ghosts, a double-buffered reader, plus the `aplos-motion` skill, lint and a CI contrast gate — the strongest agent-enforcement story of the three. Gaps: cold-start budget unset, auto-height focus card, serif A/B pending.

### Carried — 23/30

**Taste and beauty (8):** the warmest and most faithful read — desk felt, letterstock cream, press-inset stamp buttons, a stamped commit flash, a wind arc at send. But the reader order is summary, then sender, then subject: the task's sender-first taste is literally met by the other two and only reframed here (section 10 reads it as "sender above subject").

**Identity (7):** wording fixed and Avec's grammar gone, but the daily canvas stays a warm `#ebe6df`, inside the family SYNTH-ui calls "the main move away from Avec's warm grey", and inside its own acceptance criterion 1 unless the 3–4% noise texture carries the difference — which screenshots barely show. Rigor slip: its dark accent `#6eb0ff` is cited [V] to the audit, but the audit only computed `#4fa3ff` and the light ink blue, so that ΔE claim is unverified.

**Feasibility (8):** the shared engineering spine is right (hold pins, rapid mode, transform-only, skill, lint, texture kill switches) but measured gates are thinner, zoom/reflow accessibility is absent, and texture adds a GPU failure surface on a 10k-thread list.

### Instrument — 22/30

**Taste and beauty (7):** the biggest summaries (22/30), sender-first literally met, and 32 px rows suit a keyboard owner. But the icon connection is deliberately discarded ("no postcard decoration"): closure is a 1 px horizon line, wind and flight are engineered out, and its keyboard table binds Space nowhere in the reader — a direct miss on the Space taste.

**Identity (7):** the sharpest escape from Avec's grammar (flat surfaces, hairlines, no pill, no toss). But memorability leans on the 2 px travelling rule and the ink primary — Linear-tool conventions the document names as ancestry — and the label-plus-rule AI identity is generic precision beside a serif voice.

**Feasibility (8):** the deepest engineering of the three: key-to-state ≤ 8 ms, a ten-commit stability test, durable undo as an inverse operation, LRU-12 prefetch, a fixed 168 px card that structurally ends list reflow, IME rules, skip links, measured packaged-build gates. Missing: any agent-enforcement layer — no motion skill, no lint list — odd in a spec built for agent crews.

> **What this means:** Skypaper wins on fit and identity, not effort — Carried and Instrument carry diff-bearing engineering that should be grafted, not dropped.

## Ten best ideas to graft into Skypaper

1. **Fixed-height focus card with fixed slots** (meta, two-line summary, facts, actions) — ends Home reflow during bursts; graft beside `hold` (Instrument).
2. **Measured, recorded gates:** key-to-state ≤ 8 ms, cold start < 1.5 s, Home < 2.5 s at 10k, palette < 50 ms, in the packaged build (Instrument).
3. **Undo as an inverse operation on a durable op queue**; rejection restores the row with an inline Retry (Instrument).
4. **IME-proof keyboard layer:** no keydown interception during composition, `event.key` not `keyCode`, Caps Lock ignored, single-key off in fields (Instrument).
5. **Skip links `⌘⌥L`/`⌘⌥R` and one Esc ladder** — back → close → clear (Instrument).
6. **Tactile press set:** 1 px inset highlights swapping on `:active` (scale .97/.94), two-layer letter-lift shadow, dark top sheen (Carried).
7. **`→ →` mark-all-done on Low-importance sender groups** (Carried).
8. **A "Set a date · D" next-step toast after Later** (Carried, also SYNTH-ui §4).
9. **Named one-key why-corrections `⌥↑`/`⌥↓`** writing deterministic sender rules (Instrument; sharpens the margin rail).
10. **One-frame theme-switch freeze** (Carried/Redakt).

Carried's desk-noise texture is deliberately not grafted: packaged-app GPU risk for little screenshot-visible payoff.

> **What this means:** the grafts are mostly Instrument's engineering hardened into Skypaper's look, plus Carried's touch details and two small pleasures that fill behavior gaps.

## Verdict

Skypaper wins because it converts the icon story into enforceable rules rather than decoration: a cool sky canvas, ink blue measured 13.8 ΔE00 from Avec, a serif no audited client uses for AI, and a flap that retires the Avec cluster while keeping Space, hold-dictation and one-item triage. Carried feels warmest and closest to what the owner loves, but it keeps Avec's warm canvas family (the hue move the audit calls the main step away) and places the summary above a sender-first reader. Instrument is the best-engineered document, with measured gates and a fixed-height card that guarantees list stability, yet its rule-and-label identity borrows the Linear-tool genre instead of the sky-and-envelope icon, and it leaves Space unspecified in the reader. Adopt Skypaper as the base; graft the fixed-height Home card, IME-proof keyboard layer, durable undo, skip links, tactile press and mark-all-done from the other two. Test the serif first.

> **What this means:** adopt the winner, graft the listed parts, and verify each graft against the acceptance sections rather than by taste alone.

## Decisions for you

1. **Adopt Skypaper as the base direction?** Recommended: yes. Carried keeps a warm canvas nearer Avec's family; Instrument loses the icon story.
2. **Serif for the AI voice?** Run Skypaper's one-day A/B (Newsreader vs SF 20/500 first); fallback is the raised-card colour signal.
3. **Graft the fixed-height Home card?** Recommended: yes; it costs only a two-line summary clamp.
4. **Cool canvas or Carried's warm desk?** Recommended: cool (Skypaper decision 9); warmth lives in press feel, not the canvas family.
5. **Any texture in v1?** Recommended: none.

> **What this means:** with the defaults you get Skypaper steel-plated by Instrument and softened by Carried's press feel, held by lint, skills and budgets.
