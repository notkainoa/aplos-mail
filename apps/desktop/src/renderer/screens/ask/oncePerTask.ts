/**
 * A same-tick dedupe for fire-and-forget commands: a double click or a key repeat inside one microtask
 * runs the wrapped work once; the next task is a fresh press. Kept out of AskDockHost so tests can
 * import it without the host's stylesheet.
 */
export function oncePerTask() {
  const seen = new Set<string>();
  return (key: string, run: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    queueMicrotask(() => seen.delete(key));
    run();
  };
}
