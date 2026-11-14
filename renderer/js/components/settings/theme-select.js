import { icons } from '../../icons.js';
import { theme } from '../../core/theme.js';
import { bus } from '../../core/events.js';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'display' },
];

/*
 * Theme dropdown used by the Settings view.
 * Reads and writes the shared theme controller, so the rest of the app
 * updates immediately when the user picks a mode.
 */
export function createThemeSelect() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-select-wrap';

  wrap.innerHTML = `
    <button type="button" class="settings-select" aria-haspopup="listbox" aria-expanded="false" aria-label="Theme">
      <span class="icon settings-select-icon" data-ref="current-icon"></span>
      <span class="settings-select-label" data-ref="current-label"></span>
      <span class="icon icon-chevron-down settings-select-chevron" aria-hidden="true"></span>
    </button>
    <div class="settings-select-menu" role="listbox" aria-label="Theme" hidden>
      ${OPTIONS.map((option) => `
        <button type="button" class="settings-select-option" role="option" data-value="${option.value}" aria-selected="false">
          <span class="icon icon-${option.icon}" aria-hidden="true"></span>
          <span class="settings-select-option-label">${option.label}</span>
          <span class="settings-select-check" aria-hidden="true"><span class="icon icon-check"></span></span>
        </button>`).join('')}
    </div>`;

  const button = wrap.querySelector('.settings-select');
  const menu = wrap.querySelector('.settings-select-menu');
  const label = wrap.querySelector('[data-ref="current-label"]');
  const icon = wrap.querySelector('[data-ref="current-icon"]');
  const options = [...wrap.querySelectorAll('.settings-select-option')];

  const sync = () => {
    const current = OPTIONS.find((option) => option.value === theme.getMode()) || OPTIONS[2];
    label.textContent = current.label;
    icon.className = `icon settings-select-icon icon-${current.icon}`;
    options.forEach((option) => {
      option.setAttribute('aria-selected', String(option.dataset.value === current.value));
    });
  };

  const setOpen = (open, { focusOption = false } = {}) => {
    button.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    wrap.classList.toggle('is-open', open);
    if (open && focusOption) {
      (menu.querySelector('[aria-selected="true"]') || options[0])?.focus();
    }
  };

  const close = ({ restoreFocus = false } = {}) => {
    setOpen(false);
    if (restoreFocus) button.focus();
  };

  const onButtonClick = () => setOpen(menu.hidden);
  const onOptionClick = (event) => {
    const option = event.target.closest('[data-value]');
    if (!option) return;
    theme.set(option.dataset.value);
    close({ restoreFocus: true });
  };
  const onDocumentClick = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }

    if (event.key === 'ArrowDown' && document.activeElement === button) {
      event.preventDefault();
      setOpen(true, { focusOption: true });
      return;
    }

    if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = options.indexOf(document.activeElement);
      let nextIndex = index;

      if (event.key === 'ArrowDown') nextIndex = index < 0 ? 0 : (index + 1) % options.length;
      if (event.key === 'ArrowUp') nextIndex = index < 0 ? options.length - 1 : (index - 1 + options.length) % options.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = options.length - 1;

      options[nextIndex]?.focus();
    }
  };

  button.addEventListener('click', onButtonClick);
  menu.addEventListener('click', onOptionClick);
  wrap.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick);

  const offTheme = bus.on('theme:changed', sync);
  sync();

  return {
    element: wrap,
    destroy() {
      document.removeEventListener('click', onDocumentClick);
      offTheme();
    },
  };
}
