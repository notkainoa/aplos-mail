/**
 * The menu-bar item as plain data (host-2; plan 10 E1 item 4). `buildMenuModel` says which entries exist, their
 * labels and whether each is enabled; `main/menu-bar.ts` turns that into an Electron `Menu`. The "Pause sync for
 * 1 hour" state lives here too, at the host: today's engine has no pause method, so while paused main simply stops
 * forwarding wakes (see `main/lifecycle.ts`). The real engine's governor takes over later.
 * The glyph is a plain letter. There is never a sparkle, wand or star in this item.
 */

/** What the status line reads from the engine's state (`AppState.sync`); undefined until the engine answers. */
export interface SyncFacts {
  readonly busy: boolean;
  readonly error?: string;
}

export const PAUSE_MS = 60 * 60 * 1000;

export interface PauseState {
  /** True while a pause is running. A pause ends by itself at its deadline. */
  active(): boolean;
  /** The deadline of the running pause, if any. */
  until(): number | undefined;
  start(): void;
  resume(): void;
}

export function createPause(now: () => number, lengthMs = PAUSE_MS): PauseState {
  let until: number | undefined;
  const current = () => {
    if (until !== undefined && now() >= until) until = undefined;
    return until;
  };
  return {
    active: () => current() !== undefined,
    until: current,
    start() {
      until = now() + lengthMs;
    },
    resume() {
      until = undefined;
    },
  };
}

/** `HH:MM` on the 24-hour clock in the machine's time zone. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** One line for the disabled status entry. Never carries provider text, which could hold mail content. */
export function statusLine(sync: SyncFacts | undefined, pausedUntil: number | undefined): string {
  if (pausedUntil !== undefined) return `Paused until ${formatClock(pausedUntil)}`;
  if (!sync) return 'Starting…';
  if (sync.error) return 'Sync needs attention';
  return sync.busy ? 'Syncing…' : 'Caught up';
}

export type MenuEntryId = 'status' | 'open' | 'pause' | 'quit';

export type MenuEntry =
  | {
      readonly type: 'item';
      readonly id: MenuEntryId;
      readonly label: string;
      readonly enabled: boolean;
    }
  | { readonly type: 'separator' };

export function buildMenuModel(
  sync: SyncFacts | undefined,
  pausedUntil: number | undefined,
): MenuEntry[] {
  const paused = pausedUntil !== undefined;
  return [
    { type: 'item', id: 'status', label: statusLine(sync, pausedUntil), enabled: false },
    { type: 'separator' },
    { type: 'item', id: 'open', label: 'Open Aplos', enabled: true },
    {
      type: 'item',
      id: 'pause',
      label: paused ? 'Resume sync' : 'Pause sync for 1 hour',
      enabled: true,
    },
    { type: 'separator' },
    { type: 'item', id: 'quit', label: 'Quit Aplos completely', enabled: true },
  ];
}

/** The letter shown in the menu bar until the design system supplies a glyph. */
export const MENU_BAR_TITLE = 'A';
