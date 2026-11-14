/**
 * ============================================================================
 * SIDEBAR STATE (renderer/js/core/sidebar-state.js)
 * ============================================================================
 * Remembers whether the user collapsed the sidebar.
 *
 * Only an EXPLICIT choice is stored, under its own key. The old code wrote the
 * build's default to storage on every launch, so a default of "collapsed" in an
 * earlier version was saved as if the user had chosen it, and the saved chats
 * (which are hidden while the sidebar is collapsed) stayed invisible after the
 * default changed. The old key is ignored on purpose: its value says what the
 * app defaulted to, not what the user wanted.
 * ============================================================================
 */

export const SIDEBAR_STATE_KEY = 'sidebar.expanded';

/**
 * @param {{ get(key: string, fallback?: any): any }} store
 * @param {boolean} fallback the default for a user who never toggled it
 * @returns {boolean}
 */
export function readSidebarExpanded(store, fallback) {
  const saved = store.get(SIDEBAR_STATE_KEY, null);
  return typeof saved === 'boolean' ? saved : Boolean(fallback);
}

/** Call only when the user toggles the sidebar, never at startup. */
export function saveSidebarExpanded(store, value) {
  store.set(SIDEBAR_STATE_KEY, Boolean(value));
}
