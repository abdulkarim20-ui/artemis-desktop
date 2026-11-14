const brandLogo = '<img class="brand-logo" src="../assets/brand/app_logo.svg" width="16" height="16" alt="" aria-hidden="true">';

// One place to change the brand, sidebar items and defaults.
export const config = {
  brand: {
    name: 'artemis',
    logo: brandLogo,
  },
  sidebar: {
    items: [
      { id: 'chat', label: 'New Chat', icon: 'chat', action: 'chat:new' },
    ],
    footer: [
      { id: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
  defaults: {
    theme: 'dark',
    sidebarExpanded: true,
    defaultView: 'chat',
  },
};
