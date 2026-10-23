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

## Deployment (Cloudflare Pages)

`.github/workflows/web-deploy.yml` builds the site and deploys it with Wrangler direct upload. It only runs when a change touches `apps/web/**`, `packages/**`, the root `package.json`/`package-lock.json` or the workflow itself.

- Pull request: preview deployment at `https://<branch>.<project>.pages.dev`, URL posted (and kept up to date) as a comment on the PR. Fork PRs are skipped because they cannot read secrets.
- Push to `main`: production deployment.
- Without the secrets below the job passes and does nothing.

One-time setup:

1. Create the Pages project with `main` as the production branch: `npx wrangler@4 pages project create aplos-mail --production-branch main` (after `npx wrangler login`), or in the dashboard as a Direct Upload project. If you pick another name, set the repo variable `CLOUDFLARE_PAGES_PROJECT`.
2. Create an API token (My Profile → API Tokens → Custom) with `Account → Cloudflare Pages → Edit`.
3. Add repo secrets: `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (the account ID is on the Cloudflare dashboard overview page).

`public/_headers` sets basic security headers and long-lived caching for hashed assets. A custom domain is added in the Pages project settings; nothing in the repo needs to change.
