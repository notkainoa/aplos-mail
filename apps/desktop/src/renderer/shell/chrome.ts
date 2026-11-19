/**
 * Window chrome state for the shell (DESIGN 7.1): whether the window is in macOS fullscreen (main relays
 * `enter-full-screen`/`leave-full-screen` as a `fullscreen` bridge event) and whether the sidebar is collapsed
 * (persisted in localStorage). The macOS traffic lights only overlap the sidebar when the window is not
 * fullscreen, so the sidebar's top block is two rows then and one row otherwise.
 */
import { useSyncExternalStore } from 'react';
import { createStore } from './store-core';

/** The chrome state the shell draws: fullscreen comes from main, collapsed is the owner's toggle. */
export interface ChromeState {
  readonly fullscreen: boolean;
  readonly collapsed: boolean;
}

/** localStorage key for the collapsed sidebar. */
export const SIDEBAR_COLLAPSED_KEY = 'aplos.sidebar.collapsed';

/** The part of preload's bridge this needs (the same shape closeHandshake and mainNavigate declare). */
export interface ChromeBridge {
  subscribe(
    listener: (event: { type: string; payload?: unknown }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** The smallest storage shape persistence needs; `localStorage` satisfies it, tests pass a fake. */
export interface ChromeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The shared instance, or undefined where there is no DOM (node tests, SSR). */
function defaultStorage(): ChromeStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

/**
 * True when the window runs on macOS and must reserve the traffic-light row while not fullscreen.
 * `navigator.platform` is the signal ('MacIntel', 'MacPPC'); the user agent is the fallback where
 * platform is unavailable. Browser previews on other platforms reserve nothing.
 */
export function isMacChrome(platform: string | undefined, userAgent: string | undefined): boolean {
  if (platform) return /^mac/i.test(platform);
  return /macintosh|mac os x/i.test(userAgent ?? '');
}

/** The persisted collapsed flag for `storage` (defaults to the page's); false when unreadable or absent. */
export function readCollapsed(storage: ChromeStorage | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persists the collapsed flag; a denied or absent storage is ignored (private mode, tests). */
export function writeCollapsed(
  collapsed: boolean,
  storage: ChromeStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // Persistence is a nicety; the toggle still works for the session.
  }
}

/** True on macOS (the traffic lights live in the sidebar's top row while the window is not fullscreen). */
export function macChrome(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return isMacChrome(nav?.platform, nav?.userAgent);
}

const chromeStore = createStore<ChromeState>({
  fullscreen: false,
  collapsed: readCollapsed(),
});

/** The live chrome state for React. */
export function useChrome(): ChromeState {
  return useSyncExternalStore(chromeStore.subscribe, chromeStore.get, chromeStore.get);
}

/** The live chrome state outside React (command handlers, tests). */
export function getChrome(): ChromeState {
  return chromeStore.get();
}

/** Main's fullscreen signal; the sidebar's top layout follows it. */
export function setFullscreen(fullscreen: boolean): void {
  const current = chromeStore.get();
  if (current.fullscreen !== fullscreen) chromeStore.set({ ...current, fullscreen });
}

/** Shows or hides the sidebar; persists under `SIDEBAR_COLLAPSED_KEY`. */
export function setCollapsed(collapsed: boolean, storage?: ChromeStorage): void {
  const current = chromeStore.get();
  if (current.collapsed === collapsed) return;
  writeCollapsed(collapsed, storage);
  chromeStore.set({ ...current, collapsed });
}

/** Toggles the collapsed flag. */
export function toggleCollapsed(storage?: ChromeStorage): void {
  setCollapsed(!chromeStore.get().collapsed, storage);
}

/** The `fullscreen` event's payload, or null for anything else. */
function fullscreenOf(event: { type: string; payload?: unknown }): boolean | null {
  if (event.type !== 'fullscreen' || typeof event.payload !== 'object' || event.payload === null)
    return null;
  const value = (event.payload as { fullscreen?: unknown }).fullscreen;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Follows the window's fullscreen state: subscribes typed (`only: ['fullscreen']`), so it never takes the
 * events held for the app's own first plain subscribe. No bridge (browser preview, tests) means windowed
 * forever, which is already the default. Returns the unsubscribe.
 */
export function listenFullscreen(bridge: ChromeBridge | undefined): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  return bridge.subscribe(
    event => {
      const fullscreen = fullscreenOf(event);
      if (fullscreen !== null) setFullscreen(fullscreen);
    },
    { only: ['fullscreen'] },
  );
}
