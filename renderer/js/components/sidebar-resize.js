const STORAGE_KEY = 'sidebar.expandedWidth';
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

export function mountSidebarResize(root, { storage }) {
  const configuredWidth = Number.parseFloat(
    getComputedStyle(root).getPropertyValue('--sidebar-w-expanded'),
  );
  const defaultWidth = Number.isFinite(configuredWidth) ? configuredWidth : 208;
  const savedWidth = storage.get(STORAGE_KEY, defaultWidth);
  let width = defaultWidth;
  let pointerId = null;
  let startX = 0;
  let startWidth = 0;

  const maxWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.45));
  const clampWidth = (value) => {
    const candidate = typeof value === 'number' && Number.isFinite(value) ? value : defaultWidth;
    return Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), candidate)));
  };

  const handle = document.createElement('div');
  handle.className = 'sidebar-resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize sidebar');
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.tabIndex = 0;
  root.appendChild(handle);

  const setWidth = (value, persist = false) => {
    width = clampWidth(value);
    root.style.setProperty('--sidebar-w-expanded', `${width}px`);
    handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    handle.setAttribute('aria-valuenow', String(width));
    if (persist) storage.set(STORAGE_KEY, width);
  };

  const finishResize = (event) => {
    if (pointerId === null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    pointerId = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', finishResize);
    window.removeEventListener('pointercancel', finishResize);
    window.removeEventListener('blur', finishResize);
    root.classList.remove('is-resizing');
    document.body.classList.remove('is-resizing-sidebar');
    storage.set(STORAGE_KEY, width);
  };

  const onPointerMove = (event) => {
    if (event.pointerId !== pointerId) return;
    setWidth(startWidth + event.clientX - startX);
  };

  const onPointerDown = (event) => {
    if (root.dataset.expanded !== 'true' || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    pointerId = event.pointerId;
    startX = event.clientX;
    startWidth = width;
    root.classList.add('is-resizing');
    document.body.classList.add('is-resizing-sidebar');
    handle.setPointerCapture?.(pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', finishResize);
  };

  const onKeyDown = (event) => {
    if (root.dataset.expanded !== 'true') return;
    const step = event.shiftKey ? 32 : 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth(width - step, true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth(width + step, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setWidth(MIN_WIDTH, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      setWidth(maxWidth(), true);
    }
  };

  const showBoundary = () => document.body.classList.add('sidebar-resize-active');
  const hideBoundary = () => document.body.classList.remove('sidebar-resize-active');

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('keydown', onKeyDown);
  handle.addEventListener('pointerenter', showBoundary);
  handle.addEventListener('pointerleave', hideBoundary);
  handle.addEventListener('focus', showBoundary);
  handle.addEventListener('blur', hideBoundary);
  setWidth(savedWidth);

  return () => {
    finishResize();
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('keydown', onKeyDown);
    handle.removeEventListener('pointerenter', showBoundary);
    handle.removeEventListener('pointerleave', hideBoundary);
    handle.removeEventListener('focus', showBoundary);
    handle.removeEventListener('blur', hideBoundary);
    hideBoundary();
    handle.remove();
    root.style.removeProperty('--sidebar-w-expanded');
  };
}
