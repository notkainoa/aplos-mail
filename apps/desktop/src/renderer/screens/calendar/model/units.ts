/** Shared constants of the calendar model (not re-exported by `calendar.model.ts`). */
export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
export const pad = (n: number): string => String(n).padStart(2, '0');
