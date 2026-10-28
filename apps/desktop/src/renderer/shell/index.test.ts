/**
 * F9 shell surface tests. Run: `npx tsx --test apps/desktop/src/renderer/shell/index.test.ts`.
 * Compile-time: the call shapes other lanes use type-check, and the `@ts-expect-error` lines
 * pin what must not. Runtime: every stub throws `NotImplementedError` naming lane ui-shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSheet,
  dismissToast,
  NotImplementedError,
  openRoute,
  openSheet,
  pushToast,
  SHELL_LANE,
  updateToast,
  useCommandTarget,
  useCurrentTarget,
  useSheet,
  useToasts,
} from './index';
import type { OpenSheet } from './index';

/** The status slot, Settings and Ask open sheets; the sheet slot renders whichever is open. */
function sheetExample(): string {
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  openSheet('reconnect', { accountId: 'a1', mode: 'grant' });
  openSheet('consent');
  openSheet('consent', { provider: 'groq', model: 'llama-3.3-70b-versatile' });
  // @ts-expect-error: the reconnect sheet needs its account.
  openSheet('reconnect');
  // @ts-expect-error: there is no such sheet.
  openSheet('compose', {});
  const open: OpenSheet | null = useSheet();
  if (open?.name === 'reconnect') return open.args.mode === 'grant' ? 'Grant access' : 'Reconnect';
  closeSheet();
  return '';
}

/** The reader names its thread for the palette's context line; Settings rows deep-link. */
function targetExample(): string {
  useCommandTarget({
    kind: 'thread',
    id: 't1',
    title: 'Drew Bell',
    detail: 'October illustrations',
  });
  // @ts-expect-error: a target says what it is.
  useCommandTarget({ id: 't1', title: 'Drew Bell' });
  openRoute('settings/mail#undoSeconds');
  // @ts-expect-error: only known Settings sections route.
  openRoute('settings/nowhere');
  return useCurrentTarget()?.title ?? '';
}

function assertNotImplemented(fn: () => unknown, member: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(
      err instanceof NotImplementedError,
      `${member} threw something other than NotImplementedError`,
    );
    assert.equal(err.lane, 'ui-shell');
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    assert.equal(err.member, member);
    assert.match(err.message, /ui-shell/);
    return true;
  });
}

test('the lane marker is ui-shell', () => {
  assert.equal(SHELL_LANE, 'ui-shell');
});

test('every shell stub throws NotImplemented naming ui-shell', () => {
  assertNotImplemented(() => openSheet('consent'), 'openSheet');
  assertNotImplemented(() => closeSheet(), 'closeSheet');
  assertNotImplemented(() => useSheet(), 'useSheet');
  assertNotImplemented(() => useCommandTarget(null), 'useCommandTarget');
  assertNotImplemented(() => useCurrentTarget(), 'useCurrentTarget');
  assertNotImplemented(() => openRoute('settings/ai'), 'openRoute');
  const toast = { id: 'op-1', kind: 'later', message: 'Moved to Later', undoable: true } as const;
  assertNotImplemented(() => pushToast(toast), 'pushToast');
  assertNotImplemented(() => updateToast('op-1', { message: 'Done' }), 'updateToast');
  assertNotImplemented(() => dismissToast('op-1'), 'dismissToast');
  assertNotImplemented(() => useToasts(), 'useToasts');
});

test('the examples type-check and stop at the first stub', () => {
  assertNotImplemented(() => sheetExample(), 'openSheet');
  assertNotImplemented(() => targetExample(), 'useCommandTarget');
});
