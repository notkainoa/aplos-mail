/**
 * "Show welcome" in Settings → Help (plan 30 §4.5 row 9; U8 F1 reproduction). Opens the onboarding window beside the mail
 * window in review mode and changes nothing: the window's own `Setup/begin` and `Setup/end` keep a close from
 * leaving AI deferred (F1). In the browser preview there is no second window, so it goes to the onboarding route.
 */
import { api } from '../data';
import { WINDOW_COPY } from './copy';

/** Where the browser preview shows the onboarding window (REQUEST ui-shell: this route does not exist yet). */
export const onboardingRoute = (mode: 'first' | 'review'): string =>
  `?window=onboarding&mode=${mode}`;
export const ONBOARDING_ROUTE = onboardingRoute('review');

export interface WelcomePorts {
  /** `Window/openOnboarding {mode}`: a desktop method served by main. */
  openOnboarding(input: { mode: 'first' | 'review' }): Promise<unknown>;
  /** True in the browser preview (no Electron main to ask). */
  isBrowserPreview(): boolean;
  /** Go to a route in this tab. */
  navigate(route: string): void;
}

// `Window/openOnboarding` is a desktop method main serves; `renderer/data`'s api exposes it as
// `api.window.openOnboarding` (granted). On the stand-in it is stubbed and nothing opens.
export const defaultWelcomePorts: WelcomePorts = {
  openOnboarding: async input => api.window.openOnboarding(input),
  isBrowserPreview: () =>
    typeof navigator === 'undefined' || !/\bElectron\//.test(navigator.userAgent),
  navigate: route => {
    window.location.assign(route);
  },
};

/** What Show welcome did: `opened` the window, `navigated` the preview, or `failed` (the caller says so in words). */
export type WelcomeResult = 'opened' | 'navigated' | 'failed';

/**
 * Opens the onboarding window (`Window/openOnboarding {mode}`). `first` is the zero-accounts state's "Add an account";
 * `review` is Show welcome.
 */
export async function openOnboardingWindow(
  mode: 'first' | 'review',
  given: Partial<WelcomePorts> = {},
): Promise<WelcomeResult> {
  const ports = { ...defaultWelcomePorts, ...given };
  if (ports.isBrowserPreview()) {
    ports.navigate(onboardingRoute(mode));
    return 'navigated';
  }
  try {
    await ports.openOnboarding({ mode });
    return 'opened';
  } catch {
    return 'failed';
  }
}

/** Settings → Help, "Show welcome": the onboarding window in review mode, beside the mail window. */
export function showWelcome(given: Partial<WelcomePorts> = {}): Promise<WelcomeResult> {
  return openOnboardingWindow('review', given);
}

/** The visible line after "Add an account" or Show welcome could not open the setup window; none otherwise. */
export function welcomeFailureLine(result: WelcomeResult): string | undefined {
  return result === 'failed' ? WINDOW_COPY.setupWindowFailed : undefined;
}
