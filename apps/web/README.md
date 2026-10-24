# Aplos Mail website

Static marketing site: a landing page and a draft privacy policy. Vite + React, built to plain files in `dist/`. Light and dark, following the system until the visitor picks one (kept in localStorage, no cookies). No analytics or third-party scripts; the display font is self-hosted.

```sh
npm run web           # dev server, http://127.0.0.1:5273 (APLOS_WEB_PORT changes the port)
npm run web:build     # typecheck and build to apps/web/dist
npm run web:preview   # serve the built output
```

- Styling lives in `src/styles.css`. The page is the app icon laid out top to bottom: sky (hero), a paper middle, grass (the close), with the airmail border of the envelope as the seam. Neutrals, the blue accent and the surfaces inside the demo are the app's own tokens (`apps/desktop/src/renderer/ui/tokens.css`); sky, grass, airmail red and blue are sampled from the icon. Headings use Fraunces (SOFT axis, self-hosted through `@fontsource-variable/fraunces`); everything else is the system font, as in the app. Fields (`.sky`, `.soft`, `.grass`, `.paper`) set their own ground, ink and button colour; `src/Triage.tsx` is the interactive Home demo (click it, then Space, ← →, Z) and the keycaps in "Keyboard on every control" press with the real keys.
- The icon is never redrawn. `scripts/build-brand.mjs` exports the hero icon (`src/assets/brand/icon-640.webp`), the favicon, the Apple touch icon and the share image (`public/og.png`) from `apps/desktop/assets/icon.png` and `icon-256.png`; run it again after the icon changes (the header and footer use `icon-64.png` directly). The favicon and share image links point at `https://aplos.email`.
- The share image, favicon and "download" link live outside the copy: the download button is `releasesUrl` in `src/site.ts` (the latest GitHub release).
- The privacy page is a draft with bracketed to-dos. Finish it before Google or Microsoft OAuth verification.
- `src/assets/shots/*-light.webp` and `*-dark.webp` are real screenshots of the app on its original demo data, one pair per theme. `scripts/capture-screenshots.mjs` recreates them headlessly (instructions are at its top).

## Deployment (Vercel)

The Vercel project `aplos-mail` is connected to this GitHub repository through Vercel's Git integration, so there is no workflow or secret in the repo.

- Pull request: Vercel builds a preview and comments the URL on the PR. Previews sit behind Vercel login (deployment protection).
- Merge to `main`: production deployment, publicly reachable.
- `vercel.json` (in this folder) sets the install command (only the site's dependencies, Electron is skipped), security headers, long-lived caching for hashed assets, and an ignored-build command: a deploy is skipped unless the site, `packages/`, or the root `package.json` / `package-lock.json` changed since the last deployed commit on that branch (`VERCEL_GIT_PREVIOUS_SHA`; with no previous deploy, or if that commit is not in the shallow clone, it builds). A skipped build shows on the PR as "Canceled by Ignored Build Step", which is expected, not a failure; the earlier preview URL still stands.
- Project settings (set once through the API, not in the repo): Root Directory `apps/web` with source files outside the root enabled, framework Vite, Node 22, Web Analytics and Speed Insights off, deployment protection on previews only.
- A custom domain is added in the Vercel project settings; nothing in the repo needs to change.
