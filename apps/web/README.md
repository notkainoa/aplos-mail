# Aplos Mail website

Static marketing site: a landing page, a privacy policy and a download page ("How to get it"). Vite + React, built to plain files in `dist/`. Light or dark, following the visitor's system appearance like the app. No analytics, cookies or third-party scripts.

```sh
npm run web           # dev server, http://127.0.0.1:5273 (APLOS_WEB_PORT changes the port)
npm run web:build     # typecheck and build to apps/web/dist
npm run web:preview   # serve the built output
```

- **Look.** The app's own calm: the page sits on the app's grey shell (`#f5f5f6`, dark `#121314`), and feature sections sit straight on it, split by a hairline and space, with no pane or card around them. Cards are kept only for things that are cards in the app (the focus card, the Ask panel, Settings, the calendar, keycaps). There is no sky, gradient, texture, glow or airmail stripe. The site's one filled button and the close band use the logo's green; inside copies of the app the accent is the app's ink blue, as in the app. Newsreader (`@fontsource-variable/newsreader`, self-hosted, OFL) is used only for words Aplos writes (summaries, Ask answers); everything else is the system SF stack. Never a sparkle, star, wand, brain or robot glyph for AI: a suggestion wears its action's icon.
- **Styles** live in `src/styles/`: `tokens.css` (every colour, including the `--mac-*` colours of the install drawings, plus shadows, font families, section spacing and motion, light and dark via `prefers-color-scheme`; neutrals and type follow `apps/desktop/src/renderer/ui/generated/tokens.css`; font sizes and small spacings are set in each component's own CSS), `base.css`, `chrome.css` (header, footer, buttons), then per page `home.css`, `app.css` (copies of app parts), `demos.css`, `download.css` and `privacy.css`. Each entry (`src/entry-*.tsx`) imports what its page needs.
- **Interactive pieces**, all scripted on original demo data with nothing sent anywhere: `src/Triage.tsx` (+ `TriageCard.tsx`, `triageData.ts`; the Home demo: click it, then Space, ← →, Z, or drag the card sideways; each email's main button names its suggested step), `src/Ask.tsx` (+ `askData.ts`, `askHooks.ts`; pick a question, or hold A or the hint to dictate), and in `src/Live.tsx` the shortcut list that answers the real keyboard and the per-feature AI provider picker. `src/Mocks.tsx` holds the static suggestion cards and the calendar. Motion is transform and opacity only, hover never moves anything, and everything has a reduced-motion fallback; `src/reveal.ts` fades sections in once.
- **Brand.** `brand/aplos-mail.svg` is the flat logo, built faithfully from `brand/aplos-mail.icon`; never redraw it. `src/brand.tsx` shows it (`Logo`). `node scripts/brand-assets.mjs` (instructions at its top) renders `public/favicon.svg` (a copy), `public/favicon.png`, `public/apple-touch-icon.png` and the social card `public/og.png` from that SVG.
- **Screenshot.** `src/assets/app/home-{wide,main}-{light,dark}.webp` are the real app's Home on its demo data, with AI off (so they show subjects, never a painted-on summary): the top of the window for wide screens, and a crop of the main pane (focus card and first rows, no sidebar) for phones. `scripts/capture-screenshots.mjs` recreates them from the built app (instructions at its top). **Retake them after UI council 2 (PR #548) merges into revamp**, since that restyles the app.
- Every public claim is tied to proof in `claims.json`; `scripts/check-claims.mjs` warns on unproven claims in preview builds and fails production builds by design.

## Deployment (Vercel)

The Vercel project `aplos-mail` is connected to this GitHub repository through Vercel's Git integration, so there is no workflow or secret in the repo.

- Pull request: Vercel builds a preview and comments the URL on the PR. Previews sit behind Vercel login (deployment protection).
- Merge to `main`: production deployment, publicly reachable.
- `vercel.json` (in this folder) sets the install command (only the site's dependencies, Electron is skipped), security headers, long-lived caching for hashed assets, and an ignored-build command: a deploy is skipped unless the site, `packages/`, or the root `package.json` / `package-lock.json` changed since the last deployed commit on that branch (`VERCEL_GIT_PREVIOUS_SHA`; with no previous deploy, or if that commit is not in the shallow clone, it builds). A skipped build shows on the PR as "Canceled by Ignored Build Step", which is expected, not a failure; the earlier preview URL still stands.
- Project settings (set once through the API, not in the repo): Root Directory `apps/web` with source files outside the root enabled, framework Vite, Node 22, Web Analytics and Speed Insights off, deployment protection on previews only.
- A custom domain is added in the Vercel project settings; nothing in the repo needs to change.
- `download/` (with `src/Download.tsx`, `src/platform.ts`, `src/release.ts`) is the download page. While the repository is private there is no public release (`release` is `null` in `src/release.ts`), so it says builds are shared with invited testers and shows the install steps; once releases are public it can offer the Mac download.

## Honesty checks

- `apps/web/claims.json` lists every factual claim on the site; copy marks each with `data-claim="<id>"`. `npm run build -w @aplos/web` runs `scripts/check-claims.mjs`, which fails on an unregistered id, a placeholder, a banned phrase, and, on Vercel production builds (`VERCEL_ENV=production`), on any claim that is not verified or is stale. Preview builds only warn.
- `npm run check:external -w @aplos/web` (after a build) proves the built site requests no host but itself: a static pass over HTML, CSS and JS plus a headless browser pass in five views. It needs Playwright (`PLAYWRIGHT_FROM=<folder with playwright>` if it is not installed locally).
- `npm run test:checks -w @aplos/web` runs the checks' own tests.
