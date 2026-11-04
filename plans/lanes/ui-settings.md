# Lane card: ui-settings (UI-screens thread, feature 8)

**Goal.** Settings in the approved design (DESIGN 7.10): accounts with Reconnect, an AI provider and model per feature (Ask, Summaries, Drafts, Plans, Voice; Groq default; Voice lists only speech-to-text providers Groq and OpenAI), appearance, keyboard, tools on this Mac, diagnostics, retention. Built on demo data and the stand-in engine behind UI-core's frozen props and data hooks.

**Start from.** `origin/revamp`, branch `rv/thread/ui-settings`. Salvage `origin/rv/ui-settings/settings` (`cd92f1d`, based on the old pre-restructure layout): 30 files under `screens/settings/**` plus `tests/ui-settings/*`, green with 79 tests, never reviewed. Port it onto today's `renderer/ui/**`, `renderer/data/**` and `renderer/commands/**`; do not merge that branch (its base is stale). `git diff 7dd53835 origin/rv/ui-settings/settings -- apps/desktop` is the real change set.

**Owned paths** (`plans/OWNERS.md`). `apps/desktop/src/renderer/screens/settings/**` and its tests. Contract, shell, `renderer/ui/**` (including `ui/settings/`: `SettingRow`, `ProviderTable`, `KeyRecorder`), data hooks and the command registry belong to others; post a REQUEST in `plans/STATUS.md` for any change.

**Read only these.**
- `plans/30-ui-revamp.md`: U7 Settings bullet (line 519), §4.5 rows 2-3 and 11 (251-260), reconnect (577).
- `plans/DESIGN.md`: 7.10 Settings (794-810), 5 input rules, 8 keyboard map, 9 how AI appears, 10 microcopy, 7.15 error states.
- `mockups/settings-{appearance,accounts,ai,keyboard}.html`. DESIGN.md wins over a mockup.
- AI providers: root `AGENTS.md` (OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, custom OpenAI-compatible, plus Groq). Never print, store in the repo or screenshot key characters.

**Done criteria.**
1. Eight sections (General, Mail, Calendar, AI, Notifications, Accounts, Keyboard, Help & about), 180 px nav, 600 px column, 40/48 px rows, hairline separators, fixed control column, no page title.
2. AI: Features table first with provider and model per feature; hosted and "On this Mac and custom" groups with status dot, key source, Test, Remove (disabled with a tooltip for environment keys), "Add key", editable local addresses with default ports; "How your mail is used" disclosure. No key characters anywhere (canary test).
3. Accounts: one name per account; Reconnect on the row for `needsReauth`, `needsPermission` or `reconnectBy` within 24 h, opening the reconnect sheet; demo account Reset and Remove. Mail: undo-send 0, 5, 8, 10, 20, 30 s. Retention, tools on this Mac, diagnostics (content-free bundle preview), keyboard remap with conflicts, single-key switch, "Show all key hints".
4. Every setting searchable from ⌘K (palette entry per row).
5. Harness states, both themes, two sizes, no serious axe violation, hover never shifts layout. No sparkle, wand or star glyph; no sky gradient.
6. Light and dark shots plus a short keyboard walkthrough in `~/.local/share/aplos-mail-review/ui-settings/<sha>/`; post READY-FOR-OWNER F8 in `plans/STATUS.md`, then STOP for owner approval before deep review and the PR.

**Tests (repo root).** `npm run check`; `npm run typecheck`; `npm run owners:check`; `cd apps/desktop && npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'`; visual, from the repo root: `npx playwright test -c tests/visual/playwright.config.ts -g settings` (headless only).

**Models (owner routing 2026-11-04).** SWE-2 (`swe-2-high`) builds the port, wiring, CSS, tests, harness and capture scripts; extra hill-climb candidates also SWE-2. Sonnet only orchestrates, judges visuals and does the one final review. Opus only for key handling, storage and contract questions.
