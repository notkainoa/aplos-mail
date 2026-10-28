# Aplos Mail website

Static marketing site: a landing page, a draft privacy policy and a download page that is not linked yet. Vite + React, built to plain files in `dist/`. Light or dark, following the visitor's system appearance like the app. No analytics, cookies or third-party scripts.

```sh
npm run web           # dev server, http://127.0.0.1:5273 (APLOS_WEB_PORT changes the port)
npm run web:build     # typecheck and build to apps/web/dist
npm run web:preview   # serve the built output
```

- Styling lives in `src/styles.css`. The brand comes from the app icon, read top to bottom: the page opens and closes in its sky. Text colors, neutrals and the demo use the app's own tokens. Headings use Newsreader (`@fontsource-variable/newsreader`, self-hosted, OFL); body text uses the app's system SF stack. Interactive pieces, all scripted on the app's original demo data with nothing sent anywhere: `src/Triage.tsx` (the Home demo: click it, then Space, ← →, Z, or drag the card sideways), `src/Ask.tsx` (the Ask panel: pick a question, or hold A or the hint to dictate), `src/Tour.tsx` (the hero window and the calendar: real screenshots you can click through, where each spot leads to the screen the app itself shows next), and in `src/Live.tsx` the shortcut list that answers the real keyboard, the per-feature AI provider picker, the pointer-tilting hero icon and the rising headline. Motion uses transform and opacity, scroll-linked effects use CSS scroll timelines where supported, and everything has a reduced-motion fallback.
- Icons are the real app icon, never redrawn: the bar uses `apps/desktop/assets/icon-64.png`; `node scripts/brand-assets.mjs` (instructions at its top) exports `src/assets/icon-512.webp`, `public/favicon.png`, `public/apple-touch-icon.png` and the social card `public/og.png` from the desktop icon PNGs.
- Replace the placeholder download and repository links in `src/site.ts` before launch.
- The privacy page is a draft with bracketed to-dos. Finish it before Google or Microsoft OAuth verification.
- `src/assets/shots/*.webp` are real screenshots of the app on its original demo data, in dark (`name.webp`) and light (`name-light.webp`): the hero window's screens (`hero-*`) and the calendar's (`calendar-*`); the page shows the one matching the visitor's appearance. `tours.json` beside them says where each clickable control sits and which screen it leads to. `scripts/capture-screenshots.mjs` recreates both headlessly: it presses every control in the real app and keeps a link only if the app then matches a captured screen (instructions are at its top).

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
