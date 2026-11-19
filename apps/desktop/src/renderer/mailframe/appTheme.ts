// Whether the app is in its dark theme, for the stand-in frame (the sealed frame asks the browser itself with
// `prefers-color-scheme`, which follows the app's theme through Electron's nativeTheme). The theme is the root's
// `data-theme`, else the system's.

import { useEffect, useState } from 'react';

function isDark(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement.getAttribute('data-theme');
  if (root === 'dark') return true;
  if (root === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** True while the app is dark; follows a theme switch. */
export function useAppDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const update = () => setDark(isDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const query =
      typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    query?.addEventListener('change', update);
    update();
    return () => {
      observer.disconnect();
      query?.removeEventListener('change', update);
    };
  }, []);
  return dark;
}
