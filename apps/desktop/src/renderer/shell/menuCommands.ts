// The native menu bar (main/menu-bar.ts) sends one `command` event per item the owner picks, with the item's word as
// its payload. The legacy renderer answered them; the new shell answers the ones that have a command in the registry
// (Edit → Undo Mail Action, File → New Message, the View and Navigate items). The listener is typed (`only: ['command']`),
// so it never takes the deep-link and prepare-close events held for others.

/** The part of preload's bridge this needs. */
export interface MenuBridge {
  subscribe(
    listener: (event: { type: string; payload?: unknown }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** A menu item's word, and the registry command it runs. */
export const MENU_COMMANDS: Readonly<Record<string, string>> = {
  undo: 'app.undo',
  compose: 'mail.compose',
  // The menu says "Search Mail ⌘K", and ⌘K is the shell's palette (which searches): a menu accelerator is taken before the page sees the key.
  search: 'app.palette',
  settings: 'app.settings',
  ask: 'ask.toggleDock',
  home: 'nav.home',
  later: 'nav.later',
  all: 'nav.allMail',
  calendar: 'nav.calendar',
  back: 'nav.back',
  shortcuts: 'app.shortcuts',
  'toggle-sidebar': 'app.sidebar',
};

/** Subscribes for menu `command` events; each known one runs its registry command. Returns the unsubscribe. */
export function listenMenuCommands(
  bridge: MenuBridge | undefined,
  run: (commandId: string) => unknown,
): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  return bridge.subscribe(
    event => {
      if (event.type !== 'command' || typeof event.payload !== 'string') return;
      const id = Object.hasOwn(MENU_COMMANDS, event.payload)
        ? MENU_COMMANDS[event.payload]
        : undefined;
      if (id) run(id);
    },
    { only: ['command'] },
  );
}
