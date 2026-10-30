/**
 * Reopening a failed list. `useView` and `useHome` watch their view once per mount and have no retry of their own, so
 * "Try again" remounts the screen body: the old window is released and a fresh one is watched. Wrap a screen's body in
 * `Reopenable`; `ListFailed` reads `useReopen` for its Try again.
 */
import { createContext, Fragment, useCallback, useContext, useState, type ReactNode } from 'react';

function noReopen(): void {
  // Outside a Reopenable (a bare list in a test) there is nothing to remount.
}

const ReopenContext = createContext<() => void>(noReopen);

/** The callback that reopens the enclosing screen's views. */
export function useReopen(): () => void {
  return useContext(ReopenContext);
}

/** Remounts its children when a descendant calls `useReopen()()`. */
export function Reopenable({ children }: { readonly children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const reopen = useCallback(() => setGeneration(current => current + 1), []);
  return (
    <ReopenContext.Provider value={reopen}>
      <Fragment key={generation}>{children}</Fragment>
    </ReopenContext.Provider>
  );
}
