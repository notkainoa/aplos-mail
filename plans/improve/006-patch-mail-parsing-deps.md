# Plan 006: Patch the address-parser advisories in nodemailer and mailparser

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- package-lock.json apps/desktop/package.json packages/engine/package.json`
> If those changed, re-run `npm audit --omit=dev` and compare with the
> "Current state" below before proceeding.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (dependencies)
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Devin SWE-2 or Claude Haiku 5.5 (mechanical)

## Why this matters

`npm audit --omit=dev` reports three moderate advisories in nodemailer's
address parser (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h):
crafted From/To/Cc headers can parse into a recipient the displayed header does
not name. mailparser (which the legacy Gmail, IMAP and Outlook adapters use to
parse incoming mail) depends on that parser, and reply/reply-all recipients
come from what it parses. A patch release fixes all three. A fourth, low
advisory in fast-xml-parser (quadratic CPU on an unterminated tag,
GHSA-474x-hrwr-fgx4) is used by the CalDAV adapter. No high or critical
advisories exist. These libraries are used only by the legacy adapters in
`apps/desktop/src/main/` (the shipped app), not by the new engine's Gmail path.

## Current state

From `npm audit --omit=dev --json` at `8a254600`:

| Package | Installed (package-lock) | Vulnerable range | Fix |
|---|---|---|---|
| nodemailer | 10.1.1 | 3.0.0 - 10.1.3 | ≥ 10.1.4 |
| mailparser | 3.9.39 | 2.3.1 - 3.9.42 (via nodemailer) | a release that depends on nodemailer ≥ 10.1.4 |
| fast-xml-parser | 5.11.2 | ≤ 5.11.2 | > 5.11.2 |

Declarations:
- `apps/desktop/package.json:40` `"fast-xml-parser": "^5.11.2"`, `:43` `"mailparser": "^3.7.0"`, `:44` `"nodemailer": "^10.1.1"`.
- `packages/engine/package.json:31` `"fast-xml-parser": "^5.11.2"`.

Users: `apps/desktop/src/main/google.ts`, `imap.ts`, `imap-session.ts`,
`microsoft.ts` (mailparser/nodemailer), `apps/desktop/src/main/caldav.ts` and
`packages/engine/src/legacy/discover.ts` (fast-xml-parser). Tests that cover
them: `apps/desktop/tests/imap.test.ts`, `microsoft.test.ts`,
`integrations.test.ts`, `caldav.test.ts`, `discover.test.ts`.

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Audit | `npm audit --omit=dev` | after the fix: 0 moderate, 0 high, 0 critical |
| Desktop tests | `npm test -w @aplos/desktop` | all pass |
| Engine suite | `npm run test:engine` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**: `package-lock.json`, `apps/desktop/package.json`,
`packages/engine/package.json` (version ranges only).

**Out of scope**: any source file; any other dependency (do not run
`npm update` without a package name; do not run `npm audit fix --force`).

## Git workflow

- Branch from `origin/revamp`: `rv/improve/006-mail-parser-advisories`.
- Commit style: `Deps: nodemailer, mailparser and fast-xml-parser past their advisories (improve 006)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Step 1: Bump the three packages

```sh
npm install -w @aplos/desktop nodemailer@^10.1.4 mailparser@latest fast-xml-parser@latest
npm install -w @aplos/engine fast-xml-parser@latest
```

Then open `apps/desktop/package.json` and `packages/engine/package.json` and
confirm only these ranges changed.

**Verify**: `npm ls nodemailer mailparser fast-xml-parser` → nodemailer ≥ 10.1.4
everywhere it appears (including under mailparser), fast-xml-parser > 5.11.2.

### Step 2: Audit

**Verify**: `npm audit --omit=dev` → 0 moderate, 0 high, 0 critical.

### Step 3: Tests

**Verify**: `npm run typecheck && npm test -w @aplos/desktop && npm run test:engine` → exit 0.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Done criteria

- [ ] `npm audit --omit=dev` shows no moderate/high/critical
- [ ] `git diff --stat` touches only the three in-scope files
- [ ] `npm run check` exits 0
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- `mailparser@latest` still depends on a vulnerable nodemailer: report the
  version; do not add an `overrides` block without the owner's say.
- A bump is a major version (e.g. fast-xml-parser 6.x): stop and report.
- Any test fails after the bump: report which; do not change source to fit.
- `owners:check` says `apps/desktop/package.json` needs a lane label: open the
  PR anyway and say so in the description (the `plat-ci` lane owns it).

## Maintenance notes

- These libraries leave with the legacy adapters once the real engine is the
  release default. Until then Dependabot (`.github/dependabot.yml`) should keep
  proposing their patches; check it covers the `apps/desktop` workspace.
