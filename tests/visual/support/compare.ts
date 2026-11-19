import type { Page } from '@playwright/test';

/** A pixel counts as changed when CIEDE2000 between the two colours is above this (DESIGN 12.5). */
export const DELTA_E_LIMIT = 2;
/** The diff fails when more than this fraction of pixels changed (0.1 %). */
export const CHANGED_RATIO_LIMIT = 0.001;

export interface Comparison {
  width: number;
  height: number;
  expectedWidth: number;
  expectedHeight: number;
  changed: number;
  ratio: number;
  maxDeltaE: number;
  /** PNG, base64: the expected image faded, changed pixels in red. Absent when sizes differ. */
  overlay: string | null;
}

/**
 * Compares two PNGs by perceptual colour difference. The decoding and the CIEDE2000 maths run in a
 * blank browser page (canvas), so the harness needs no image library.
 */
export async function comparePngs(
  scratch: Page,
  actual: Buffer,
  expected: Buffer,
): Promise<Comparison> {
  await scratch.goto('about:blank');
  return scratch.evaluate(
    async ({ a, b, limit }) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const toLab = (r: number, g: number, bl: number): [number, number, number] => {
        const lin = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const R = lin(r);
        const G = lin(g);
        const B = lin(bl);
        const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
        const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
        const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
        const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
        return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
      };
      const deltaE00 = (p: number[], q: number[]) => {
        const rad = Math.PI / 180;
        const [L1, a1, b1] = p;
        const [L2, a2, b2] = q;
        const C1 = Math.hypot(a1, b1);
        const C2 = Math.hypot(a2, b2);
        const Cm = (C1 + C2) / 2;
        const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
        const a1p = (1 + G) * a1;
        const a2p = (1 + G) * a2;
        const C1p = Math.hypot(a1p, b1);
        const C2p = Math.hypot(a2p, b2);
        const hp = (bb: number, aa: number) => {
          if (bb === 0 && aa === 0) return 0;
          const h = Math.atan2(bb, aa) / rad;
          return h < 0 ? h + 360 : h;
        };
        const h1p = hp(b1, a1p);
        const h2p = hp(b2, a2p);
        const dLp = L2 - L1;
        const dCp = C2p - C1p;
        let dhp = 0;
        if (C1p * C2p !== 0) {
          dhp = h2p - h1p;
          if (dhp > 180) dhp -= 360;
          else if (dhp < -180) dhp += 360;
        }
        const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
        const Lpm = (L1 + L2) / 2;
        const Cpm = (C1p + C2p) / 2;
        let hpm = h1p + h2p;
        if (C1p * C2p !== 0) {
          if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
          hpm /= 2;
        }
        const T =
          1 -
          0.17 * Math.cos((hpm - 30) * rad) +
          0.24 * Math.cos(2 * hpm * rad) +
          0.32 * Math.cos((3 * hpm + 6) * rad) -
          0.2 * Math.cos((4 * hpm - 63) * rad);
        const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
        const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
        const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
        const Sc = 1 + 0.045 * Cpm;
        const Sh = 1 + 0.015 * Cpm * T;
        const Rt = -Math.sin(2 * dTheta * rad) * Rc;
        return Math.sqrt(
          (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
        );
      };

      const [x, y] = await Promise.all([decode(a), decode(b)]);
      const out: Comparison = {
        width: x.width,
        height: x.height,
        expectedWidth: y.width,
        expectedHeight: y.height,
        changed: 0,
        ratio: 0,
        maxDeltaE: 0,
        overlay: null,
      };
      if (x.width !== y.width || x.height !== y.height) {
        out.ratio = 1;
        return out;
      }
      const overlay = new ImageData(y.width, y.height);
      const cache = new Map<number, [number, number, number]>();
      const lab = (r: number, g: number, bl: number) => {
        const key = (r << 16) | (g << 8) | bl;
        let value = cache.get(key);
        if (!value) {
          value = toLab(r, g, bl);
          cache.set(key, value);
        }
        return value;
      };
      for (let i = 0; i < x.data.length; i += 4) {
        const same =
          x.data[i] === y.data[i] &&
          x.data[i + 1] === y.data[i + 1] &&
          x.data[i + 2] === y.data[i + 2];
        const de = same
          ? 0
          : deltaE00(
              lab(x.data[i], x.data[i + 1], x.data[i + 2]),
              lab(y.data[i], y.data[i + 1], y.data[i + 2]),
            );
        if (de > out.maxDeltaE) out.maxDeltaE = de;
        const changed = de > limit;
        if (changed) out.changed += 1;
        for (let c = 0; c < 3; c += 1)
          overlay.data[i + c] = changed ? (c === 0 ? 255 : 0) : 255 - (255 - y.data[i + c]) * 0.25;
        overlay.data[i + 3] = 255;
      }
      out.ratio = out.changed / (x.width * x.height);
      const canvas = new OffscreenCanvas(y.width, y.height);
      canvas.getContext('2d')!.putImageData(overlay, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000)
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      out.overlay = btoa(binary);
      return out;
    },
    { a: actual.toString('base64'), b: expected.toString('base64'), limit: DELTA_E_LIMIT },
  );
}
