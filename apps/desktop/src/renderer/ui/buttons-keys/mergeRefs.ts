import type { Ref, RefCallback } from 'react';

/** One ref callback that fills several refs (object or callback); undefined and null refs are skipped. */
export function mergeRefs<T>(...refs: ReadonlyArray<Ref<T> | undefined>): RefCallback<T> {
  return node => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}
