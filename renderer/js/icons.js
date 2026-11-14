// Icon markup only: the SVG artwork lives in the root assets/icons directory.
// and is painted with the current text color via the .icon mask rules.
const icon = (name) => `<span class="icon icon-${name}" aria-hidden="true"></span>`;

export const icons = {
  sidebar: icon('sidebar'),
  sidebarCollapsed: icon('sidebar-collapsed'),
  chat: icon('chat'),
  sun: icon('sun'),
  moon: icon('moon'),
  display: icon('display'),
  settings: icon('settings'),

  minimize: icon('minimize'),
  maximize: icon('maximize'),
  restore: icon('restore'),
  close: icon('close'),
  folder: icon('folder'),
  key: icon('key'),
};
