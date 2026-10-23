# Aplos Mail website

Static marketing site: a landing page and a draft privacy policy. Vite + React, built to plain files in `dist/`. Always dark. No analytics, cookies or third-party scripts.

```sh
npm run web           # dev server, http://127.0.0.1:5273 (APLOS_WEB_PORT changes the port)
npm run web:build     # typecheck and build to apps/web/dist
npm run web:preview   # serve the built output
```

- Styling lives in `src/styles.css`. Colors follow the desktop app's dark tokens; the accent is the green of the app icon. `src/Triage.tsx` is the interactive Home demo (click it, then Space, ← →, Z). The icon is imported from `apps/desktop/assets/icon.svg`.
- Replace the placeholder download and repository links in `src/site.ts` before launch.
- The privacy page is a draft with bracketed to-dos. Finish it before Google or Microsoft OAuth verification.
- `src/assets/shots/*.webp` are real screenshots of the app on its original demo data. `scripts/capture-screenshots.mjs` recreates them headlessly (instructions are at its top).

## Deployment (Vercel)

The Vercel project `aplos-mail` is connected to this GitHub repository through Vercel's Git integration, so there is no workflow or secret in the repo.

- Pull request: Vercel builds a preview and comments the URL on the PR. Previews sit behind Vercel login (deployment protection).
- Merge to `main`: production deployment, publicly reachable.
- `vercel.json` (in this folder) sets the install command (only the site's dependencies, Electron is skipped), security headers, long-lived caching for hashed assets, and an ignored-build command: a deploy is skipped unless the last commit touched `apps/web`, `packages/` or the root `package.json` / `package-lock.json`. That check looks at the latest commit only, so a push of several commits where only an earlier one touched the site is skipped; redeploy from the Vercel dashboard if that happens.
- Project settings (set once through the API, not in the repo): Root Directory `apps/web` with source files outside the root enabled, framework Vite, Node 22, Web Analytics and Speed Insights off, deployment protection on previews only.
- A custom domain is added in the Vercel project settings; nothing in the repo needs to change.
