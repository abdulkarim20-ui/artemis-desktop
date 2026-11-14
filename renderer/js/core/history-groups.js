/**
 * Groups chats by recency for the sidebar. Pure function, local-time days.
 */
const DAY = 24 * 60 * 60 * 1000;

export const GROUPS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Previous 7 days' },
  { key: 'month', label: 'Previous 30 days' },
  { key: 'older', label: 'Older' },
];

function groupKey(updatedAt, startOfToday) {
  if (updatedAt >= startOfToday) return 'today';
  if (updatedAt >= startOfToday - DAY) return 'yesterday';
  if (updatedAt >= startOfToday - 7 * DAY) return 'week';
  if (updatedAt >= startOfToday - 30 * DAY) return 'month';
  return 'older';
}

/**
 * @param {Array<{ updatedAt: number }>} chats
 * @param {Date} [now]
 * @returns {Array<{ key: string, label: string, items: Array<object> }>} only non-empty groups,
 *   each sorted newest first
 */
export function groupChats(chats, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = new Map(GROUPS.map((group) => [group.key, []]));

  for (const chat of chats) {
    buckets.get(groupKey(chat.updatedAt, startOfToday)).push(chat);
  }

  return GROUPS
    .map((group) => ({
      ...group,
      items: buckets.get(group.key).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * A chat entry from the agent, made safe to sort, group, search and render.
 * Returns null for anything that cannot be shown (no id), so one bad record
 * can never blank the whole sidebar.
 *
 * @param {object} chat
 * @returns {object|null}
 */
export function normalizeChatEntry(chat) {
  if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !chat.id) return null;

  const updatedAt = Number(chat.updatedAt);
  return {
    ...chat,
    title: typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'New chat',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

/** @returns {Array<object>} the entries that can be shown */
export function normalizeChatList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeChatEntry).filter(Boolean);
}
