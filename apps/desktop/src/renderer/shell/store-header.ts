/**
 * The pane header a screen asks for (DESIGN 7.1): back or close, the crumb, up to three tools. The shell owns Ask and
 * the calendar button and draws the header; a screen only describes its part. The description sits in a module store
 * (one owner at a time), compared by value, so an inline object (new closures every render) never re-renders the shell.
 * The store publishes stable wrappers that call the owner's latest callbacks.
 */
import { createStore } from './store-core';
import type { CommandId } from '../commands';
import type { PaneHeaderProps } from '../ui/props';

/** What a screen describes; `askScope` says whether Ask means the whole mailbox (default) or the open email. */
export type ScreenPaneHeader = Omit<PaneHeaderProps, 'ask' | 'today'> & {
  readonly askScope?: PaneHeaderProps['ask']['scope'];
};

const headerStore = createStore<ScreenPaneHeader | null>(null);
let owner: object | null = null;
let live: ScreenPaneHeader | null = null;
let signature = '';

/** The same description once functions are set aside (JSON drops them): what the owner means, not which closures it made. */
function signatureOf(header: ScreenPaneHeader | null): string {
  return header === null ? '' : JSON.stringify(header);
}

function stable(header: ScreenPaneHeader): ScreenPaneHeader {
  const { lead, onTool } = header;
  return {
    ...header,
    lead: lead && { ...lead, onPress: () => live?.lead?.onPress() },
    onTool: onTool && ((id, anchor) => live?.onTool?.(id, anchor)),
  };
}

/** `owner` sets the screen's header (null clears it). A change of value publishes; otherwise only the callbacks are kept up to date. */
export function setPaneHeader(who: object, header: ScreenPaneHeader | null): void {
  if (header === null) return clearPaneHeader(who);
  owner = who;
  live = header;
  const next = signatureOf(header);
  if (next === signature && headerStore.get() !== null) return;
  signature = next;
  headerStore.set(stable(header));
}

/** Clears the header, but only for the owner that set it (a screen unmounting after its successor mounted must not clear the successor's). */
export function clearPaneHeader(who: object): void {
  if (owner !== who) return;
  owner = null;
  live = null;
  signature = '';
  headerStore.set(null);
}

export const getPaneHeader = headerStore.get;
export const subscribePaneHeader = headerStore.subscribe;

/** The shell's header: the screen's description with Ask and the calendar button added. A tool press goes to the screen's `onTool` when it has one (to anchor a menu), else the tool's command runs through the registry. */
export function mergePaneHeader(
  base: PaneHeaderProps,
  screen: ScreenPaneHeader | null,
  runCommand: (commandId: CommandId) => void,
): PaneHeaderProps {
  if (screen === null) return base;
  const { askScope, ...rest } = screen;
  return {
    ...rest,
    onTool: rest.onTool ?? ((id: CommandId) => runCommand(id)),
    ask: askScope ? { ...base.ask, scope: askScope } : base.ask,
    today: base.today,
  };
}
