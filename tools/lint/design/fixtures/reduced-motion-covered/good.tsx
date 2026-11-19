declare const el: HTMLElement;
declare const dur: Record<string, number>;
const frames = [{ opacity: 0 }, { opacity: 1 }];

export function loops() {
  el.animate(frames, { duration: dur.breathe, iterations: Infinity });
  el.animate(frames, { duration: dur.status, iterations: Infinity });
  el.animate(frames, { duration: dur.quick, iterations: 2 });
  el.style.animation = '';
}

export const breathing = <div style={{ animation: 'pulse var(--dur-breathe) infinite' }} />;
export const status = <div style={{ animationIterationCount: 'infinite', animationDuration: 'var(--dur-status)' }} />;
export const quiet = <div style={{ animation: 'none' }} />;
