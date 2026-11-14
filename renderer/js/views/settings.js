import { icons } from '../icons.js';
import { createThemeSelect } from '../components/settings/theme-select.js';
import { createApiKeysSection } from '../components/settings/api-keys/index.js';

const shortcutRow = (title, hint, keys) => `
  <div class="settings-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">${title}</div>
      <div class="settings-row-hint">${hint}</div>
    </div>
    <div class="settings-row-control">
      <span class="settings-keys">
        ${keys.map((key) => `<kbd class="settings-kbd">${key}</kbd>`).join('<span class="settings-key-plus">+</span>')}
      </span>
    </div>
  </div>`;

/*
 * Settings view. The left navigation is data-driven so more sections can be
 * registered here later without changing the main view mount logic.
 * Sections: General, API Keys.
 */
export function mountSettingsView(root) {
  const section = document.createElement('section');
  section.className = 'settings';

  section.innerHTML = `
    <aside class="settings-nav">
      <div class="settings-nav-title">Settings</div>
      <nav class="settings-nav-group" aria-label="Settings sections">
        <button type="button" class="settings-nav-btn" data-section="general" aria-current="true">
          ${icons.settings}
          <span>General</span>
        </button>
        <button type="button" class="settings-nav-btn" data-section="api-keys">
          ${icons.key}
          <span>API Keys</span>
        </button>
      </nav>
      <div class="settings-nav-footer">Artemis</div>
    </aside>

    <div class="settings-content">
      <div class="settings-content-inner" data-panel="general">
        <h1 class="settings-title">General</h1>
        <p class="settings-subtitle">Manage how Artemis looks and behaves, and where your chats live.</p>

        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row-copy">
              <div class="settings-row-title">Theme</div>
              <div class="settings-row-hint">Choose Light, Dark, or match your system theme.</div>
            </div>
            <div class="settings-row-control" data-ref="theme-control"></div>
          </div>

          ${shortcutRow('Send message', 'Send the current prompt from the chat input.', ['Enter'])}
          ${shortcutRow('New line', 'Add a line break without sending.', ['Shift', 'Enter'])}
          ${shortcutRow('Attach files', 'Open the file picker from the chat input.', ['Ctrl', 'U'])}
        </div>

        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row-copy">
              <div class="settings-row-title">History folder</div>
              <div class="settings-row-hint settings-history-hint">Chats, attachments, and titles are saved here.</div>
              <code class="settings-history-path" data-ref="history-path"></code>
            </div>
            <div class="settings-row-control">
              <button type="button" class="settings-btn" data-ref="open-history">
                <span class="icon icon-folder" aria-hidden="true"></span>
                <span>Open folder</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-content-inner" data-panel="api-keys" hidden>
        <h1 class="settings-title">API Keys</h1>
        <p class="settings-subtitle">Add your own provider keys so Artemis can reach the AI models.</p>
        <div data-ref="api-keys-mount"></div>
      </div>
    </div>`;

  const themeControl = createThemeSelect();
  section.querySelector('[data-ref="theme-control"]').appendChild(themeControl.element);

  const apiKeys = createApiKeysSection();
  section.querySelector('[data-ref="api-keys-mount"]').appendChild(apiKeys.element);

  const navButtons = [...section.querySelectorAll('.settings-nav-btn[data-section]')];
  const panels = [...section.querySelectorAll('[data-panel]')];
  const showSection = (id) => {
    navButtons.forEach((button) => {
      if (button.dataset.section === id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== id; });
  };
  navButtons.forEach((button) => {
    button.addEventListener('click', () => showSection(button.dataset.section));
  });

  /*
   * The history folder, shown and openable. One folder, always the same one:
   * the main process owns the path, the renderer only reads and opens it.
   */
  const openHistory = section.querySelector('[data-ref="open-history"]');
  const historyRow = openHistory?.closest('.settings-row');
  const historyPath = section.querySelector('[data-ref="history-path"]');

  if (!window.historyFolder) {
    historyRow?.remove(); // no bridge, no row: nothing to show or open
  } else {
    openHistory.addEventListener('click', () => window.historyFolder.open());
    window.historyFolder.get?.().then((info) => {
      if (info?.path) {
        historyPath.textContent = info.path;
        historyPath.title = info.path;
        openHistory.title = info.path;
      }
    }).catch(() => {});
  }

  root.replaceChildren(section);

  return () => {
    themeControl.destroy();
    apiKeys.destroy();
  };
}
