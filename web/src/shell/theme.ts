/* Light, dark, or whatever the system says.
 *
 * The Insightis design system toggles a `dark` class on the root, so that is what this sets - which means
 * every vendored component's dark: utilities work untouched. "System" is the absence of a choice, so it
 * removes the stored value rather than storing a third one, and then follows prefers-color-scheme.
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'mouseflow.theme';

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function read(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch (_) {
    return 'system';
  }
}

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark());
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Applied before React renders, so the first paint is already the right colour. */
export function bootTheme() {
  applyTheme(read());
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (read() === 'system') applyTheme('system'); });
}

export function useTheme() {
  const [theme, setStored] = useState<Theme>(read);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const set = useCallback((next: Theme) => {
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch (_) { /* private mode */ }
    setStored(next);
  }, []);

  return [theme, set] as const;
}
