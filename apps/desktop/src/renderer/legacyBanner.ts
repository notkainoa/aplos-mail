/**
 * One calm line at the top of the legacy renderer's window, so nobody mistakes the old version for the new one (a build
 * that falls back to legacy would otherwise make every hand-check misleading). Only `bootLegacy` mounts it: the new
 * renderer, on the real engine or the stand-in, never does. The window title stays as it is.
 *
 * The legacy renderer is not React-free of its own layout (`.app-shell` is `100dvh` tall), so the banner is fixed to the
 * top and `.app-shell` gives up the same height. Every value is a legacy token (`legacy/ui/tokens.css`), no colour of its
 * own; on macOS the left padding clears the window buttons and the line stays a drag area.
 */

export const LEGACY_BANNER_ID = 'aplos-legacy-banner';

export const LEGACY_BANNER_TEXT =
  'This is the old version of Aplos. Start the app with APLOS_ENGINE=real to see the new one.';

/**
 * A production build runs the old version only on a Mac whose 0.2.x mail has not moved to the new engine yet (main's
 * `realEngineRequested`). A release ignores `APLOS_ENGINE`, so its line names no variable.
 */
export const LEGACY_BANNER_TEXT_PRODUCTION =
  'This is the old version of Aplos. It stays until your mail can move to the new one.';

/** The banner's line: the developer hint in a development build, the plain one otherwise. */
export const legacyBannerText = (dev: boolean) =>
  dev ? LEGACY_BANNER_TEXT : LEGACY_BANNER_TEXT_PRODUCTION;

const STYLE_ID = `${LEGACY_BANNER_ID}-style`;

const STYLE = `
#${LEGACY_BANNER_ID} {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: var(--z-tooltip);
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--space-6);
  padding: 0 calc(var(--space-8) * 3);
  box-sizing: border-box;
  background: var(--raised);
  color: var(--ink-2);
  border-bottom: 1px solid var(--line);
  font-family: var(--font);
  font-size: var(--text-sm);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  -webkit-app-region: drag;
}
body[data-legacy-banner] .app-shell {
  height: calc(100dvh - var(--space-6));
  margin-top: var(--space-6);
}
`;

/** The slice of `Document` this needs, so a test can stand in for it. */
export interface BannerDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): {
    id: string;
    textContent: string | null;
    setAttribute(name: string, value: string): void;
  };
  readonly head: { append(node: unknown): void };
  readonly body: { prepend(node: unknown): void; setAttribute(name: string, value: string): void };
}

/** Puts the banner on the page (once) and returns whether it added it. */
export function mountLegacyBanner(
  doc: BannerDocument = document as unknown as BannerDocument,
  text: string = LEGACY_BANNER_TEXT,
): boolean {
  if (doc.getElementById(LEGACY_BANNER_ID)) return false;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  doc.head.append(style);
  const banner = doc.createElement('div');
  banner.id = LEGACY_BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.textContent = text;
  doc.body.prepend(banner);
  doc.body.setAttribute('data-legacy-banner', '');
  return true;
}
