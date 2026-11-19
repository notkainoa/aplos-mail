// Which window an IPC call came from, and whether it may be trusted. No Electron import: node:test runs it. Re-exported by
// `port.ts`, where main and the tests have always found it.

/** The parts of an IPC event the caller check reads (Electron's `IpcMainInvokeEvent`). */
export interface CallerEvent {
  senderFrame: { url: string; detached?: boolean } | null | undefined;
  sender: { mainFrame: unknown; isDestroyed(): boolean; getType?(): string };
}

/**
 * The window whose trusted main frame sent `event`, or undefined. Refused: no frame or a detached one, a subframe
 * (a mail frame, any iframe), a page other than the app's own renderer (another origin, `devtools://`), a webContents
 * that is not a window's (DevTools, a webview), or one with no window.
 */
export function trustedCaller<W>(
  event: CallerEvent,
  deps: {
    trustedURL(url: string): boolean;
    windowOf(sender: CallerEvent['sender']): W | undefined;
  },
): W | undefined {
  const frame = event.senderFrame;
  const sender = event.sender;
  if (!frame || frame.detached || frame !== sender.mainFrame || sender.isDestroyed())
    return undefined;
  if (sender.getType && sender.getType() !== 'window') return undefined;
  if (!deps.trustedURL(frame.url)) return undefined;
  return deps.windowOf(sender);
}
