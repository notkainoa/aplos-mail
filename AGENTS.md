# Work on Aplos Mail

Read SPEC.md, TODO.md, DECISIONS.md and PROGRESS.md before continuing. Resume the next unchecked acceptance item. Keep observed reference behavior, design choices and unknowns distinct; use REA in small inventory → feature → module stages, narrowing scope if analysis stalls. Never copy reference code, assets, branding, mailbox data or credentials.

Prefer simple working solutions and a few meaningful tests. Implement the feature, verify it, check it off only with evidence, record progress/decisions, then commit. Keep working autonomously until complete or an actual external prerequisite blocks further work. Do not treat mocked Google verification as live acceptance.

Use Groq for every AI feature, including transcription; read GROQ_API_KEY from backend process environment. Ask alone may also run on OpenRouter (OPENROUTER_API_KEY) or the owner's OpenCode Go plan (OPENCODE_API_KEY) when the owner picks them in Settings. Never print, hardcode, bundle or commit keys/.env. Google uses this app's own OAuth configuration; do not reuse another application's tokens.

Commands: `npm run dev`, `npm run typecheck`, `npm test`, `npm run package`, `node scripts/launch.mjs`. Browser preview uses separate local state from desktop. Use original demo data or isolated test storage for sending/triage tests; do not send external messages as part of autonomous verification.
