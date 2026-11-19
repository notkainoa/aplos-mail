# Work on Aplos Mail

Read SPEC.md, TODO.md, DECISIONS.md and PROGRESS.md before continuing. Resume the next unchecked acceptance item. Keep observed reference behavior, design choices and unknowns distinct; use REA in small inventory → feature → module stages, narrowing scope if analysis stalls. Never copy reference code, assets, branding, mailbox data or credentials.

Prefer simple working solutions and a few meaningful tests. Implement the feature, verify it, check it off only with evidence, record progress/decisions, then commit. Keep working autonomously until complete or an actual external prerequisite blocks further work. Do not treat mocked Google verification as live acceptance.

Groq is the default for every AI feature, including transcription; read GROQ_API_KEY from backend process environment. In Settings → AI the owner sets up providers and picks the model for each feature (Ask, Summaries, Drafts, Plans, Voice); voice needs a speech-to-text API (Groq or OpenAI). Providers: OpenAI (OPENAI_API_KEY), Claude (ANTHROPIC_API_KEY, via the official Anthropic SDK), Gemini (GEMINI_API_KEY), OpenRouter (OPENROUTER_API_KEY), the owner's OpenCode Go plan (OPENCODE_API_KEY), Ollama or LM Studio on this Mac (default local ports, address changeable in Settings; optional OLLAMA_API_KEY / LM_STUDIO_API_KEY) or a custom OpenAI-compatible server (address in Settings, optional CUSTOM_AI_API_KEY). Never print, hardcode, bundle or commit keys/.env. Google uses this app's own OAuth configuration; do not reuse another application's tokens.

Layout: an npm-workspaces monorepo. `apps/desktop` is the Electron app (all source paths in these docs, such as `src/main` and `scripts/`, are relative to it), `apps/web` is the marketing site, and `packages/` holds the shared workspaces: `@aplos/engine` (`packages/engine`, today's engine under `src/legacy/`) and `@aplos/contract` (`packages/contract`, today's shared types under `src/legacy/`). Today's renderer is in `apps/desktop/src/renderer/legacy/`. Run every command from the repo root.

Commands: `npm run dev`, `npm run typecheck`, `npm test`, `npm run package`, `node scripts/launch.mjs`, plus `npm run web` / `npm run web:build` for the site. Put `.env` at the repo root (or in `apps/desktop`). Browser preview uses separate local state from desktop. Use original demo data or isolated test storage for sending/triage tests; do not send external messages as part of autonomous verification.

## Code hygiene

- Run `npm run check` before every commit. It runs the format check, ESLint, stylelint, the owners check, typecheck and tests (checks that do not exist yet print `pending: <name>`).
- No multi-statement one-liners.
- New files use named exports and small functions.
- Whoever touches a dense function tidies it.

## Design rule (revamp)

The reference apps (Avec, Tatem, Notion, Notion Calendar, Redakt, Zero and others) are ideas only. `plans/DESIGN.md` is binding for every screen, and `mockups/` is the visual target. Before touching `apps/desktop/src/renderer` or `apps/web`, load the `aplos-design` skill (`.claude/skills/aplos-design/SKILL.md`) and follow its definition of done. Never use a sparkle, wand or star glyph for AI.
