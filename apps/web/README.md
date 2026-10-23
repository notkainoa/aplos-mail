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
