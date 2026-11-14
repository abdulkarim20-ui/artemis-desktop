export const icon = (name) => `<span class="icon icon-${name}" aria-hidden="true"></span>`;

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const iconButton = (label, name, extraClass = '') => {
  const button = el('button', `settings-icon-btn ${extraClass}`.trim());
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon(name);
  return button;
};

export const textButton = (label, extraClass = '') => {
  const button = el('button', `settings-btn ${extraClass}`.trim(), label);
  button.type = 'button';
  return button;
};

export const textInput = ({ type = 'text', placeholder = '', label = '', maxLength } = {}) => {
  const input = el('input', 'settings-key-input');
  input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (maxLength) input.maxLength = maxLength;
  if (label) input.setAttribute('aria-label', label);
  return input;
};

export const setDisabled = (nodes, disabled) => {
  nodes.forEach((node) => { node.disabled = disabled; });
};
