# Local CI (replaces the dead GitHub Actions jobs)

Owner decision (2026-11-04): no paid GitHub Actions minutes — the CI workflow cannot run. Use
`scripts/local-ci.sh` instead, from the repo root:

    scripts/local-ci.sh <ref>          # e.g. origin/revamp, a PR head sha, HEAD~1
    scripts/local-ci.sh --package      # add the electron-builder packaging smoke
    scripts/local-ci.sh --no-e2e --no-web   # skip the slow browser suite / the web job

It makes a throwaway `git worktree` of the ref in a mktemp dir, runs `npm ci --ignore-scripts`,
then every job `ci.yml` ran, in order: the static job (format, lint, test:lint, test:audit,
lint:css, lint:design, `owners-check --validate`, typecheck, `npm audit`), the slots
(check:openapi/tokens/contrast/identity, test:visual, check:budgets), the engine suite under
Electron's Node (check:sqlite + test:engine), desktop tests, package tests, the headless browser
e2e project, the web typecheck+build, and the desktop build. Everything runs `nice -n 10`; it
never touches the checkout you launch it from. It ends with a PASS/FAIL/SKIP table and exits 1
on any FAIL; a network-dependent step that cannot reach its service is SKIP, not FAIL.

Use it on the head of an Opus-gated or engine PR before merge, and once a day on `origin/revamp`
(the former push trigger). Expect roughly 15–30 minutes for a full run on this Mac; per-step
logs land under the scratch dir it prints. `--keep` keeps the worktree for poking at a failure.
