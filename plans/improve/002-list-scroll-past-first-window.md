# Plan 002: Mouse and trackpad scrolling reach every row of a long list

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- apps/desktop/src/renderer/screens/lists/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (UI)
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Claude Sonnet 5.5 (UI work goes to Claude; load the `aplos-design` skill)

## Why this matters

The new app's mail lists (All mail, Sent, Trash, Spam, labels, Done, Bookmarks,
Drafts) show at most 200 rows at a time: the engine keeps a "window" of rows
and the renderer asks it to slide that window with `view.move(range)`. Today
the window only slides when the **keyboard cursor** moves (J/K). Nothing slides
it when the owner scrolls with a mouse or trackpad, so on a mailbox with
thousands of threads, scrolling stops dead at row 200 with no "more" row and no
hint. The data layer was designed for scroll-driven moves (its own doc comment
says "call with the virtualised list's visible range plus overscan"), but no
screen calls it that way. After this plan, scrolling near the end (or the
start) of the window slides it, and the cursor no longer yanks the scroll
position back when the window slides away from it.

## Current state

Files and roles:
- `apps/desktop/src/renderer/screens/lists/listModel.ts` — pure list logic (no React). Holds `LIST_WINDOW`, `rangeAround`, `absoluteIndex`, `settleKey`. Unit-tested in `listModel.test.ts`.
- `apps/desktop/src/renderer/screens/lists/useMailList.ts` — the list hook; contains `useScrollToCursor` and `useFollowCursor`.
- `apps/desktop/src/renderer/screens/lists/useIdCursor.ts` — the cursor as React state.
- `apps/desktop/src/renderer/screens/lists/MailListView.tsx` — renders the rows.
- `apps/desktop/src/renderer/data/index.ts:312-341` — `ViewResult` (has `ids`, `position`, `total`, `move`).

`apps/desktop/src/renderer/screens/lists/listModel.ts:8-9` and `:93-102`:

```ts
/** The most rows the engine keeps in a window (`WINDOW_MAX_ROWS`). */
export const LIST_WINDOW = 200;
// ...
export function rangeAround(index: number, total: number, size: number = LIST_WINDOW): ViewRange {
  const span = Math.max(1, Math.min(size, total));
  const start = Math.max(0, Math.min(total - span, index - Math.floor(span / 2)));
  return { start, end: start + span };
}

/** The index in the whole view of the id at `at` in a window that starts at `position`. */
export function absoluteIndex(position: number, at: number): number {
  return Math.max(0, position) + Math.max(0, at);
}
```

`apps/desktop/src/renderer/screens/lists/useMailList.ts:143-159` — the only
code that slides the window follows the cursor:

```ts
/** Keeps the cursor row in view as it moves. */
function useScrollToCursor(config: ListConfig, key: string | null): void {
  useEffect(() => {
    if (key === null) return;
    document.getElementById(rowDomId(config, key))?.scrollIntoView?.({ block: 'nearest' });
  }, [config, key]);
}

/** Asks the engine for the window around the cursor when the view is longer than one window. */
function useFollowCursor(view: ViewResult<unknown>, key: string | null): void {
  const { ids, position, total, move } = view;
  const at = key === null ? -1 : ids.indexOf(key);
  useEffect(() => {
    if (total <= LIST_WINDOW || at < 0) return;
    move(rangeAround(absoluteIndex(position, at), total));
  }, [total, position, at, move]);
}
```

`apps/desktop/src/renderer/screens/lists/useIdCursor.ts:33-41` — when the
cursor's row leaves `ids`, `settleKey` hands the cursor to a neighbour. A
window slide removes rows from `ids`, so after a scroll-driven slide the cursor
would jump to a row near the old position, and `useScrollToCursor` would then
scroll back to it. **This is the trap Step 2 removes.**

```ts
export function useIdCursor(source: readonly string[]): IdCursor {
  const ids = useStableIds(source);
  const [state, setState] = useState<CursorState>({ key: null, ids });
  const key = settleKey(state.ids, ids, state.key);
  if (state.ids !== ids || state.key !== key) setState({ key, ids });
  const setCursor = useCallback((next: string | null) => {
    setState(current => ({ ...current, key: next }));
  }, []);
  return { key, ids, setCursor };
}
```

`apps/desktop/src/renderer/screens/lists/MailListView.tsx:118-131` — where the
rows render (the `ListBox` is the ARIA listbox; only options may go inside it):

```tsx
  return (
    <div className="aplos-list-column" data-screen={config.kind} {...pointer}>
      <ListBox binding={binding} multiselectable={list.bulk.picking}>
        {config.dateGroups ? <Groups list={list} /> : <Rows list={list} ids={list.ids} />}
      </ListBox>
      <CommitTemplates forwardedRef={list.templates} />
```

Design constraints (from `.claude/skills/aplos-design/SKILL.md`, which you must
load before editing anything under `apps/desktop/src/renderer`): no spinners
for waits under 150 ms, keys are never blocked, no new visible chrome unless
the design names it. This plan adds **no visible UI**: the sentinels are empty,
zero-height, `aria-hidden` elements outside the listbox.

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| List unit tests | `(cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*')` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint (incl. design lint) | `npm run lint && npm run lint:design` | exit 0 |
| Full gate before commit | `npm run check` | exit 0 |
| Manual check | `npm run dev` (browser preview, stand-in data) | see Step 5 |

## Suggested executor toolkit

- Load `.claude/skills/aplos-design/SKILL.md` before editing renderer files.

## Scope

**In scope**:
- `apps/desktop/src/renderer/screens/lists/listModel.ts`
- `apps/desktop/src/renderer/screens/lists/listModel.test.ts`
- `apps/desktop/src/renderer/screens/lists/useMailList.ts`
- `apps/desktop/src/renderer/screens/lists/useIdCursor.ts`
- `apps/desktop/src/renderer/screens/lists/MailListView.tsx`

**Out of scope** (do NOT touch):
- `apps/desktop/src/renderer/data/**` — the window protocol already supports `move`.
- Home (`screens/home/**`) and Calendar — different layouts; not this bug.
- Row memoization / render performance — a separate concern; do not add `memo` here.
- Any engine code (`packages/engine/**`).

## Git workflow

- Branch from `origin/revamp`: `rv/improve/002-list-scroll-window`.
- Commit style: `Lists: scrolling slides the window past the first 200 rows (improve 002)`.
- Run `npm run check` before every commit; author Kainoa Newton <k@kainoa.me>.
- No push/PR unless the operator asked. Never touch `main`.

## Steps

### Step 1: Add a pure `edgeRange` helper with tests

In `listModel.ts`, add:

```ts
/**
 * The window to ask for when the scroll reaches one edge of the rows shown: centred on the edge row, or null when
 * the view has no rows beyond that edge.
 */
export function edgeRange(
  position: number,
  count: number,
  total: number,
  edge: 'start' | 'end',
): ViewRange | null {
  if (count === 0) return null;
  if (edge === 'end') {
    const last = absoluteIndex(position, count - 1);
    return last >= total - 1 ? null : rangeAround(last, total);
  }
  const first = Math.max(0, position);
  return first <= 0 ? null : rangeAround(first, total);
}
```

Add tests to `listModel.test.ts` (import `edgeRange` beside the existing
imports from `./listModel`):
- `edgeRange(0, 200, 5000, 'end')` → `{ start: 99, end: 299 }`.
- `edgeRange(0, 200, 5000, 'start')` → `null`.
- `edgeRange(4800, 200, 5000, 'end')` → `null`.
- `edgeRange(1000, 200, 5000, 'start')` → `{ start: 900, end: 1100 }`.
- `edgeRange(0, 0, 0, 'end')` → `null`.

**Verify**: `(cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*')` → all pass, including 5 new assertions (one or more new `test(...)` blocks).

### Step 2: Scroll to the cursor only when the cursor was moved on purpose

Change `useIdCursor` so it reports whether the latest key change came from
`setCursor` (a key press, click or command) rather than from settling. Add a
counter to the state that only `setCursor` increments:

```ts
interface CursorState {
  readonly key: string | null;
  readonly ids: readonly string[];
  /** Bumped by `setCursor` only: a settle (rows leaving or a window slide) never scrolls the list. */
  readonly moves: number;
}
```

Expose `moves` on `IdCursor`. In `useMailList.ts`, change `useScrollToCursor`
to take `moves` and depend on it instead of `key`, so the scroll happens when
the owner moved the cursor, not when a window slide settled it. Keep the
`key === null` guard. Pass `cursor.moves` at the call site (line ~204:
`useScrollToCursor(config, cursor.key);`).

Also stop `useFollowCursor` from re-centring on a cursor that settled out of
view: it should only run when `moves` changed. Add `moves` as a parameter and
use a ref holding the last `moves` value it acted on; return early if equal.

**Verify**: `npm run typecheck` → exit 0; the list unit tests still pass.

### Step 3: Slide the window when an edge sentinel scrolls into view

In `MailListView.tsx`, render two empty sentinels **outside** the `ListBox`:
one immediately before it and one immediately after it:

```tsx
<div ref={topRef} className="aplos-list-edge" aria-hidden="true" />
<ListBox ...>...</ListBox>
<div ref={bottomRef} className="aplos-list-edge" aria-hidden="true" />
```

Add a small hook in `useMailList.ts` (named export, small function), for example
`useEdgeSlide(view, topRef, bottomRef)`, that creates one `IntersectionObserver`
(root `null`, `rootMargin: '600px 0px'`) observing both sentinels. When the
bottom sentinel intersects, call
`view.move(range)` with `range = edgeRange(view.position, view.ids.length, view.total, 'end')`
if it is not null; same for the top with `'start'`. Read the latest `view`
through a ref so the observer is created once per mount and disconnected in the
effect cleanup. Do nothing when `view.status !== 'live'` or
`view.total <= LIST_WINDOW`.

The sentinel class needs no new CSS unless lint requires it; if it does, add
`.aplos-list-edge { block-size: 0; }` next to the other `.aplos-list-*` rules
in `apps/desktop/src/renderer/ui/list/list.css` (then that file is in scope).

**Verify**: `npm run typecheck && npm run lint && npm run lint:design` → exit 0.

### Step 4: Unit-test what can be unit-tested

There is no DOM library in the unit tests, so the observer itself is checked by
hand in Step 5. Make sure `edgeRange` covers the decision logic and that the
hook is a thin wrapper around it.

**Verify**: `(cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*')` → all pass.

### Step 5: Manual check on an emulated mailbox

Run `npm run dev` (the browser preview; in a development build without the
engine bridge the new renderer boots on the in-process stand-in, see
`apps/desktop/src/renderer/entry.ts` header). Open the printed URL in a
headless browser (never drive a visible window on the shared Mac), open
**All mail**. If it holds fewer than 300 rows, note that in your report and
skip to Step 6 (the reviewer checks on the owner's real mailbox with
`APLOS_ENGINE=real`, `plans/HAND-CHECK.md` "Two ways to launch").
Otherwise: scroll with the wheel to the bottom of the list. Expected: more
rows appear without pressing a key; scroll position does not jump back to the
cursor row; pressing J afterwards moves the cursor from where it was and
scrolls to it.

**Verify**: write what you observed in your report.

### Step 6: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New `edgeRange` tests in `listModel.test.ts` (pattern: the existing
  `rangeAround` tests in the same file).
- Manual scroll check (Step 5); the reviewer repeats it on a large mailbox.

## Done criteria

- [ ] `edgeRange` exported from `listModel.ts` with ≥5 assertions in `listModel.test.ts`
- [ ] `grep -n "IntersectionObserver" apps/desktop/src/renderer/screens/lists/useMailList.ts` finds the edge hook
- [ ] `grep -n "aria-hidden" apps/desktop/src/renderer/screens/lists/MailListView.tsx` finds both sentinels
- [ ] `npm run check` exits 0
- [ ] Only in-scope files changed (`git status`)
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- The excerpts above no longer match (drift).
- `useIdCursor` or `settleKey` turn out to be used by screens other than the
  lists (`grep -rn "useIdCursor" apps/desktop/src/renderer`): changing the
  scroll trigger could affect them. Report the callers first.
- After Step 3, the scroll position jumps on every slide (rows above the
  viewport removed without scroll anchoring). Report it with what you saw; the
  likely fix is to keep a fixed row as the scroll anchor, which needs a design
  call.
- The design lint rejects the sentinels.

## Maintenance notes

- Any future list virtualisation must keep calling `view.move` from the visible
  range; the sentinels are the minimal version of that.
- Reviewer: check that the cursor no longer scrolls the page on a settle
  (Done/Later of the cursor row should still move the cursor to the neighbour,
  but should not scroll unless that neighbour is off screen, which
  `scrollIntoView({ block: 'nearest' })` still handles when `moves` changes).
- Deferred: per-row `memo` for `Row` (each J/K re-renders up to 200 rows).
  Profile first; plan only if long frames show up.
