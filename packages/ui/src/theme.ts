import { useEffect, useState } from 'react';
import type { Mode } from './palette';

const KEY = 'necromancer-theme';
type Choice = Mode | 'system';

function systemMode(): Mode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readChoice(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Follows the OS unless the viewer picked a theme; the pick is stamped on <html data-theme>. */
export function useTheme(): { mode: Mode; choice: Choice; cycle: () => void } {
  const [choice, setChoice] = useState<Choice>(readChoice);
  const [system, setSystem] = useState<Mode>(systemMode);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(systemMode());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (choice === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', choice);
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // Private mode: the choice just won't persist.
    }
  }, [choice]);

  const mode = choice === 'system' ? system : choice;
  const cycle = () => setChoice((c) => (c === 'system' ? (system === 'dark' ? 'light' : 'dark') : c === 'dark' ? 'light' : 'system'));
  return { mode, choice, cycle };
}

/** Reads a CSS custom property, re-reading when the mode changes. Canvas renderers can't use var() directly. */
export function useCssVar(name: string, mode: Mode): string {
  const [value, setValue] = useState(() => read(name));
  useEffect(() => {
    // Wait a frame so the new data-theme rules have applied.
    const id = requestAnimationFrame(() => setValue(read(name)));
    return () => cancelAnimationFrame(id);
  }, [name, mode]);
  return value;
}

function read(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
