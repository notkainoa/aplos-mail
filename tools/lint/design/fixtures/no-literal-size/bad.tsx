export function View() {
  return (
    <div>
      <span
        style={{ padding: '0 7px' }} // @expect
      />
      <span
        style={{ padding: 8 }} // @expect
      />
      <span
        style={{ marginLeft: 12, color: 'var(--ink)' }} // @expect
      />
      <span
        style={{ gap: '4px' }} // @expect
      />
      <span
        style={{ fontSize: 14 }} // @expect
      />
      <span
        style={{ lineHeight: 1.5 }} // @expect
      />
      <span
        style={{ letterSpacing: '-0.1px' }} // @expect
      />
      <span
        style={{ borderRadius: 8 }} // @expect
      />
      <span
        style={{ boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} // @expect
      />
      <span
        style={{ zIndex: 10 }} // @expect
      />
      <span
        style={{ paddingTop: `${4}px 8px` }} // @expect
      />
    </div>
  );
}

export const shorthand = `padding: 0 7px; margin: 0`; // @expect
export const sheet = `.x { border-radius: 10px; }`; // @expect

export function place(el: HTMLElement) {
  el.style.padding = '6px'; // @expect
  el.style.zIndex = '5'; // @expect
  el.style.setProperty('gap', '12px'); // @expect
}

const nPad = 7;
const box = { padding: 7 }; // @expect
const layer = { zIndex: 9999 }; // @expect
export const concat = <div style={{ padding: 7 + 'px', fontSize: `${13}px` }} />; // @expect
export const viaConst = <div style={{ margin: `${nPad}px` }} />; // @expect
export const boxed = <div style={box} />;
export const layered = <div style={layer} />;
