import { bus } from '../core/events.js';

/*
 * Mounts a registered view inside the main panel.
 * Views may return a cleanup function; it runs before the next view is
 * mounted so timers, streams and global listeners do not leak.
 *
 * A view is identified by its id AND its params. Selecting the same view with
 * different params (a different chat) remounts it; selecting it with identical
 * params keeps the current instance and its state.
 */
export function mountMainView(root, { views = {}, defaultView = null, ignoredViews = [] } = {}) {
  let cleanup = null;
  let currentId = null;
  let currentKey = null;
  const ignored = new Set(ignoredViews);

  const setActiveNav = (id) => {
    document.querySelectorAll('.nav-btn[data-nav]:not([data-action])').forEach((btn) => {
      if (btn.dataset.nav === id) {
        btn.setAttribute('aria-current', 'true');
      } else {
        btn.removeAttribute('aria-current');
      }
    });
  };

  const render = (id, params = {}) => {
    if (!id || ignored.has(id)) return;

    const key = `${id}|${JSON.stringify(params ?? {})}`;

    // Re-selecting the current view should not tear it down and lose state.
    if (key === currentKey) {
      setActiveNav(id);
      return;
    }

    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch (error) {
        console.error(`[mainview] Cleanup for "${currentId}" failed:`, error);
      }
    }
    cleanup = null;
    currentId = id;
    currentKey = key;

    // Always clear the previous panel, even when the new nav id has no view.
    // This also stops the old view's timers and streaming work.
    root.replaceChildren();
    root.className = 'main';
    setActiveNav(id);

    const view = views[id];
    if (typeof view !== 'function') return;

    try {
      const result = view(root, params ?? {});
      if (typeof result === 'function') cleanup = result;
    } catch (error) {
      console.error(`[mainview] Failed to mount view "${id}":`, error);
    }
  };

  const offNav = bus.on('nav:select', ({ id, params }) => render(id, params));

  if (defaultView) {
    render(defaultView);
  }

  return {
    current: () => currentId,
    destroy() {
      offNav();
      if (typeof cleanup === 'function') {
        try { cleanup(); } catch { /* ignore */ }
      }
      cleanup = null;
    },
  };
}
