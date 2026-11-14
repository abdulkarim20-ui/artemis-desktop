import { config } from './config.js';
import { theme } from './core/theme.js';
import { initChatNav } from './core/chat-nav.js';
import { mountTitlebar } from './components/titlebar.js';
import { mountSidebar } from './components/sidebar.js';
import { mountMainView } from './components/mainview.js';
import { mountSettingsModal } from './components/settings/settings-modal.js';
import { initTooltips } from './components/tooltip.js';
import { views } from './views/index.js';

theme.init(config.defaults.theme);
initTooltips();

// Prevent mouse clicks on buttons from retaining DOM focus that turns on
// a focus outline when modifier keys (like Shift or Win+Shift+S) are pressed.
document.addEventListener('click', (e) => {
  if (e.detail > 0) {
    const btn = e.target.closest('button, [role="button"], [role="menuitem"], [role="menuitemradio"]');
    if (btn && document.activeElement === btn) {
      btn.blur();
    }
  }
});

// Before anything mounts: the chat view announces itself the moment it opens.
initChatNav();

mountTitlebar(document.getElementById('titlebar'), { config });
mountSidebar(document.getElementById('sidebar'), { config });

const mainView = mountMainView(document.getElementById('main'), {
  views,
  defaultView: config.defaults.defaultView,
  ignoredViews: ['settings'],
});

mountSettingsModal({
  getReturnView: () => mainView.current(),
});
