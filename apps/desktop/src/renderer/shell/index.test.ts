/**
 * F9 shell surface tests. Run: `npx tsx --test apps/desktop/src/renderer/shell/index.test.ts`.
 * Compile-time: the call shapes other lanes use type-check, and the `@ts-expect-error` lines
 * pin what must not. Runtime: the examples render under react-dom/server (no DOM) and the
 * hooks read the live stores.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  closeSheet,
  navigate,
  openRoute,
  openSheet,
  pushToast,
  SHELL_LANE,
  useAppRoute,
  useCommandTarget,
  useCurrentTarget,
  useSettingsTarget,
  useSheet,
  useSheetContextActive,
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

/** Renders a hook-using function once, as a component, in node. */
function render(fn: () => string): string {
  return renderToString(createElement(() => fn()));
}

test('the lane marker is ui-shell', () => {
  assert.equal(SHELL_LANE, 'ui-shell');
});

test('the call examples run: a sheet opened is seen by readers until it closes', () => {
  assert.equal(render(sheetExample), '');
  openSheet('consent');
  assert.equal(
    render(() => {
      const open = useSheet();
      return open?.name ?? 'none';
    }),
    'consent',
  );
  assert.equal(
    render(() => String(useSheetContextActive())),
    'true',
  );
  closeSheet();
  assert.equal(
    render(() => String(useSheetContextActive())),
    'false',
  );
});

test('the target example renders and routes to Settings', () => {
  assert.equal(render(targetExample), '');
  const settings = render(() => {
    const target = useSettingsTarget();
    return `${target?.section}/${target?.row}`;
  });
  assert.equal(settings, 'mail/undoSeconds');
  assert.equal(
    render(() => String(useAppRoute())),
    'settings',
  );
  navigate('home');
});

test('hooks read the live toast stack', () => {
  const id = pushToast({ id: 'idx-1', kind: 'info', message: 'Hello', undoable: false });
  assert.equal(
    render(() =>
      useToasts()
        .map(t => t.id)
        .join(),
    ),
    id,
  );
});
