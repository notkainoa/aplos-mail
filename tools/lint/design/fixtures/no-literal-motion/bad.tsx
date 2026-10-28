const dur = { carry: 120, flight: 220 };
const delay = 40;
const kf = { opacity: [1, 0] };

export function View() {
  return (
    <div>
      <span
        style={{ transition: 'all 120ms' }} // @expect
      />
      <span
        style={{ transition: 'opacity 0.2s ease-out' }} // @expect
      />
      <span
        style={{ transitionDuration: '150ms' }} // @expect
      />
      <span
        style={{ '--x': '120ms' }} // @expect
      />
      <span
        style={{ animation: `fade ${delay}ms linear` }} // @expect
      />
      <span
        style={{ transitionTimingFunction: 'cubic-bezier(.2,.8,.2,1)' }} // @expect
      />
    </div>
  );
}

export const shorthand = `transition: opacity 200ms ease`; // @expect
export const sheet = `.x { transition: opacity 200ms; }`; // @expect

export function move(el: HTMLElement) {
  el.style.transition = 'transform 220ms cubic-bezier(.4,0,1,1)'; // @expect
  el.style.setProperty('--y', '90ms'); // @expect
  el.animate({ opacity: [1, 0] }, { duration: 220, easing: 'ease-out' }); // @expect
  el.animate(kf, 200); // @expect
  el.animate(kf, { duration: 120 + 40, fill: 'forwards' }); // @expect
  el.animate([{ opacity: 1, easing: 'linear' }, { opacity: 0 }], { duration: dur.carry }); // @expect
  el.animate(kf, { duration: dur.carry, delay: 20 }); // @expect
  setTimeout(() => { el.style.transform = 'none'; }, 300); // @expect
  setInterval(() => el.classList.toggle('is-animating'), 500); // @expect
  window.setTimeout(function () { el.classList.add('enter'); }, 120); // @expect
  setTimeout(fadeOut, 200); // @expect
}

function fadeOut() {
  const el = document.body;
  el.style.opacity = '0';
}
