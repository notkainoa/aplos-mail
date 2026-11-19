/** Strip `[n]` markers the model wrote; each becomes a chip at its character offset in the shown text (FR-30). */
export function stripMarkers(text: string): {
  text: string;
  cites: { at: number; n: number }[];
} {
  const cites: { at: number; n: number }[] = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/\[(\d{1,3}(?:[ ,]+\d{1,3})*)\]/g)) {
    const at = m.index ?? 0;
    out += text.slice(last, at);
    for (const n of m[1].match(/\d+/g) ?? []) cites.push({ at: out.length, n: Number(n) });
    last = at + m[0].length;
  }
  out += text.slice(last);
  return { text: out.trim(), cites };
}
