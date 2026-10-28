export const selector = 'document.querySelector(".pane")';
export const prose = 'The dock opens beside the pane; a deck of cards is not used.';

export function View({ active }: { active: boolean }) {
  return (
    <div className="pane">
      <div className={active ? 'row row-active' : 'row'} />
      <div style={{ transform: 'translateX(var(--move-dock))', opacity: 1 }} />
      <div className="decked kbd-airline" />
    </div>
  );
}

export function mark(el: HTMLElement) {
  el.classList.add('is-open');
  el.style.transform = 'translateX(0)';
}
