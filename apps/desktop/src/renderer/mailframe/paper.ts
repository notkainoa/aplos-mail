// The light-paper values the frame document needs. The frame cannot see the host's CSS custom properties, so the
// values are read from ui/tokens.json (the one source of raw values), always the light theme: HTML mail sits on
// light paper whatever the app theme (research electron-email-html-isolation section 9 item 2).

import tokens from '../ui/tokens.json' with { type: 'json' };

interface ColorToken {
  $value: unknown;
}

function light(token: ColorToken): string {
  if (typeof token.$value !== 'string') throw new Error('mailframe: expected a plain colour token');
  return token.$value;
}

const read = tokens.type.read.$value;

/** Light theme colours and type for the inside of the frame. */
export const FRAME_PAPER = {
  paper: light(tokens.color.paper),
  ink: light(tokens.color.ink),
  dim: light(tokens.color.dim),
  accent: light(tokens.color.accent),
  canvas: light(tokens.color.canvas),
  fontFamily: tokens.font.sans.$value.map(f => (f.includes(' ') ? `"${f}"` : f)).join(', '),
  fontSize: read.fontSize,
  lineHeight: read.lineHeight,
  letterSpacing: read.letterSpacing,
} as const;

interface DarkToken {
  $extensions: { aplos: { dark: string } };
}

function dark(token: DarkToken): string {
  return token.$extensions.aplos.dark;
}

/**
 * The dark-theme values for a plain email (one that sets no colours, images or styles of its own): it is drawn on the
 * reader card's own dark surface (`--raised`) in the theme's text colours instead of on a bright white sheet. Any
 * other email keeps the light paper above whatever the theme.
 */
export const FRAME_DARK = {
  surface: dark(tokens.color.raised),
  ink: dark(tokens.color.ink),
  dim: dark(tokens.color.dim),
  accent: dark(tokens.color['accent']),
  /** A quote's rule and the "…" chip. */
  rule: dark(tokens.color.sunken),
} as const;

/**
 * What the iframe element itself is painted with. A rich email keeps the light paper in its inset ring (a sheet on the dark
 * pane). A plain email is the card itself: the card's surface, no ring or inset, in the name's column (`--plain-indent`),
 * with no border or rounding of its own. `plain` MUST come from a trusted signal (the stand-in frame's own document, or the
 * sealed frame's marker on the root, which only the sanitiser sets); a colour the mail can choose is never one. The dark
 * surface is then read from the colour, because the plain CSS is the only thing that paints it.
 */
export function sheetOf(
  plain: boolean,
  bg: string,
): {
  readonly background: string;
  readonly colorScheme: 'light' | 'dark';
  readonly padding?: string;
  readonly width?: string;
  readonly marginLeft?: string;
  readonly borderRadius?: string;
} {
  if (!plain) return { background: FRAME_PAPER.paper, colorScheme: 'light' };
  const dark = bg.toLowerCase() === FRAME_DARK.surface.toLowerCase();
  return {
    background: dark ? FRAME_DARK.surface : FRAME_PAPER.paper,
    colorScheme: dark ? 'dark' : 'light',
    padding: '0',
    // The name's column, and never wider than the reading measure (about 65 to 70 characters).
    width:
      'min(calc(100% - var(--plain-indent, 0px) - var(--plain-inset, 0px)), var(--measure-read))',
    marginLeft: 'var(--plain-indent, 0px)',
    borderRadius: '0',
  };
}

/**
 * Whether the frame is a light sheet (`paper`, which stands out on a dark pane) or sits on the card's own surface (`app`).
 * A hook for the screen's CSS (the pinned bar's tray); never read back by script.
 */
export function sheetKind(plain: boolean, bg: string): 'paper' | 'app' {
  return sheetOf(plain, bg).background === FRAME_PAPER.paper ? 'paper' : 'app';
}
