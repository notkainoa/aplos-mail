import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeController, resolveTheme, type ThemeMedia } from './theme';

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
  };
}

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const media: ThemeMedia & { matches: boolean; flip(next: boolean): void } = {
    matches,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    flip(next) {
      media.matches = next;
      for (const l of [...listeners]) l();
    },
  };
  return { media, listeners };
}

test('resolveTheme: light and dark win, system follows the OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('a dark system sets data-theme=dark at once and follows a later change', () => {
  const root = fakeRoot();
  const { media } = fakeMedia(true);
  const controller = createThemeController(root, media);
  assert.equal(root.attrs.get('data-theme'), 'dark');
  media.flip(false);
  assert.equal(root.attrs.get('data-theme'), 'light');
  assert.equal(controller.current, 'light');
});

test('an explicit choice ignores the system; going back to system follows it again', () => {
  const root = fakeRoot();
  const { media } = fakeMedia(true);
  const controller = createThemeController(root, media);
  controller.setChoice('light');
  assert.equal(root.attrs.get('data-theme'), 'light');
  media.flip(false);
  media.flip(true);
  assert.equal(root.attrs.get('data-theme'), 'light', 'a system change does not override light');
  controller.setChoice('system');
  assert.equal(root.attrs.get('data-theme'), 'dark');
});

test('without matchMedia it is light, and dispose stops following', () => {
  const root = fakeRoot();
  createThemeController(root, null);
  assert.equal(root.attrs.get('data-theme'), 'light');
  const { media, listeners } = fakeMedia(false);
  createThemeController(fakeRoot(), media).dispose();
  assert.equal(listeners.size, 0);
});
