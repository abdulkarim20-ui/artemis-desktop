/**
 * ============================================================================
 * CHAT NAV (renderer/js/core/chat-nav.js)
 * ============================================================================
 * The one place that decides what "New Chat", "open this chat" and "that chat
 * was deleted" mean. Components never call each other; they emit:
 *
 *   chat:new            the New Chat button was pressed
 *   chat:open           { chatId }  a history entry was clicked
 *   chat:deleted        { id }      a history entry was deleted
 *   chat:active         { chatId, isEmpty }  reported BY the chat view
 *
 * and this module turns them into a single 'nav:select' for the main view.
 * ============================================================================
 */
import { bus as defaultBus } from './events.js';

export function initChatNav({ bus = defaultBus } = {}) {
  // What the chat view currently shows. Starts as the untouched first chat.
  let active = { chatId: null, isEmpty: true };

  const show = (params) => bus.emit('nav:select', { id: 'chat', params });

  const offs = [
    bus.on('chat:active', (next) => { active = next; }),
    bus.on('chat:new', () => {
      // Already on a blank chat: nothing to throw away. Just put the cursor back.
      if (active.isEmpty) {
        bus.emit('chat:focus-input');
        return;
      }
      // nonce: a fresh key every time, so the main view remounts even though
      // the view id ("chat") has not changed.
      show({ chatId: null, nonce: Date.now() });
    }),
    bus.on('chat:open', ({ chatId }) => {
      if (!chatId || chatId === active.chatId) return;

      show({ chatId });
    }),
    bus.on('chat:deleted', ({ id }) => {
      if (id === active.chatId) show({ chatId: null, nonce: Date.now() });
    }),
  ];

  return () => offs.forEach((off) => off());
}
