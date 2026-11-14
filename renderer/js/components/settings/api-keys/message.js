/* A small status line with an optional auto-clear timer. */
export function createMessage(node) {
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  let timer = null;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
    node.textContent = '';
    node.classList.remove('is-error');
  };

  const show = (text, { error = false, clearAfter = 0 } = {}) => {
    clearTimeout(timer);
    timer = null;
    node.textContent = text || '';
    node.classList.toggle('is-error', Boolean(text) && error);
    if (text && clearAfter) timer = setTimeout(clear, clearAfter);
  };

  return { show, clear, destroy: () => clearTimeout(timer) };
}
