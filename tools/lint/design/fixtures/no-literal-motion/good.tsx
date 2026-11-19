import { dur, ease } from './ui/generated/motion';

const kf = { opacity: [1, 0] };
const options = { duration: dur.carry, easing: ease.carry };

export function View() {
  return (
    <div>
      <span style={{ transition: `opacity ${dur.hover}ms var(--ease-std)` }} />
      <span style={{ transition: 'opacity var(--dur-hover) var(--ease-std)' }} />
      <span style={{ '--x': 'var(--dur-hover)' }} />
      <span style={{ transition: 'none' }} />
    </div>
  );
}

export function move(el: HTMLElement, onDone: () => void) {
  el.animate(kf, { duration: dur.carry, easing: ease.carry });
  el.animate(kf, options);
  el.animate(kf, { duration: dur.flight * 0.5, easing: ease.carry, fill: 'forwards' });
  el.animate([{ opacity: 1 }, { opacity: 0 }]);
  setTimeout(() => { el.focus(); }, 300);
  setTimeout(() => { el.classList.remove('enter'); }, dur.carry);
  setTimeout(onDone, 200);
}
