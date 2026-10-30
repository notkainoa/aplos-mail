// In-house colour maths for the Paper token checks. No dependencies.
// sRGB -> XYZ (D65) -> Lab uses the same matrix, white point and f(t) as the
// identity audit's de2000.py, so ΔE values agree with it.
// Every function that takes a colour accepts a hex string or an [r, g, b]
// array of 0..1 floats (the output of compositeOver).

const XYZ_WHITE = [0.95047, 1.0, 1.08883];

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) {
    throw new Error(`Not a hex colour: ${hex}`);
  }
  let digits = match[1];
  if (digits.length === 3) {
    digits = [...digits].map(d => d + d).join('');
  }
  return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255);
}

export function toRgb(color) {
  return Array.isArray(color) ? color : parseHex(color);
}

export function toHex(color) {
  const bytes = toRgb(color).map(c => Math.round(Math.min(1, Math.max(0, c)) * 255));
  return '#' + bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToXyz(color) {
  const [r, g, b] = toRgb(color).map(srgbToLinear);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

function labF(t) {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

export function toLab(color) {
  const xyz = rgbToXyz(color);
  const [fx, fy, fz] = xyz.map((v, i) => labF(v / XYZ_WHITE[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = degrees => (degrees * Math.PI) / 180;
const deg = radians => (radians * 180) / Math.PI;

export function deltaE2000(colorA, colorB) {
  const [L1, a1, b1] = toLab(colorA);
  const [L2, a2, b2] = toLab(colorB);
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = (deg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dh = h2p - h1p;
  if (C1p * C2p === 0) {
    dh = 0;
  } else if (dh > 180) {
    dh -= 360;
  } else if (dh < -180) {
    dh += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) {
    hbp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbp = (h1p + h2p + 360) / 2;
  } else {
    hbp = (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbp - 30)) +
    0.24 * Math.cos(rad(2 * hbp)) +
    0.32 * Math.cos(rad(3 * hbp + 6)) -
    0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// WCAG 2.x relative luminance and contrast ratio.
export function relativeLuminance(color) {
  const [r, g, b] = toRgb(color).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(colorA, colorB) {
  const la = relativeLuminance(colorA);
  const lb = relativeLuminance(colorB);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// `color-mix(in srgb, fg p%, transparent)` painted over an opaque surface:
// source-over compositing in gamma-encoded sRGB, as browsers paint it.
// Returns unrounded floats; ratios are computed on these, which is how
// DESIGN 4.1's printed numbers were computed. The 8-bit rounding a screen
// applies moves a ratio by at most about 0.05; toHex() shows the rounded hex.
export function compositeOver(fg, alpha, bg) {
  const top = toRgb(fg);
  const under = toRgb(bg);
  return top.map((c, i) => alpha * c + (1 - alpha) * under[i]);
}

// APCA-W3 0.0.98G-4g lightness contrast (Lc). Advisory only.
function apcaY(color) {
  const [r, g, b] = toRgb(color).map(c => c ** 2.4);
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

export function apcaLc(text, bg) {
  const yText = apcaY(text);
  const yBg = apcaY(bg);
  if (Math.abs(yBg - yText) < 0.0005) {
    return 0;
  }
  if (yBg > yText) {
    const sapc = (yBg ** 0.56 - yText ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (yBg ** 0.65 - yText ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}
