/**
 * The id the cursor moves to for ArrowDown (`step` 1) or ArrowUp (-1), wrapping at the ends. With nothing active, Down
 * lands on the first result and Up on the last. Returns undefined for an empty list.
 */
export function nextActiveId(
  ids: readonly string[],
  activeId: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const at = activeId === undefined ? -1 : ids.indexOf(activeId);
  if (at < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(at + step + ids.length) % ids.length];
}
