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
 * The sentinel a plain email's body paints in the light theme: the paper colour off by one blue step, so the host can tell
 * a plain email (drawn straight on the card) from a rich one that merely sets no background. A plain email in the dark
 * theme paints `FRAME_DARK.surface`, which is already its own signal.
 */
export const PLAIN_LIGHT_SURFACE = `${FRAME_PAPER.paper.slice(0, -2)}fe`;

/** Whether the reported body colour is a plain email's. */
export function isPlainSurface(bg: string): boolean {
  const low = bg.toLowerCase();
  return low === PLAIN_LIGHT_SURFACE || low === FRAME_DARK.surface.toLowerCase();
}

/**
 * What the iframe element itself is painted with. A rich email keeps the light paper in its inset ring (a sheet on the dark
 * pane). A plain email is the card itself: the card's surface, no ring or inset, in the name's column
 * (`--plain-indent`), with no border or rounding of its own.
 */
export function sheetOf(bg: string): {
  readonly background: string;
  readonly colorScheme: 'light' | 'dark';
  readonly padding?: string;
  readonly width?: string;
  readonly marginLeft?: string;
  readonly borderRadius?: string;
} {
  if (!isPlainSurface(bg)) return { background: FRAME_PAPER.paper, colorScheme: 'light' };
  const darkSheet = bg.toLowerCase() === FRAME_DARK.surface.toLowerCase();
  return {
    background: darkSheet ? FRAME_DARK.surface : FRAME_PAPER.paper,
    colorScheme: darkSheet ? 'dark' : 'light',
    padding: '0',
    width: 'calc(100% - var(--plain-indent, 0px))',
    marginLeft: 'var(--plain-indent, 0px)',
    borderRadius: '0',
  };
}
