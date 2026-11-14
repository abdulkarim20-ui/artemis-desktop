import { el, icon, iconButton, setDisabled, textInput } from './dom.js';
import { createMessage } from './message.js';

const DELETE_CONFIRM_MS = 3000;

export function createProviderCard({ provider, bridge, onStatus, refresh }) {
  const card = el('div', 'settings-card api-key-card');
  const head = el('div', 'api-key-card-head');
  const title = el('div', 'settings-row-title', `${provider.name} API key`);
  const help = el('div', 'settings-key-help');
  const link = el('a', 'settings-link');
  link.href = '#';
  link.rel = 'noopener noreferrer';
  link.append(el('span', 'settings-link-text', provider.helpLabel));
  const linkIcon = el('span', 'settings-link-icon');
  linkIcon.innerHTML = icon('external-link');
  link.appendChild(linkIcon);
  help.append(el('span', '', 'Get your key at'), link);
  head.append(title, help);

  const saved = el('div', 'api-key-saved');
  saved.hidden = true;
  const savedField = el('div', 'api-key-saved-field');
  const masked = el('code', 'api-key-masked');
  const savedVisibility = iconButton('Show API key', 'eye');
  savedField.append(masked, savedVisibility);
  const actions = el('div', 'api-key-actions');
  const edit = iconButton('Edit key', 'edit');
  const remove = iconButton('Remove key', 'trash', 'settings-icon-btn--delete');
  actions.append(edit, remove);
  saved.append(savedField, actions);

  const control = el('div', 'api-key-control');
  control.hidden = true;
  const inputWrap = el('div', 'api-key-input-wrap');
  const input = textInput({
    type: 'password',
    placeholder: provider.placeholder,
    label: `${provider.name} API key`,
  });
  const visibility = iconButton('Show API key', 'eye');
  visibility.hidden = true;
  const saveIcon = iconButton('Save', 'check', 'settings-icon-btn--key-save');
  const cancel = iconButton('Cancel', 'close', 'settings-icon-btn--key-cancel');
  saveIcon.hidden = true;
  cancel.hidden = true;
  inputWrap.append(input, visibility);
  control.append(inputWrap, saveIcon, cancel);

  const messageNode = el('div', 'settings-key-msg api-key-msg');
  const message = createMessage(messageNode);
  let busy = false;
  let locked = false;
  let configured = false;
  let editing = false;
  let confirmTimer = null;
  let preview = '';
  let savedRevealValue = '';
  let savedRevealed = false;
  let originalValue = '';

  const applyDisabled = () => {
    const disabled = busy || locked;
    setDisabled([input, visibility, savedVisibility, cancel, edit, remove], disabled);
    saveIcon.disabled = disabled || !input.value.trim() || input.value === originalValue;
  };

  const setVisibility = (visible) => {
    input.type = visible ? 'text' : 'password';
    const label = visible ? 'Hide API key' : 'Show API key';
    visibility.title = label;
    visibility.setAttribute('aria-label', label);
    visibility.innerHTML = icon(visible ? 'eye-off' : 'eye');
  };

  const updateActionVisibility = () => {
    const showActions = (configured && editing) || (!configured && input.value.length > 0);
    saveIcon.hidden = !showActions;
    cancel.hidden = !showActions;
    visibility.hidden = !showActions;
  };

  setVisibility(false);

  const setSavedVisibility = (visible) => {
    const label = visible ? 'Hide API key' : 'Show API key';
    savedVisibility.title = label;
    savedVisibility.setAttribute('aria-label', label);
    savedVisibility.innerHTML = icon(visible ? 'eye-off' : 'eye');
  };

  const resetSavedReveal = () => {
    savedRevealed = false;
    savedRevealValue = '';
    masked.textContent = preview;
    masked.classList.remove('is-revealed');
    setSavedVisibility(false);
  };

  const getSavedKey = async () => {
    const result = await bridge.reveal(provider.id);
    if (!result?.ok || typeof result.value !== 'string') {
      throw new Error(result?.error || 'Could not load the saved API key.');
    }
    return result.value;
  };

  const resetConfirm = () => {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    delete remove.dataset.confirm;
    remove.title = 'Remove key';
    remove.setAttribute('aria-label', 'Remove key');
  };

  const setEditing = (value) => {
    editing = Boolean(value && configured);
    saved.hidden = !configured || editing;
    control.hidden = configured && !editing;
    edit.hidden = !configured || editing;
    remove.hidden = !configured || editing;
    updateActionVisibility();
    if (editing) input.focus();
    else {
      input.value = '';
      originalValue = '';
      setVisibility(false);
    }
    resetConfirm();
    applyDisabled();
  };

  const render = (info, { encryptionAvailable }) => {
    locked = !encryptionAvailable;
    configured = Boolean(info?.configured && info.masked);
    preview = configured ? info.masked : '';
    resetSavedReveal();
    savedVisibility.hidden = !configured;
    if (!configured && editing) {
      editing = false;
      input.value = '';
      originalValue = '';
      setVisibility(false);
    }
    saved.hidden = !configured || editing;
    control.hidden = configured && !editing;
    edit.hidden = !configured || editing;
    remove.hidden = !configured || editing;
    updateActionVisibility();
    input.placeholder = configured
      ? `Enter a new ${provider.name} API key to replace the saved key`
      : provider.placeholder;
    updateActionVisibility();
    resetConfirm();
    applyDisabled();
  };

  const run = async (action, pending, success) => {
    if (busy) return { ok: false };
    busy = true;
    applyDisabled();
    message.show(pending);
    let result;
    try {
      result = (await action()) || { ok: false, error: 'No response from the app.' };
      if (result.status) onStatus(result.status);
      else if (result.ok) await refresh();

      if (!result.ok) {
        message.show(result.error || 'That did not work.', { error: true });
      } else if (result.error || result.active === false) {
        message.show(result.error || 'The AI agent could not restart.', { error: true });
      } else {
        message.show(success, { clearAfter: 4000 });
      }
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
      message.show(result.error, { error: true });
    } finally {
      busy = false;
      applyDisabled();
    }
    return result;
  };

  const saveKey = async () => {
    if (!input.value.trim()) {
      message.show('Paste an API key first.', { error: true });
      input.focus();
      return;
    }
    if (configured && editing && input.value === originalValue) return;
    const result = await run(
      () => bridge.save(provider.id, input.value),
      'Saving the API key...',
      'API key saved.',
    );
    if (result?.ok) setEditing(false);
  };

  const loadForEdit = async () => {
    if (!configured || busy) return;
    busy = true;
    applyDisabled();
    message.show('Loading saved API key...');
    try {
      input.value = savedRevealed ? savedRevealValue : await getSavedKey();
      originalValue = input.value;
      resetSavedReveal();
      setVisibility(false);
      message.clear();
      setEditing(true);
    } catch (error) {
      message.show(error?.message || 'Could not load the saved API key.', { error: true });
    } finally {
      busy = false;
      applyDisabled();
      if (editing) input.focus();
    }
  };

  const toggleSavedVisibility = async () => {
    if (!configured || busy) return;
    if (savedRevealed) {
      resetSavedReveal();
      return;
    }

    busy = true;
    applyDisabled();
    message.show('Loading saved API key...');
    try {
      savedRevealValue = await getSavedKey();
      savedRevealed = true;
      masked.textContent = savedRevealValue;
      masked.classList.add('is-revealed');
      setSavedVisibility(true);
      message.clear();
    } catch (error) {
      message.show(error?.message || 'Could not load the saved API key.', { error: true });
    } finally {
      busy = false;
      applyDisabled();
    }
  };

  edit.addEventListener('click', loadForEdit);
  cancel.addEventListener('click', () => {
    if (configured && editing) {
      setEditing(false);
      return;
    }
    input.value = '';
    originalValue = '';
    setVisibility(false);
    message.clear();
    updateActionVisibility();
    applyDisabled();
  });
  visibility.addEventListener('click', () => setVisibility(input.type === 'password'));
  savedVisibility.addEventListener('click', toggleSavedVisibility);
  saveIcon.addEventListener('click', saveKey);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveKey();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (configured && editing) setEditing(false);
      else if (!configured) {
        input.value = '';
        originalValue = '';
        setVisibility(false);
        updateActionVisibility();
        applyDisabled();
      }
    }
  });
  input.addEventListener('input', () => {
    if (!configured && !input.value) setVisibility(false);
    updateActionVisibility();
    applyDisabled();
  });

  remove.addEventListener('click', () => {
    if (!configured || busy) return;
    if (remove.dataset.confirm) {
      resetConfirm();
      run(
        () => bridge.clear(provider.id),
        'Removing the API key...',
        'API key removed.',
      );
      return;
    }
    remove.dataset.confirm = 'true';
    remove.title = 'Click again to remove';
    remove.setAttribute('aria-label', 'Click again to confirm removing the key');
    message.show('Click the bin again to remove this key.', { clearAfter: DELETE_CONFIRM_MS });
    confirmTimer = setTimeout(resetConfirm, DELETE_CONFIRM_MS);
  });

  link.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const result = await bridge.openHelp(provider.id);
      if (!result?.ok) message.show(result?.error || 'Could not open the provider page.', { error: true });
    } catch (error) {
      message.show(error?.message || 'Could not open the provider page.', { error: true });
    }
  });

  card.append(head, saved, control, messageNode);

  return {
    element: card,
    render,
    disable() {
      locked = true;
      applyDisabled();
    },
    destroy() {
      clearTimeout(confirmTimer);
      message.destroy();
    },
  };
}
