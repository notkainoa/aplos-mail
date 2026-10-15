# Decisions

## 2026-10-14

- Keep the existing workspace and choose **Aplos Mail** as the original product name; do not copy Avec branding, artwork, fixture mail, code or backend credentials.
- Use REA for behavior evidence. The initial ASAR analysis hit a 20-second deadline; reuse its retained inventory, then inspect individual modules. Native dependency integrity mismatch is a recorded limitation, not ignored evidence.
- Choose Electron + React + TypeScript: matches desktop interaction needs and supports fast visual verification through a local dev server. Use a small explicit service bridge and one persistent JSON store initially rather than a database framework.
- The shell initially lacks GROQ_API_KEY but workspace .env contains it. Load dotenv into the backend environment, ignore it, never display/commit/bundle it. Groq is the only AI provider, including transcription.
- Use original local demo accounts/mail to verify all reversible flows without contacting real recipients. Implement Gmail/Calendar using Aplos-owned OAuth configuration; never borrow Avec's access or identity. Live integration proof remains explicit if credentials are unavailable.
- Reproduce observed production UX and behavior, not internal development galleries/diagnostic APIs or vendor telemetry. Feature-flag candidates require further focused investigation before expanding scope.
- Reference UI inspection is read-only navigation; do not send, delete, triage or unsubscribe reference mail. Keep extracted materials outside the repository.
- Followed REA skill's explicit instruction to decompose independent scopes: separate service, provider adapter and desktop-shell workers; root owns UI and final verification. All share behavior contracts rather than reference implementation.
- Live Groq rejected the older documented Llama model with 404. Verified live model availability and current official deprecation documentation, then chose Groq-hosted `openai/gpt-oss-120b` (override via GROQ_MODEL), plus `whisper-large-v3-turbo` for audio. Both still use only api.groq.com. Synthetic live checks passed for summary/polish/draft/Ask/citations/calendar/transcription.
- Desktop tokens use Electron safeStorage. Browser preview cannot connect/persist Google OAuth tokens; use desktop for connection. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are absent, so live Google verification remains open.
- Production launch reads existing environment, optionally augmented from `~/.config/aplos-mail/.env`; development reads ignored workspace `.env`. No env file is included in the app bundle.
- Signature/footer are assembled at delivery from reviewed settings without changing the draft body. AI never changes mail after the Send action; polish remains reviewable before send.
- Browser development uses `Aplos Mail Preview` storage, separate from desktop, to avoid concurrent JSON writers overwriting desktop mail. The small JSON store is suitable for a single personal app service; no claim of database-scale mailbox indexing.
- Keep all-day calendar values as date-only; local calendar display must not interpret them as UTC midnight. Automatic viewing read marks do not enter triage undo history.
- Production dependency audit found vulnerable Nodemailer 7; upgraded to 10.1.1. A broad npm audit fix unexpectedly downgraded electron-builder; restored the known working lockfile. Production dependencies are rechecked separately; dev tooling advisories remain explicit if unresolved.
