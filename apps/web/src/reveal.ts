import { useEffect } from 'react';

// Elements marked data-reveal rise into place once, as they enter the viewport. Styles live in styles/base.css.
/** Calls `onChange` as `target` enters or leaves the viewport. A browser without IntersectionObserver counts as visible. */
export function observeVisible(
  target: Element,
  threshold: number,
  onChange: (visible: boolean) => void,
) {
  if (!('IntersectionObserver' in window)) {
    onChange(true);
    return () => {};
  }
  const observer = new IntersectionObserver(([entry]) => onChange(entry.isIntersecting), {
    threshold,
  });
  observer.observe(target);
  return () => observer.disconnect();
}

export function useReveal() {
  useEffect(() => {
    const items = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
    if (!('IntersectionObserver' in window)) {
      items.forEach(i => i.classList.add('is-in'));
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            observer.unobserve(entry.target);
          }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    items.forEach(i => observer.observe(i));
    return () => observer.disconnect();
  }, []);
}
