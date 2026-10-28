declare const el: HTMLElement;
declare const dur: Record<string, number>;
const frames = [{ opacity: 0 }, { opacity: 1 }];

export function loops() {
  el.animate(frames, { duration: dur.quick, iterations: Infinity }); // @expect
  el.animate(frames, { duration: dur.quick, iterations: 9999 }); // @expect
  el.animate(frames, { iterations: Infinity }); // @expect
}

export const forever = <div style={{ animation: 'pulse var(--dur-quick) infinite' }} />; // @expect
export const literal = <div style={{ animation: 'pulse 2s ease' }} />; // @expect
export const counted = <div style={{ animationIterationCount: 'infinite', animationDuration: 'var(--dur-quick)' }} />; // @expect
export const assigned = () => { el.style.animation = 'pulse 2s'; }; // @expect
