# Plan 003: A list that fails to refresh, and a consent that fails to save, say so

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- apps/desktop/src/renderer/screens/lists/MailListView.tsx apps/desktop/src/renderer/screens/lists/ListStates.tsx apps/desktop/src/renderer/screens/lists/listModel.ts apps/desktop/src/renderer/screens/ask/AskDockHost.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (UI error states)
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Claude Sonnet 5.5 (UI; load the `aplos-design` skill)

## Why this matters

Two places in the new app fail silently:

1. **Mail lists.** If a list that already shows rows fails to refresh, the
   owner sees the old rows with no hint they may be stale. The error screen
   only appears when the list is empty, and even then it never passes the
   reason, so a dead Google sign-in shows the generic "Couldn't load this list"
   instead of the existing "sign in again" copy.
2. **The Ask consent line.** When the owner clicks Allow and saving the consent
   fails, nothing happens and nothing is said; the button just looks dead.

After this plan, a failed refresh over existing rows shows one quiet error line
above the rows with Try again, the empty-list error names the reason, and a
failed consent save shows a toast.

## Current state

- `apps/desktop/src/renderer/screens/lists/MailListView.tsx:116-117`:

```tsx
  if (view.status === 'failed' && view.ids.length === 0) return <ListFailed />;
  if (view.status !== 'live' && view.ids.length === 0) return null;
```

  `view` is a `ViewResult` (`apps/desktop/src/renderer/data/index.ts:312-341`);
  `view.error` is `ErrorBody | null` and is set when `status` is `'failed'`.
  Below line 117 the rows render whatever the status is.

- `apps/desktop/src/renderer/screens/lists/ListStates.tsx:52-58` — the error
  component already maps reasons to copy (`listFailedWhy`, a few lines above)
  and offers Try again through `useReopen()`:

```tsx
export function ListFailed({ errorType }: { errorType?: string } = {}) {
  const reopen = useReopen();
  const why = listFailedWhy(errorType);
  if (why)
    return <ErrorLine kind="reason" text={why} retryable placement="column" onAction={reopen} />;
  return <ErrorLine kind="listFailed" placement="column" onAction={reopen} />;
}
```

  The Calendar screen already passes the reason
  (`apps/desktop/src/renderer/screens/calendar/CalendarScreen.tsx`, search for
  `ListFailed errorType`). Match it.

- `apps/desktop/src/renderer/screens/ask/AskDockHost.tsx:474-485` — the consent
  Allow handler swallows a failure:

```tsx
      onAllow={() => {
        if (!consent) return;
        void api.consent
          .grant({
            scope: 'background',
            version: consent.currentVersion,
            provider: askModel.provider as ProviderId,
            model: askModel.model,
          })
          .then(() => perform(consentGranted(cur())))
          .catch(() => undefined);
      }}
```

  The same file already shows the house style for a failure toast
  (`AskDockHost.tsx:330-336`):

```tsx
        pushToast({
          id: `ask-decide-${effect.proposalId}`,
          kind: 'info',
          message: `Couldn’t ${card.kicker.toLowerCase()}.`,
          undoable: false,
        });
```

- Copy rules (`.claude/skills/aplos-design/SKILL.md`, voice section; load it):
  plain words, no exclamation marks, no raw provider error, say what happened
  and what to do. `ErrorLine`'s own copy for kind `listFailed` is
  "Couldn’t load this list." with Try again
  (`apps/desktop/src/renderer/ui/list/ErrorLine.tsx:35-39`).

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| List tests | `(cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*')` | all pass |
| Ask tests | `(cd apps/desktop && npx tsx --test 'src/renderer/screens/ask/*.test.ts*')` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Design lint | `npm run lint:design` | exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:
- `apps/desktop/src/renderer/screens/lists/MailListView.tsx`
- `apps/desktop/src/renderer/screens/lists/listModel.ts`
- `apps/desktop/src/renderer/screens/lists/listModel.test.ts`
- `apps/desktop/src/renderer/screens/ask/AskDockHost.tsx`
- one new test file `apps/desktop/src/renderer/screens/lists/listFailed.test.tsx` (create)

**Out of scope**:
- `ErrorLine` and its props (`apps/desktop/src/renderer/ui/**`): reuse, don't change.
- Settings section loads and the Today calendar fetch (also swallow errors;
  deferred, see Maintenance notes).
- The reader's "Couldn't load this email" path: another thread owns it.

## Git workflow

- Branch from `origin/revamp`: `rv/improve/003-swallowed-failures`.
- Commit style: `Lists: a failed refresh over rows says so (improve 003)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Step 1: A pure rule for which failure line a list shows

Add to `listModel.ts`:

```ts
/** Which failure a list shows: the full-pane error when it has no rows, a line above the rows when it has some. */
export function listFailure(status: string, rowCount: number): 'pane' | 'line' | null {
  if (status !== 'failed') return null;
  return rowCount === 0 ? 'pane' : 'line';
}
```

Tests in `listModel.test.ts`: `('failed', 0)` → `'pane'`; `('failed', 3)` →
`'line'`; `('live', 0)` → `null`; `('opening', 5)` → `null`.

**Verify**: list tests pass, including the 4 new assertions.

### Step 2: Use it in `MailListView`, and pass the reason

Replace line 116 with a `listFailure(view.status, view.ids.length)` check:
- `'pane'` → `return <ListFailed errorType={view.error?.type} />;`
- `'line'` → render `<ListFailed errorType={view.error?.type} />` **above** the
  `ListBox` inside `.aplos-list-column` (not inside the listbox: only options
  belong there), and keep rendering the rows.

Keep line 117 as it is.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Test the reason pass-through

Create `listFailed.test.tsx`. Render with `renderToStaticMarkup` (no DOM is
needed; pattern: `listScreen.test.ts` lines 1-20 import `createElement` and
`renderToStaticMarkup`):
- `renderToStaticMarkup(createElement(ListFailed, { errorType: 'needsReauth' }))`
  contains `sign in again`.
- `renderToStaticMarkup(createElement(ListFailed, {}))` contains
  `load this list`.

**Verify**: list tests pass, including the new file.

### Step 4: Toast a failed consent save

In `AskDockHost.tsx`, replace `.catch(() => undefined)` at the consent Allow
handler (the one shown above, ~line 484; **not** the other `.catch` calls in
the file) with a toast:

```tsx
          .catch(() =>
            pushToast({
              id: 'ask-consent-failed',
              kind: 'info',
              message: 'Couldn’t save your choice. Try Allow again.',
              undoable: false,
            }),
          );
```

`pushToast` is already imported (line 25). Use the typographic apostrophe `’`
as the rest of the file does.

**Verify**: `npm run typecheck` → exit 0; ask tests pass.

### Step 5: Full gate

**Verify**: `npm run lint:design && npm run check` → exit 0.

## Test plan

- `listFailure` unit tests (Step 1).
- `listFailed.test.tsx` (Step 3).
- The consent toast is one call; covered by typecheck and review. If
  `ask.consent.test.ts` already drives `onAllow` with a fake `api`, add a case
  where `grant` rejects and assert a toast with id `ask-consent-failed` exists
  (`getToasts()` from `apps/desktop/src/renderer/shell/store-toast`, as
  `listScreen.test.ts` uses). If it does not drive `onAllow`, skip this.

## Done criteria

- [ ] `grep -n "ListFailed errorType" apps/desktop/src/renderer/screens/lists/MailListView.tsx` finds 2 sites
- [ ] `grep -n "ask-consent-failed" apps/desktop/src/renderer/screens/ask/AskDockHost.tsx` finds 1 site
- [ ] list and ask tests pass; `npm run check` exits 0
- [ ] Only in-scope files changed
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- Excerpts no longer match (drift).
- `ListFailed` cannot render without its `Reopenable` provider in the test
  (throws): report; don't change `Reopenable.tsx`.
- The design lint flags the error line above the rows as a forbidden pattern:
  report the rule it cites.

## Maintenance notes

- Deferred, same pattern, worth a follow-up: Settings → AI/General/Help section
  loads use `quiet = (p) => void p.catch(() => {})`
  (`apps/desktop/src/renderer/screens/settings/SettingsContainer.tsx:303`), so a
  failed load shows an empty section; the Today block's calendar fetch
  (`apps/desktop/src/renderer/screens/today/TodayHost.tsx:30-36`) also swallows.
  Lower impact (names/colours only for Today).
- Reviewer: the error line must not appear for `opening`/`stale` statuses, only
  `failed`.
