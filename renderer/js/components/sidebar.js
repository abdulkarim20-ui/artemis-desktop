import { icons } from '../icons.js';
import { bus } from '../core/events.js';
import { storage } from '../core/storage.js';
import { readSidebarExpanded, saveSidebarExpanded } from '../core/sidebar-state.js';
import { mountHistoryList } from './history-list.js';
import { mountSidebarResize } from './sidebar-resize.js';

// `action` (optional): a bus event to emit instead of selecting a view.
const navButton = ({ id, label, icon, action }) => `
  <button class="nav-btn" data-nav="${id}"${action ? ` data-action="${action}"` : ''} aria-label="${label}"
          data-tooltip="${label}" data-tooltip-side="right" data-tooltip-when="collapsed">
    ${icons[icon] ?? ''}
    <span class="label">${label}</span>
  </button>`;

export function mountSidebar(root, { config }) {
  const { sidebar } = config;

  root.innerHTML = `
    <nav class="nav-group">${sidebar.items.map(navButton).join('')}</nav>
    <div id="chat-history"></div>
    <div class="nav-spacer"></div>
    <nav class="nav-group nav-group--footer">${sidebar.footer.map(navButton).join('')}</nav>`;

  const newChatButton = root.querySelector('[data-action="chat:new"]');
  const setNewChatPressed = (pressed) => {
    newChatButton?.setAttribute('aria-pressed', String(pressed));
  };
  setNewChatPressed(true);
  bus.on('chat:active', ({ isEmpty }) => setNewChatPressed(Boolean(isEmpty)));

  // Saved chats, directly under the New Chat button.
  mountHistoryList(root.querySelector('#chat-history'));

  // Showing a state is not the same as the user choosing it: only a toggle is saved.
  const showExpanded = (value) => {
    const expanded = Boolean(value);
    root.dataset.expanded = String(expanded);
    bus.emit('sidebar:expanded', { expanded });
  };
  showExpanded(readSidebarExpanded(storage, config.defaults.sidebarExpanded));
  mountSidebarResize(root, { storage });

  bus.on('sidebar:toggle', () => {
    const next = root.dataset.expanded !== 'true';
    showExpanded(next);
    saveSidebarExpanded(storage, next);
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;

    // An action button (New Chat) announces what the user wants and lets
    // chat-nav.js decide how to show it. The main view sets aria-current.
    if (btn.dataset.action) {
      if (btn.dataset.action === 'chat:new') setNewChatPressed(true);
      bus.emit(btn.dataset.action);
      return;
    }

    root.querySelectorAll('[data-nav]').forEach((b) => b.removeAttribute('aria-current'));
    btn.setAttribute('aria-current', 'true');
    bus.emit('nav:select', { id: btn.dataset.nav });
  });
}
