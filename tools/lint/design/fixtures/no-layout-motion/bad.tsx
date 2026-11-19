const rows = [{ height: 40 }, { height: 0 }];
const grow = { width: ['0px', '200px'], opacity: [0, 1] };

export function View() {
  return (
    <div>
      <span
        style={{ transition: 'all var(--dur-hover)' }} // @expect
      />
      <span
        style={{ transition: 'width var(--dur-slide) var(--ease-out)' }} // @expect
      />
      <span
        style={{ transition: `padding ${'x'}ms, opacity var(--dur-hover)` }} // @expect
      />
      <span
        style={{ transitionProperty: 'height, opacity' }} // @expect
      />
    </div>
  );
}

export const shorthand = `transition: margin-left var(--dur-close)`; // @expect
export const sheet = `@keyframes x { to { width: 10px; } }`; // @expect

export function move(el: HTMLElement, dur: { close: number }) {
  el.style.transition = 'all var(--dur-close)'; // @expect
  el.animate({ width: ['0px', '200px'] }, { duration: dur.close }); // @expect
  el.animate([{ height: 0 }, { height: 40 }], { duration: dur.close }); // @expect
  el.animate([{ opacity: 1, paddingLeft: 0 }, { opacity: 0, paddingLeft: 8 }], { duration: dur.close }); // @expect
  el.animate([{ fontSize: 12 }, { fontSize: 14 }], { duration: dur.close }); // @expect
  el.animate(rows, { duration: dur.close }); // @expect
  el.animate(grow, { duration: dur.close }); // @expect
  el.animate([{ top: 0 }, { top: 10 }], { duration: dur.close }); // @expect
}
