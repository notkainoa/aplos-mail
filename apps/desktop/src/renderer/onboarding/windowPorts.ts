/**
 * The onboarding window's calls (`WindowPorts`) and the defaults that talk to `renderer/data`. Kept out of
 * `OnboardingApp.tsx` so the pure tests can import them without the component/css chain.
 */
import { api, type Input, type Output } from '../data';

/** The window-level calls. Defaults come from `renderer/data`; the preview and tests pass their own. */
export interface WindowPorts {
  setupBegin(input: Input<'Setup/begin'>): Promise<Output<'Setup/begin'>>;
  setupEnd(input: Input<'Setup/end'>): Promise<unknown>;
  demoLoad(): Promise<unknown>;
  /**
   * `Window/finishOnboarding`: main shows the mail window on `ready-to-show` and closes this one (F4). `to` asks the
   * mail window to open Settings → AI (first sync's "Open Settings").
   */
  finish(input?: { readonly to?: 'settings.ai' }): Promise<unknown>;
}

// `Window/finishOnboarding` (and `Window/openOnboarding` for "Show welcome") are desktop methods main serves;
// `renderer/data`'s api exposes them. `finishOnboarding` takes an optional `{ to: 'settings.ai' }` and the port
// forwards it; main honours `to` once the eng-host change lands and shows the mail window's default screen until then.
export const defaultWindowPorts: WindowPorts = {
  setupBegin: async input => api.setup.begin(input),
  setupEnd: async input => api.setup.end(input),
  demoLoad: async () => api.demo.load(),
  finish: async input => api.window.finishOnboarding(input ?? {}),
};
