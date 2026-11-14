import { icons } from '../icons.js';
import { bus } from '../core/events.js';

export function mountTitlebar(root, { config }) {
  root.innerHTML = `
    <div class="titlebar-group titlebar-left">
      <div class="titlebar-brand">
        ${config.brand.logo}
        <span class="titlebar-brand-name">${config.brand.name}</span>
      </div>
      <button class="icon-btn titlebar-sidebar-toggle" data-action="toggle-sidebar" aria-expanded="true" aria-label="Collapse sidebar" data-tooltip="Collapse sidebar" data-tooltip-side="bottom">
        ${icons.sidebar}
        ${icons.sidebarCollapsed}
      </button>
    </div>
    <div class="titlebar-group">
      <div class="win-controls">
        <button class="win-btn" data-action="minimize" aria-label="Minimize" data-tooltip="Minimize" data-tooltip-side="bottom">${icons.minimize}</button>
        <button class="win-btn" data-action="maximize" aria-label="Maximize"></button>
        <button class="win-btn close" data-action="close" aria-label="Close" data-tooltip="Close" data-tooltip-side="bottom">${icons.close}</button>
      </div>
    </div>`;

  const maxBtn = root.querySelector('[data-action="maximize"]');
  const sidebarToggle = root.querySelector('[data-action="toggle-sidebar"]');

  const applyExpanded = (expanded) => {
    const label = expanded ? 'Collapse sidebar' : 'Expand sidebar';
    sidebarToggle.setAttribute('aria-expanded', String(expanded));
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.dataset.tooltip = label;
  };
  bus.on('sidebar:expanded', ({ expanded }) => applyExpanded(expanded));

  // order-independent: read the sidebar's current state if it already exists
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl?.dataset.expanded) applyExpanded(sidebarEl.dataset.expanded === 'true');

  const renderMax = (isMax) => {
    const label = isMax ? 'Restore' : 'Maximize';
    maxBtn.innerHTML = isMax ? icons.restore : icons.maximize;
    maxBtn.setAttribute('aria-label', label);
    maxBtn.dataset.tooltip = label;
    maxBtn.dataset.tooltipSide = 'bottom';
  };

  let stateKnown = false;
  renderMax(false);
  window.shell.onMaximizedChange((isMax) => {
    stateKnown = true;
    renderMax(isMax);
  });
  window.shell.isMaximized().then((isMax) => {
    if (!stateKnown) renderMax(isMax);
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'toggle-sidebar': bus.emit('sidebar:toggle'); break;
      case 'minimize':       window.shell.minimize(); break;
      case 'maximize':       window.shell.toggleMaximize(); break;
      case 'close':          window.shell.close(); break;
    }
  });
}
