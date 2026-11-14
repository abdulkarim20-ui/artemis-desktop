import { mountChatView } from './chat.js';

// Register views by the nav id used in config.js.
// "settings" is intentionally not listed: it opens the settings modal instead
// of replacing the current view.
export const views = {
  chat: mountChatView,
};
