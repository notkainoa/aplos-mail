export const gradient = 'linear-gradient(var(--paper), var(--shell))'; // @expect
export const stripes = `repeating-linear-gradient(45deg, ${'a'}, var(--paper))`; // @expect
export const radial = 'radial-gradient(var(--ink), transparent)'; // @expect
export const conic = 'conic-gradient(var(--accent), var(--hill))'; // @expect
export const toss = 'perspective(1400px) rotateY(14deg)'; // @expect
export const selector = 'document.querySelector(".dock-pill")'; // @expect
export const sheet = `.x { background: linear-gradient(var(--paper), var(--shell)); }`; // @expect

export function View({ active }: { active: boolean }) {
  return (
    <div>
      <div
        className="post-edge" // @expect
      />
      <div
        className={`airmail ${active ? 'on' : ''}`} // @expect
      />
      <div
        className={active ? 'deck has-next' : 'deck'} // @expect
      />
      <div
        className={['pane', active && 'low-line'].join(' ')} // @expect
      />
      <div
        style={{ backdropFilter: 'blur(20px)' }} // @expect
      />
      <div
        style={{ WebkitBackdropFilter: 'blur(20px)' }} // @expect
      />
      <div
        style={{ transform: 'rotateY(10deg)' }} // @expect
      />
      <div
        style={{ background: 'linear-gradient(red, blue)' }} // @expect
      />
    </div>
  );
}

export function mark(el: HTMLElement) {
  el.classList.add('reader-dock'); // @expect
  el.classList.toggle('skyscene', true); // @expect
  el.className = 'sky-scene'; // @expect
  el.style.backdropFilter = 'blur(4px)'; // @expect
  el.style.cssText = 'backdrop-filter: blur(4px)'; // @expect
}

const styles: Record<string, string> = {};
export const rotated = { transform: 'rotate3d(0, 1, 0, 14deg)' }; // @expect
export const tilted = { transform: 'rotateX(10deg) translateZ(4px)' }; // @expect
export const axis = { rotate: 'y 14deg' }; // @expect
export const preserved = { transformStyle: 'preserve-3d' }; // @expect
export const lifted = { transform: 'translate3d(0, 0, 10px)' }; // @expect
export const hidden = { backfaceVisibility: 'hidden' }; // @expect
export const modular = <div className={styles.readerDock} />; // @expect
export const cameled = <div className={styles.dockPill} />; // @expect
