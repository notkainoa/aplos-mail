/**
 * The ARIA radiogroup keys for rows that are not native inputs: one tab stop per group (the chosen radio, or the
 * first when none is chosen) and the arrows that move to, and choose, the next radio. Internal to onboarding.
 */

const RADIO = '[role="radio"]';

function radiosOf(el: HTMLElement): HTMLElement[] {
  const group = el.closest('[role="radiogroup"]');
  return group ? Array.from(group.querySelectorAll<HTMLElement>(RADIO)) : [];
}

/** The radio an arrow key moves to (wrapping), or null for any other key. */
export function arrowTarget(from: HTMLElement, key: string): HTMLElement | null {
  const step =
    key === 'ArrowDown' || key === 'ArrowRight'
      ? 1
      : key === 'ArrowUp' || key === 'ArrowLeft'
        ? -1
        : 0;
  if (step === 0) return null;
  const radios = radiosOf(from);
  const at = radios.indexOf(from);
  if (at < 0 || radios.length < 2) return null;
  return radios[(at + step + radios.length) % radios.length];
}

/** Makes the chosen radio the group's one tab stop; with none chosen, the first radio is. */
export function syncTabStops(el: HTMLElement | null): void {
  if (!el) return;
  const radios = radiosOf(el);
  const chosen = radios.some(r => r.getAttribute('aria-checked') === 'true');
  radios.forEach((r, i) => {
    const stop = chosen ? r.getAttribute('aria-checked') === 'true' : i === 0;
    r.tabIndex = stop ? 0 : -1;
  });
}
