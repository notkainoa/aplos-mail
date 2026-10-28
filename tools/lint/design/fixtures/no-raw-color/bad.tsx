const prefix = 'x';
const hue = 210;

export const hex = '#0b5394'; // @expect
export const hexWithAlpha = "#0b539480"; // @expect
export const shortHex = '#fff'; // @expect
export const template = `${prefix} #0b5394`; // @expect
export const rgbString = 'rgb(0, 0, 0)'; // @expect
export const hslTemplate = `hsl(${hue} 50% 40%)`; // @expect
export const oklchString = 'oklch(0.5 0.1 200)'; // @expect
export const mixWithHex = 'color-mix(in srgb, #0b5394 8%, transparent)'; // @expect
export const mixWithName = 'color-mix(in srgb, red 50%, var(--paper))'; // @expect
export const cssText = 'color: #fff; padding: 0'; // @expect
export const sheet = `.x { color: #fff; }`; // @expect

export function View({ cond }: { cond: boolean }) {
  return (
    <div>
      <span
        style={{ color: '#fff' }} // @expect
      />
      <span
        style={{ color: 'red' }} // @expect
      />
      <span
        style={{ borderColor: 'tomato' }} // @expect
      />
      <span
        style={{ background: cond ? '#fff' : 'var(--paper)' }} // @expect
      />
      <span
        style={{ '--wash': 'rgba(0,0,0,.2)' }} // @expect
      />
    </div>
  );
}

export function paint(el: HTMLElement) {
  el.style.color = '#abc'; // @expect
  el.style.background = 'white'; // @expect
  el.style.setProperty('background', 'oklch(0.5 0.1 200)'); // @expect
}

export const split = '#0b' + '5394'; // @expect
export const joined = '#' + '0b5394'; // @expect
export const fillAttr = <svg><path fill="red" stroke="white" /></svg>; // @expect
export const stopAttr = <svg><stop stopColor="black" /></svg>; // @expect
const theme = { color: 'red' }; // @expect
export const themed = <div style={theme} />;
