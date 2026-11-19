# Lane card: eng-html (parked; security area, Opus review required)

**Goal.** Parser-based allowlist sanitizer package, the `Mail/frame` pipeline (single-render tokens, LRU of 12, engine-built headers), protocol relay, and the image proxy with an SSRF classifier. Owner reviews feature 13 (the email safety frame).

**Owned paths:** `packages/mail-html/**`, `apps/desktop/src/host/{protocol,proxy}/**`, `apps/desktop/src/main/protocol.ts`, `packages/engine/src/methods/mail.ts`.

**Read:** `plans/engine/HANDOFF.md`; `plans/engine/phase1-lanes.md` lines 455-526; `plans/10-engine-foundation.md` lines 381-412 (E4).

**State.** Branches: `rv/eng-html/parser-spike` @ 8ee97ab, `corpus` @ c42e51a (128 messages), `image-proxy` @ 7f2600e, `sanitizer` @ d748899 plus `wip-pause-1028` @ 36851fa (bounds a quadratic quote-detection slowdown; has a `no-control-regex` lint error). No PRs yet. html-4 needs eng-store's bodies.

**Tests.** `npx tsx --test 'packages/mail-html/tests/**/*.test.ts'`; `npx tsx --test apps/desktop/tests/eng-html/ssrf.test.ts`; `npm run check`.
