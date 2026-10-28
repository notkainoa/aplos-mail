# Lane card: eng-ai (parked until PR #47 merges and a slot frees)

**Goal.** Rule-based Home lanes (`laneFor`), `Demo/*` with an empty start (needed by conformance), the consent-gated AI job queue with budget, `Setup/*`, and interactive `Ai/*` and `Ask/*`. Groq is the default provider; read keys from the backend environment only.

**Owned paths:** `packages/engine/src/ai/**`, `packages/engine/src/methods/{ai,ask,setup,demo,consent,queue}.ts`, `apps/desktop/src/host/ai/**`, `apps/desktop/src/main/{groq,llm,ollama,anthropic,ai-keys}.ts` until moved, `apps/desktop/scripts/{evaluate-groq.ts,ask-live.ts}`, `apps/desktop/scripts/quality/**`.

**Read:** `plans/engine/HANDOFF.md`; `plans/engine/phase1-lanes.md` lines 385-454; `plans/10-engine-foundation.md` lines 413-445 (E5).

**State.** ai-1 is PR #47 (`rv/eng-ai/heuristic-lanes` @ 37df8f5). Next is ai-2 `Demo/*` (branch `rv/eng-ai/demo-data` exists locally at the same SHA, no work yet). ai-3 jobs and consent needs eng-store's extension API and eng-time's registry.

**Done (ai-2).** Empty start; demo data feeds the conformance runner; original demo data only.

**Tests.** `npx tsx --test packages/engine/tests/ai/lanes.test.ts`, `packages/engine/tests/ai/demo.test.ts`, then `'packages/engine/tests/ai/**/*.test.ts'`; `npm run check`.
