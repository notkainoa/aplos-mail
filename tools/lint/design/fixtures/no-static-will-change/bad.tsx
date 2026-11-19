export function View() {
  return (
    <div>
      <span
        style={{ willChange: 'transform' }} // @expect
      />
      <span
        style={{ willChange: 'transform, opacity', opacity: 1 }} // @expect
      />
      <span
        style={{ WebkitWillChange: 'opacity' }} // @expect
      />
    </div>
  );
}

export const shorthand = `will-change: transform; opacity: 1`; // @expect
export const sheet = `.ghost { will-change: transform; }`; // @expect
