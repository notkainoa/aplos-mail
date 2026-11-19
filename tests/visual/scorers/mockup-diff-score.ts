// Pure maths for the mockup-diff scorer: no browser, no file system. Two renderings of the same
// screen (the implementation and its mockup) legitimately differ in demo data, so the score is not a
// pixel compare. It is 0.6 x colour similarity (mean CIEDE2000 between the per-cell mean colours of
// a coarse grid) + 0.4 x structure (correlation of the column and row ink profiles).

export const CELL = 8;
export const BLOCK = 4;
/** meanDeltaE at or above this gives colour similarity 0. */
export const DELTA_E_FLOOR = 40;
export const COLOUR_WEIGHT = 0.6;
export const STRUCTURE_WEIGHT = 0.4;

export interface Rgba {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** A downsampled image: one Lab colour and one edge sum per cell, row-major. */
export interface Grid {
  cols: number;
  rows: number;
  cell: number;
  /** L, a, b of the cell's mean colour, three numbers per cell. */
  lab: Float64Array;
  /** Sum of luminance gradient magnitude (|dx| + |dy|, 0..255 scale) inside the cell. */
  edge: Float64Array;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Comparison {
  /** 0..100 */
  score: number;
  meanDeltaE: number;
  colourSimilarity: number;
  structure: number;
  /** ΔE per cell, row-major. */
  cellDeltas: Float64Array;
  worst: Region;
}

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

/** Linear-light sRGB (0..1) to CIE Lab, D65. */
export function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  return [116 * labF(y) - 16, 500 * (labF(x) - labF(y)), 200 * (labF(y) - labF(z))];
}

/** sRGB bytes to Lab. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  return linearToLab(LINEAR[r] ?? 0, LINEAR[g] ?? 0, LINEAR[b] ?? 0);
}

const RAD = Math.PI / 180;

function hueAngle(b: number, a: number): number {
  if (b === 0 && a === 0) return 0;
  const h = Math.atan2(b, a) / RAD;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 between two Lab colours. */
export function deltaE2000(
  p: readonly [number, number, number],
  q: readonly [number, number, number],
): number {
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * RAD) / 2);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
    hpm /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hpm - 30) * RAD) +
    0.24 * Math.cos(2 * hpm * RAD) +
    0.32 * Math.cos((3 * hpm + 6) * RAD) -
    0.2 * Math.cos((4 * hpm - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  const term = (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh);
  return Math.sqrt(Math.max(0, term));
}

function luminanceRow(image: Rgba, y: number): Float64Array {
  const { data, width } = image;
  const row = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    row[x] = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
  }
  return row;
}

function addGradients(edge: Float64Array, image: Rgba, cols: number, cell: number): void {
  let row = luminanceRow(image, 0);
  for (let y = 0; y < image.height; y += 1) {
    const next = y + 1 < image.height ? luminanceRow(image, y + 1) : row;
    const base = Math.floor(y / cell) * cols;
    for (let x = 0; x < image.width; x += 1) {
      const dx = x + 1 < image.width ? Math.abs((row[x + 1] ?? 0) - (row[x] ?? 0)) : 0;
      const dy = Math.abs((next[x] ?? 0) - (row[x] ?? 0));
      const index = base + Math.floor(x / cell);
      edge[index] = (edge[index] ?? 0) + dx + dy;
    }
    row = next;
  }
}

/** Mean Lab colour (averaged in linear light) and gradient sum for every `cell` x `cell` block. */
export function downsample(image: Rgba, cell = CELL): Grid {
  const { data, width, height } = image;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const sums = new Float64Array(cols * rows * 3);
  const counts = new Float64Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const index = Math.floor(y / cell) * cols + Math.floor(x / cell);
      sums[index * 3] = (sums[index * 3] ?? 0) + (LINEAR[data[i] ?? 0] ?? 0);
      sums[index * 3 + 1] = (sums[index * 3 + 1] ?? 0) + (LINEAR[data[i + 1] ?? 0] ?? 0);
      sums[index * 3 + 2] = (sums[index * 3 + 2] ?? 0) + (LINEAR[data[i + 2] ?? 0] ?? 0);
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }
  const lab = new Float64Array(cols * rows * 3);
  for (let index = 0; index < cols * rows; index += 1) {
    const n = counts[index] || 1;
    const [L, a, b] = linearToLab(
      (sums[index * 3] ?? 0) / n,
      (sums[index * 3 + 1] ?? 0) / n,
      (sums[index * 3 + 2] ?? 0) / n,
    );
    lab.set([L, a, b], index * 3);
  }
  const edge = new Float64Array(cols * rows);
  addGradients(edge, image, cols, cell);
  return { cols, rows, cell, lab, edge };
}

/** Pearson correlation. Two flat series agree (1); one flat and one not do not (0). */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i] ?? 0;
    meanB += b[i] ?? 0;
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const flatA = varA < 1e-9;
  const flatB = varB < 1e-9;
  if (flatA || flatB) return flatA && flatB ? 1 : 0;
  return cov / Math.sqrt(varA * varB);
}

export interface Profiles {
  /** Edge sum per grid column, normalised to sum 1 (all zero when the image has no edges). */
  columns: number[];
  rows: number[];
}

function normalised(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map(value => value / total) : values;
}

export function edgeProfiles(grid: Grid): Profiles {
  const columns = new Array<number>(grid.cols).fill(0);
  const rows = new Array<number>(grid.rows).fill(0);
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      const value = grid.edge[r * grid.cols + c] ?? 0;
      columns[c] = (columns[c] ?? 0) + value;
      rows[r] = (rows[r] ?? 0) + value;
    }
  }
  return { columns: normalised(columns), rows: normalised(rows) };
}

/** Mean of the column and row profile correlations, each clamped at 0. 0..1. */
export function structureCorrelation(a: Grid, b: Grid): number {
  const pa = edgeProfiles(a);
  const pb = edgeProfiles(b);
  const columns = Math.max(0, correlation(pa.columns, pb.columns));
  const rows = Math.max(0, correlation(pa.rows, pb.rows));
  return (columns + rows) / 2;
}

export function cellDeltaEs(a: Grid, b: Grid): Float64Array {
  const count = a.cols * a.rows;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = deltaE2000(
      [a.lab[i * 3] ?? 0, a.lab[i * 3 + 1] ?? 0, a.lab[i * 3 + 2] ?? 0],
      [b.lab[i * 3] ?? 0, b.lab[i * 3 + 1] ?? 0, b.lab[i * 3 + 2] ?? 0],
    );
  }
  return out;
}

/** The `block` x `block` cell block with the largest mean ΔE, as a pixel rectangle (compared region). */
export function worstBlock(
  deltas: ArrayLike<number>,
  cols: number,
  rows: number,
  cell = CELL,
  block = BLOCK,
): Region {
  const w = Math.min(block, cols);
  const h = Math.min(block, rows);
  let best = -1;
  let bestAt = { c: 0, r: 0 };
  for (let r = 0; r + h <= rows; r += 1) {
    for (let c = 0; c + w <= cols; c += 1) {
      let sum = 0;
      for (let dr = 0; dr < h; dr += 1)
        for (let dc = 0; dc < w; dc += 1) sum += deltas[(r + dr) * cols + c + dc] ?? 0;
      if (sum > best) {
        best = sum;
        bestAt = { c, r };
      }
    }
  }
  return { x: bestAt.c * cell, y: bestAt.r * cell, width: w * cell, height: h * cell };
}

export function colourSimilarity(meanDeltaE: number): number {
  return Math.max(0, 1 - meanDeltaE / DELTA_E_FLOOR);
}

/** 100 x (0.6 colour + 0.4 structure). Both grids must have the same shape. */
export function compareGrids(a: Grid, b: Grid): Comparison {
  if (a.cols !== b.cols || a.rows !== b.rows)
    throw new Error(`grids differ: ${a.cols}x${a.rows} vs ${b.cols}x${b.rows}`);
  const cellDeltas = cellDeltaEs(a, b);
  let total = 0;
  for (const value of cellDeltas) total += value;
  const meanDeltaE = cellDeltas.length > 0 ? total / cellDeltas.length : 0;
  const colour = colourSimilarity(meanDeltaE);
  const structure = structureCorrelation(a, b);
  return {
    score: 100 * (COLOUR_WEIGHT * colour + STRUCTURE_WEIGHT * structure),
    meanDeltaE,
    colourSimilarity: colour,
    structure,
    cellDeltas,
    worst: worstBlock(cellDeltas, a.cols, a.rows, a.cell),
  };
}

export function compareImages(a: Rgba, b: Rgba, cell = CELL): Comparison {
  return compareGrids(downsample(a, cell), downsample(b, cell));
}

/** First detail line: how much of the state list was really compared. */
export function comparedLine(compared: number, total: number, excluded: number): string {
  return `compared ${compared} of ${total} (excluded ${excluded})`;
}

/**
 * The final report. `total` counts every state-and-theme page asked for, `excluded` those listed in
 * the exclude file (the only ones allowed out of the mean). Everything else counts: a page that
 * could not be compared (unresolved mockup, failed to open) scores 0 and is flagged, so shrinking
 * the compared set never raises the mean.
 */
export function mockupReport(
  scored: readonly StateScore[],
  total: number,
  excluded: number,
): { score: number; details: string[] } {
  const compared = scored.filter(entry => !entry.note).length;
  const missing = Math.max(0, total - excluded - scored.length);
  const mean = overallScore([
    ...scored.map(entry => entry.score),
    ...Array.from({ length: missing }, () => 0),
  ]);
  return {
    score: mean,
    details: [comparedLine(compared, total, excluded), ...detailLines(scored)],
  };
}

/** A page whose mockup cannot be resolved: it scores 0 and says why. */
export function unresolvedScore(state: string, theme: string, reason: string): StateScore {
  return { state, theme, score: 0, worst: null, note: `mockup-unresolved ${reason}` };
}

/** Mean of the scores; an empty list scores 0. */
export function overallScore(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export interface StateScore {
  state: string;
  theme: string;
  score: number;
  worst: Region | null;
  /** Set when the state could not be compared (it counts as 0). */
  note?: string;
}

/** `state theme 87.3% worst x,y,w,h`, or the note for a state that failed. */
export function detailLine(entry: StateScore): string {
  const head = `${entry.state} ${entry.theme} ${entry.score.toFixed(1)}%`;
  if (entry.note) return `${head} ${entry.note}`;
  const { x, y, width, height } = entry.worst ?? { x: 0, y: 0, width: 0, height: 0 };
  return `${head} worst ${x},${y},${width},${height}`;
}

/** Worst first. */
export function detailLines(entries: readonly StateScore[]): string[] {
  return [...entries].sort((a, b) => a.score - b.score).map(detailLine);
}

/** Files and state labels: `home.html (default)` becomes `{ file: 'home.html', label: 'default' }`. */
export function parseMockup(mockup: string): { file: string; label: string } | null {
  const match = /^([\w-]+\.html)(?:\s*\(([^)]*)\))?$/.exec(mockup.trim());
  if (!match?.[1]) return null;
  return { file: match[1], label: (match[2] ?? 'default').trim() };
}

/**
 * The mockup's `?state=` for a label: the label with spaces as dashes when the page lists it, the
 * first listed state for `default`, `''` for a page with no states, otherwise null (not resolvable).
 */
export function resolveMockupState(label: string, listed: readonly string[]): string | null {
  const slug = label.toLowerCase().replace(/\s+/g, '-');
  if (listed.includes(slug)) return slug;
  if (slug === 'default') return listed[0] ?? '';
  return null;
}

/** States whose own mockup label is a stand-in: the better-matching `file (state)` for them. */
export const MOCKUP_OVERRIDES: Readonly<Record<string, string>> = {
  'shell-empty-drafts': 'empty.html (drafts)',
};

/** The part of the full-window shot that is compared, by the stage frame of the state. */
export function implRegion(
  frame: 'pane' | 'window' | 'shell' | undefined,
  viewport: { width: number; height: number },
  shellPad = 8,
): Region {
  if (frame === 'window') {
    const width = Math.min(640, viewport.width);
    const height = Math.min(600, viewport.height);
    return {
      x: Math.round((viewport.width - width) / 2),
      y: Math.round((viewport.height - height) / 2),
      width,
      height,
    };
  }
  if (frame === 'shell') return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  return {
    x: shellPad,
    y: shellPad,
    width: viewport.width - 2 * shellPad,
    height: viewport.height - 2 * shellPad,
  };
}
