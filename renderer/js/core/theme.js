import { bus } from './events.js';
import { storage } from './storage.js';

const MODES = new Set(['light', 'dark', 'system']);
const systemQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

let mode = 'dark';

const systemTheme = () => (systemQuery && systemQuery.matches ? 'dark' : 'light');
const resolve = (value) => (value === 'system' ? systemTheme() : value);

function apply(value, { persist = false } = {}) {
  mode = MODES.has(value) ? value : 'dark';

  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;

  if (persist) storage.set('theme', mode);
  bus.emit('theme:changed', resolved);
}

// Keep "System" mode in sync while the OS theme changes.
if (systemQuery && typeof systemQuery.addEventListener === 'function') {
  systemQuery.addEventListener('change', () => {
    if (mode === 'system') apply('system');
  });
}

export const theme = {
  init(defaultTheme = 'dark') {
    apply(storage.get('theme', defaultTheme));
  },
  set(value) {
    apply(value, { persist: true });
  },
  get() {
    return resolve(mode);
  },
  getMode() {
    return mode;
  },
};
