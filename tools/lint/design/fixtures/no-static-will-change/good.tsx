export function View() {
  return <div style={{ opacity: 1, transform: 'none' }} />;
}

// Set only while an animation runs, removed on finish.
export function animateGhost(ghost: HTMLElement, done: Promise<unknown>) {
  ghost.style.willChange = 'transform, opacity';
  ghost.style.setProperty('will-change', 'transform');
  done.finally(() => {
    ghost.style.willChange = 'auto';
  });
}
