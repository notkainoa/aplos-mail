export function View() {
  return (
    <div>
      <span style={{ transition: 'opacity var(--dur-hover) var(--ease-std)' }} />
      <span style={{ transition: 'transform var(--dur-slide) var(--spring-slide), color var(--dur-hover)' }} />
      <span style={{ transitionProperty: 'opacity, transform, background-color' }} />
      <span style={{ width: 40, height: 40, paddingLeft: 0 }} />
    </div>
  );
}

const ease = { carry: 'var(--ease-carry)' };

export function move(el: HTMLElement, dur: { carry: number; flight: number }) {
  el.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(28px)', opacity: 0 }], { duration: dur.carry });
  el.animate({ opacity: [0, 1], backgroundColor: ['transparent', 'var(--accent-wash)'] }, { duration: dur.flight });
  el.animate([{ opacity: 1, offset: 0 }, { opacity: 0, offset: 1, easing: ease.carry }], { duration: dur.carry });
}
