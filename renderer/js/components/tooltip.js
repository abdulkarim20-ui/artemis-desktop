/**
 * ============================================================================
 * TOOLTIPS (renderer/js/components/tooltip.js)
 * ============================================================================
 * One tooltip for the whole app, driven by attributes:
 *
 *   data-tooltip="Copy"              the text
 *   data-tooltip-kbd="Ctrl+U"        optional shortcut chips
 *   data-tooltip-side="right"        top (default) | bottom | left | right
 *   data-tooltip-when="collapsed"    only while the sidebar is collapsed
 *
 * Native title attributes are adopted automatically, so the OS tooltip never
 * appears beside this one.
 * ============================================================================
 */
const SHOW_DELAY = 400;
const WARM_WINDOW = 500;
const GAP = 8;
const EDGE = 8;
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function initTooltips() {
  if (document.getElementById('app-tooltip')) return () => {};

  const tip = document.createElement('div');
  tip.id = 'app-tooltip';
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');

  const body = document.createElement('div');
  body.className = 'tooltip-body';
  const label = document.createElement('span');
  label.className = 'tooltip-label';
  const keys = document.createElement('span');
  keys.className = 'tooltip-keys';
  keys.hidden = true;
  body.append(label, keys);
  tip.append(body);
  document.body.append(tip);

  let hovered = null;
  let anchor = null;
  let showTimer = 0;
  let watchTimer = 0;
  let lastHiddenAt = 0;

  const adopt = (element) => {
    const native = element.getAttribute('title');
    if (!native || !native.trim()) return;
    element.dataset.tooltip = native.trim();
    if (!element.hasAttribute('aria-label') && !element.textContent.trim()) {
      element.setAttribute('aria-label', native.trim());
    }
    element.removeAttribute('title');
  };

  const find = (target) => {
    const element = target instanceof Element ? target.closest('[data-tooltip], [title]') : null;
    if (!element) return null;
    adopt(element);
    if (!element.dataset.tooltip) return null;
    if (element.dataset.tooltipWhen === 'collapsed' && element.closest('.sidebar')?.dataset.expanded === 'true') return null;
    return element;
  };

  const fill = (element) => {
    label.textContent = element.dataset.tooltip;
    keys.replaceChildren();
    const combo = element.dataset.tooltipKbd;
    if (combo) {
      for (const part of combo.split('+')) {
        const key = document.createElement('kbd');
        key.textContent = part.trim();
        keys.append(key);
      }
    }
    keys.hidden = !combo;
  };

  const place = (element) => {
    const preferred = hasOwn(OPPOSITE, element.dataset.tooltipSide) ? element.dataset.tooltipSide : 'top';
    const rect = element.getBoundingClientRect();

    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fits = {
      top: rect.top - GAP - height >= EDGE,
      bottom: rect.bottom + GAP + height <= viewportHeight - EDGE,
      left: rect.left - GAP - width >= EDGE,
      right: rect.right + GAP + width <= viewportWidth - EDGE,
    };
    const side = fits[preferred] ? preferred : (fits[OPPOSITE[preferred]] ? OPPOSITE[preferred] : preferred);

    let x;
    let y;
    if (side === 'top' || side === 'bottom') {
      x = rect.left + rect.width / 2 - width / 2;
      y = side === 'top' ? rect.top - GAP - height : rect.bottom + GAP;
    } else {
      y = rect.top + rect.height / 2 - height / 2;
      x = side === 'left' ? rect.left - GAP - width : rect.right + GAP;
    }

    x = clamp(x, EDGE, viewportWidth - width - EDGE);
    y = clamp(y, EDGE, viewportHeight - height - EDGE);
    tip.dataset.side = side;
    tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  const close = () => {
    clearTimeout(showTimer);
    clearInterval(watchTimer);
    hovered = null;

    if (!tip.classList.contains('is-visible')) {
      anchor = null;
      return;
    }
    tip.classList.remove('is-visible');
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
    lastHiddenAt = Date.now();
  };

  const open = (element) => {
    if (!element.isConnected) return;
    const wasVisible = tip.classList.contains('is-visible');

    anchor?.removeAttribute('aria-describedby');
    anchor = element;
    fill(element);
    place(element);
    if (!wasVisible) void tip.offsetWidth;
    tip.classList.add('is-visible');
    element.setAttribute('aria-describedby', tip.id);

    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!anchor || !anchor.isConnected || !(anchor.matches(':hover') || anchor.matches(':focus-visible'))) close();
    }, 250);
  };

  const schedule = (element) => {
    clearTimeout(showTimer);
    const warm = tip.classList.contains('is-visible') || Date.now() - lastHiddenAt < WARM_WINDOW;
    if (warm) open(element);
    else showTimer = setTimeout(() => open(element), SHOW_DELAY);
  };

  const onOver = (event) => {
    if (event.pointerType === 'touch') return;
    const element = find(event.target);
    if (element === hovered) return;
    hovered = element;
    if (!element) { close(); return; }
    schedule(element);
  };

  const onFocusIn = (event) => {
    const element = find(event.target);
    if (!element || !element.matches(':focus-visible')) return;
    hovered = element;
    open(element);
  };

  const onKey = (event) => { if (event.key === 'Escape') close(); };

  const doc = document;
  const root = document.documentElement;
  doc.addEventListener('pointerover', onOver, true);
  doc.addEventListener('pointerdown', close, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', close, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', close, true);
  root.addEventListener('pointerleave', close);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  return () => {
    close();
    doc.removeEventListener('pointerover', onOver, true);
    doc.removeEventListener('pointerdown', close, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', close, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', close, true);
    root.removeEventListener('pointerleave', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    tip.remove();
  };
}
