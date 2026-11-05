/**
 * Which renderer the entry boots, read from the renderer URL's query (plan 30 U8; main hands the onboarding
 * window `?window=onboarding&mode=<mode>` through `loadRenderer`, and `showWelcome.ts` builds the same URL
 * for the browser preview). Pure: no React, no DOM, no engine — `tests/ui-onboard/mount.test.ts` covers it.
 *
 * `legacy=1` wins first because `VITE_APLOS_LEGACY` and every production build already load today's renderer
 * in `main.tsx` before this runs, and a `legacy` param must not open onboarding over it.
 */

/** What `main.tsx` mounts. */
export type RendererRoute = 'legacy' | 'onboarding' | 'mail';

/** The onboarding window's mode: `first` is the first run, `review` is "Show welcome" from Settings. */
export type OnboardingRouteMode = 'first' | 'review';

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

/** The route for one renderer URL. */
export function chooseRoute(search: string): RendererRoute {
  const query = params(search);
  if (query.get('legacy') === '1') return 'legacy';
  if (query.get('window') === 'onboarding') return 'onboarding';
  return 'mail';
}

/**
 * The `mode` the window was opened with. `review` is the only distinct mode; `first`, a missing value and
 * anything unrecognised all start the first-run flow, so the window can never open on a step that is not
 * its own default.
 */
export function onboardingMode(search: string): OnboardingRouteMode {
  return params(search).get('mode') === 'review' ? 'review' : 'first';
}

/**
 * The stand-in scenario a development URL asks for (`?scenario=empty` gives the zero-accounts pane). The
 * value is passed through untyped; `connectStandIn` owns the scenario list, so an unknown name fails there
 * in development, never silently in a release (releases load the legacy renderer before this is read).
 */
export function scenarioParam(search: string): string | undefined {
  return params(search).get('scenario') ?? undefined;
}
