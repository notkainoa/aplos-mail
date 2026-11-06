# plans/OWNERS.md format

`scripts/audit/owners-check.mjs` reads `plans/OWNERS.md`. The file is ordinary Markdown; only tables are read. Anything the parser cannot read unambiguously is an error (see "Errors"), never silently dropped.

## Tables

A table is read when its header row has a **Path** (or **Paths**) column and a **Lane** (or **Owner**) column. Both are required: a table with only one of them is an error. A **Thread** column is optional; without it the thread comes from the nearest heading that ends in "thread" (`## Engine thread` gives "Engine"). Column names are case-insensitive, other columns are ignored, and tables with neither (for example `File | Rule`) and all text outside tables are ignored. Every row, and the header, must start with `|` and have as many cells as the header; a literal pipe inside a cell is written `\|`.

```
| Path | Lane | Thread | Notes |
|---|---|---|---|
| `packages/engine/src/store/**` | eng-store | Engine | |
| `scripts/audit/**`<br>`.github/workflows/ci.yml` | plat-ci | Platform and website | |
| `tools/lint/**` | plat-ci | Platform and website | |
| `tools/lint/design/**` | ui-foundation | UI-core | more specific, so it wins |
| `PROGRESS.md`, `DECISIONS.md` | * | | shared |
```

The lane-first layout works too (`| Lane | Paths |` under `## Engine thread` headings, lane written in backticks).

## Path cell

- Globs in backticks, separated by commas or `<br>`. Without any backticks the whole cell is split on commas and `<br>`. Commas inside `{...}` do not split.
- Only the first sentence of the cell is read (text after ". " plus a capital letter may mention paths freely), and `(except ...)` notes are dropped: carve-outs are separate, more specific rows of the other lane.
- Paths are relative to the repository root, with `/` separators. A glob ending in `/` is ignored with a warning; write `dir/**` for everything below.
- `**` matches anything including `/` (`a/**/b` also matches `a/b`), `*` matches within one path segment, `?` one character, `{a,b}` alternatives (nesting is allowed).

## Lane cell

- A lowercase slug such as `eng-store` (letters, digits, single hyphens), case-insensitive in the file. Anything else (`eng-store (assumed)`, `**`) is an error.
- `*` or `all` marks a shared path that anyone may edit.
- A lane cell starting with "Round 2" or containing "reserved" is a reservation row: its Path cell has segments separated by `;`, each optionally `` `lane`: globs ``; a segment without a label belongs to the pseudo lane `reserved`. Nobody acts as `reserved` and these lanes have no thread, so no branch may edit those paths without an approval.
- Built-in shared paths, used unless the file has a row for the same glob: `PROGRESS.md`, `DECISIONS.md`, `TODO.md`, `plans/STATUS.md`, `package-lock.json`.

## Thread

`rv/thread/<name>` acts as every lane whose thread equals `<name>` (case and punctuation ignored: `ui-core` is "UI-core"). If nothing matches exactly, `<name>` may be the start of one thread's name in whole words (`platform` is "Platform and website"); a prefix that fits two threads (`ui`) is an error. A lane whose own name is `<name>` also counts (`rv/thread/integrator` acts as `integrator`).

## Which lane owns a file

Among all matching globs the **most specific** wins: the longest literal prefix before the first wildcard, then fewer wildcards, then the longer glob. So `tools/lint/**` (plat-ci) together with `tools/lint/design/**` (ui-foundation) needs no "except". Two different lanes tying at the same specificity on a file, or the same glob listed for two lanes, is an error. A file that matches nothing is unowned and fails the check.

## Which rules apply to a change

The change check reads `plans/OWNERS.md` from the integration branch, never from the change being checked: `--base <ref>` if given, else the tip of `origin/revamp` (or `revamp`). A pull request cannot delete, rename or rewrite the file to pass; editing it is an ordinary change to an integrator-owned file. If the file does not exist on the integration branch yet (the commit that adds it), the check prints `pending` and exits 0. `--validate` and `--owners <file>` read the working-tree or given file instead.

## Approvals

A change by lane A to a file owned by lane B passes when B approved it:

- `--approved B`, or with `--pr N` the PR label `lane-approved:B`. These cover the whole change. The labels are the authoritative record.
- A `Lane-Approved: B` trailer is read only with `--trailers` (off by default, 2026-11-05): the PR's own author writes its commits, so a trailer is self-attested and is not an approval. With `--trailers` (lanes separated by commas; each item must be exactly one known lane name, anything else approves nothing and is reported) it covers only the files of its own commit, and a file is covered only if every commit in `base..head` that touched it carries the approval. `--no-trailers` is still accepted and turns a `--trailers` earlier on the line back off.
- `Owners-Exempt: phase-0` on a commit (the restructure chain; read only with `--trailers`) exempts that commit's files from every check, but only when the integrator lane approved the change (`--approved integrator`, the label `lane-approved:integrator`, or an `rv/thread/integrator` branch).

An unowned file cannot be approved; the Integrator adds it to `plans/OWNERS.md`.

## Commands

```
node scripts/audit/owners-check.mjs --validate [--strict] [--json]   # check the file itself
node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>] [--approved <lane,...>] [--pr <n>] [--trailers] [--json]
```

`--validate` reports errors (ties, malformed tables, bad lanes), warnings (globs ending in `/`), and tracked files that match no glob (a warning with a count, an error only with `--strict`). The change check diffs the merge-base of `HEAD` and the integration branch to `HEAD`, takes the acting lane from `--lane` or the branch name (`rv/<lane>/<slug>`, `rv/thread/<name>`, or `GITHUB_HEAD_REF` in a detached CI checkout), and passes immediately when nothing changed. On `revamp` and `main` it is skipped (unless `--lane` is given or `GITHUB_BASE_REF` is set, i.e. a pull request). Exit codes: 0 ok, 1 violations or an invalid file, 2 usage error.

## Errors

An error fails both `--validate` and the change check: a table header or row without a leading `|`, a row whose cell count differs from the header, a table with Path but no Lane column or the reverse, a lane name that is not a slug or `*`, unbalanced braces, a row with paths and no lane, a lane listed under two threads, a glob given to two lanes, and a file owned equally by two lanes.
