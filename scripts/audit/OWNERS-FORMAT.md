# plans/OWNERS.md format

`scripts/audit/owners-check.mjs` reads `plans/OWNERS.md`. The file is ordinary Markdown; only tables are read.

## Tables

A table is read when its header row has a **Path** (or **Paths**) column and a **Lane** column. A **Thread** column is optional but needed for `rv/thread/<name>` branches. Column names are case-insensitive, other columns (Notes, Status, Round) are ignored, and tables without Path and Lane columns and all text outside tables are ignored.

```
| Path | Lane | Thread | Notes |
|---|---|---|---|
| `packages/engine/src/store/**` | eng-store | Engine | |
| `scripts/audit/**`<br>`.github/workflows/ci.yml` | plat-ci | Platform and website | |
| `tools/lint/**` | plat-ci | Platform and website | |
| `tools/lint/design/**` | ui-foundation | UI-core | more specific, so it wins |
| `PROGRESS.md`, `DECISIONS.md` | * | | shared |
```

## Path cell

- One or more globs in backticks, separated by commas or `<br>`. If a cell has no backticks, the whole cell is split on commas and `<br>`. Commas inside `{...}` do not split.
- Paths are relative to the repository root, with `/` separators.
- `**` matches anything including `/` (`a/**/b` also matches `a/b`), `*` matches within one path segment, `?` one character, `{a,b}` alternatives (nesting is allowed). A trailing `/` means everything below.

## Lane cell

- A lane name such as `eng-store`, case-insensitive.
- `*` or `all` marks a shared path that anyone may edit.

## Thread cell

Names the thread the lane belongs to. Branch `rv/thread/<name>` acts as every lane whose thread matches `<name>` case-insensitively, ignoring punctuation, and a thread may be written in full or by its first word(s): `rv/thread/platform` matches "Platform and website".

## Which lane owns a file

Among all matching globs the **most specific** wins: the longest literal prefix before the first wildcard, then fewer wildcards, then the longer glob. So `tools/lint/**` (plat-ci) together with `tools/lint/design/**` (ui-foundation) needs no "except". Two different lanes tying at the same specificity on a file, or the same glob listed for two lanes, is a validation error. A file that matches nothing is unowned.

## Approvals

A change by lane A to a file owned by lane B passes when B approved it: `--approved B`, a `Lane-Approved: B` trailer on a commit in `base..head`, or (with `--pr N`) the PR label `lane-approved:B`. An unowned file cannot be approved; the Integrator adds it to `plans/OWNERS.md`.

## Commands

```
node scripts/audit/owners-check.mjs --validate [--strict] [--json]   # check the file itself
node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>] [--approved <lane,...>] [--pr <n>] [--json]
```

`--validate` reports parse errors, ties, and tracked files that match no glob (a warning with a count, an error only with `--strict`). The change check defaults to the merge-base of `HEAD` and `origin/revamp`, and takes the acting lane from `--lane` or from the branch name (`rv/<lane>/<slug>`, `rv/thread/<name>`). While `plans/OWNERS.md` does not exist it prints `pending: plans/OWNERS.md not on this branch yet` and exits 0. Exit codes: 0 ok, 1 violations or an invalid file, 2 usage error.
