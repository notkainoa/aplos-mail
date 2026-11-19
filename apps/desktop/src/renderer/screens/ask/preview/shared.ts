/** Clock and no-op helpers the preview fixtures share. */
export const noop = () => undefined;
export const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
/** The harness clock: Thursday, October 29, 2026, 10:00 AM. */
export const NOW = at(29, 10);
