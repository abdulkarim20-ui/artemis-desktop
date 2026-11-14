import { bus } from '../../core/events.js';
import { icons } from '../../icons.js';
import { mountSettingsView } from '../../views/settings.js';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const setNavActive = (id) => {
  document.querySelectorAll('.nav-btn[data-nav]:not([data-action])').forEach((btn) => {
    if (btn.dataset.nav === id) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  });
};

/*
 * Settings modal.
 * Opens over the current view from the sidebar, keeps the underlying view
 * mounted, and restores the previous navigation item when it closes.
 */
export function mountSettingsModal({ getReturnView } = {}) {
  let backdrop = null;
  let panel = null;
  let cleanupView = null;
  let lastFocus = null;
  let isOpen = false;
  let closeTimer = null;

  const returnView = () => {
    const id = typeof getReturnView === 'function' ? getReturnView() : null;
    return id || 'chat';
  };

  const onKeydown = (event) => {
    if (!isOpen || !panel) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      return;
    }

    if (event.key !== 'Tab') return;

    const items = [...panel.querySelectorAll(FOCUSABLE)]
      .filter((element) => !element.disabled && element.offsetParent !== null);

    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const hide = ({ restoreFocus = true } = {}) => {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(closeTimer);

    document.removeEventListener('keydown', onKeydown, true);

    if (typeof cleanupView === 'function') {
      cleanupView();
      cleanupView = null;
    }

    const closingBackdrop = backdrop;
    backdrop = null;
    panel = null;

    document.body.classList.remove('settings-open');

    if (closingBackdrop) {
      closingBackdrop.classList.remove('is-visible');
      closingBackdrop.style.pointerEvents = 'none';
      closeTimer = setTimeout(() => closingBackdrop.remove(), 170);
    }

    // A nav click that closed the modal has already selected its new item.
    const active = document.querySelector('.nav-btn[data-nav][aria-current="true"]');
    if (!active || active.dataset.nav === 'settings') {
      setNavActive(returnView());
    }

    if (restoreFocus) {
      const target = document.querySelector('.nav-btn[data-nav="settings"]')
        || (lastFocus && lastFocus.isConnected ? lastFocus : null);
      target?.focus();
    }

    lastFocus = null;
  };

  const show = () => {
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;

    backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';

    panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Settings');
    panel.tabIndex = -1;

    cleanupView = mountSettingsView(panel);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'settings-close';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.innerHTML = icons.close;
    closeBtn.addEventListener('click', () => hide());
    panel.appendChild(closeBtn);

    backdrop.appendChild(panel);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) hide();
    });

    document.body.appendChild(backdrop);
    document.body.classList.add('settings-open');
    setNavActive('settings');

    // Allow the initial styles to paint before starting the transition.
    requestAnimationFrame(() => backdrop?.classList.add('is-visible'));

    document.addEventListener('keydown', onKeydown, true);
    panel.focus();
  };

  const offNav = bus.on('nav:select', ({ id }) => {
    if (id === 'settings') show();
    else hide({ restoreFocus: false });
  });

  return {
    open: show,
    close: hide,
    destroy() {
      hide({ restoreFocus: false });
      offNav();
    },
  };
}
