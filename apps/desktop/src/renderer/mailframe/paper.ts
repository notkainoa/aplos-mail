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
