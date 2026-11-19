// Main asks the mail window to open a screen: after first sync's "Open Settings", `Window/finishOnboarding { to:
// 'settings.ai' }` hands over and main sends one `navigate` event (host/lifecycle.ts, `navigate`). The listener is typed
// (`only: ['navigate']`), so it never takes the deep-link, command and prepare-close events held for the app's own first
// plain subscribe, and preload's event hub holds the `navigate` event for it if it arrives before this mounts.

/** The part of preload's bridge this needs. */
export interface NavigateBridge {
  subscribe(
    listener: (event: { type: string; payload?: unknown }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** The screens main may ask for; each is a shell route. */
const ROUTES = { 'settings.ai': 'settings/ai' } as const;
export type MainNavigateRoute = (typeof ROUTES)[keyof typeof ROUTES];

/** Subscribes for `navigate` events; each valid one calls `open` with its route. Returns the unsubscribe. */
export function listenMainNavigate(
  bridge: NavigateBridge | undefined,
  open: (route: MainNavigateRoute) => void,
): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  return bridge.subscribe(
    event => {
      if (event.type !== 'navigate') return;
      const to = (event.payload as { to?: unknown } | null | undefined)?.to;
      if (typeof to === 'string' && Object.hasOwn(ROUTES, to))
        open(ROUTES[to as keyof typeof ROUTES]);
    },
    { only: ['navigate'] },
  );
}
