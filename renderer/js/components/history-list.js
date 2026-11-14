/**
 * ============================================================================
 * HISTORY LIST (renderer/js/components/history-list.js)
 * ============================================================================
 * The saved-chats list under the New Chat button.
 *
 *   - grouped by recency (Today / Yesterday / Previous 7 days ...)
 *   - click to open; the open chat is highlighted
 *   - rename in place (pencil), delete with a two-step confirm (bin)
 *   - search box once the list is long enough to need one
 *   - new AI titles "type in" when they arrive
 *   - footer: how many conversations are stored, and the one folder they
 *     live in - a button opens it in the file manager
 *
 * Talks to the rest of the app only through the bus, and to the agent only
 * through the injected history client.
 * ============================================================================
 */
import { bus } from '../core/events.js';
import { groupChats, normalizeChatEntry, normalizeChatList } from '../core/history-groups.js';
import { historyClient } from '../ai/history-client.js';
import { waitForBackend } from '../ai/ai-client.js';

/** Show the search box only when scanning by eye stops being practical. */
const SEARCH_MIN_CHATS = 8;
const DELETE_CONFIRM_MS = 3000;
/** A window focus inside this many ms of the last load does not reload again. */
const WAKE_REFRESH_MS = 3000;
/** While the window sits open, quietly re-check the list this often. */
const REFRESH_MS = 30000;

const ICON_RENAME = '<span class="icon icon-edit" aria-hidden="true"></span>';
const ICON_DELETE = '<span class="icon icon-trash" aria-hidden="true"></span>';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLElement} root
 * @param {{ client?: object }} [options]
 * @returns {() => void} destroy
 */
export function mountHistoryList(root, { client = historyClient } = {}) {
  let chats = [];
  let status = 'loading'; // 'loading' | 'ready' | 'error'
  let activeId = null;
  let filter = '';
  let renaming = false;
  let dirty = false;
  let deleteError = false;
  let typeFor = null; // chat id whose title should type in on the next render
  let confirmTimer = null;
  let typeTimer = null;
  let disposed = false;
  let retryTimer = null;
  let retryAttempts = 0;
  let loadSeq = 0;      // only the newest load may write to the list
  let lastLoadAt = 0;
  let refreshTimer = null;
  let starting = false; // the agent is not reachable yet (cold start), not "broken"

  root.classList.add('history');

  /* ---------------------------------------------------------------- */
  /* rendering                                                          */
  /* ---------------------------------------------------------------- */
  const rowHtml = (chat) => {
    const title = escapeHtml(chat.title);
    return `
      <div class="history-row" data-id="${escapeHtml(chat.id)}"${chat.id === activeId ? ' aria-current="true"' : ''}>

        <button class="history-open" type="button" data-act="open" title="${title}">
          <span class="history-name">${title}</span>
        </button>
        <span class="history-tools">
          <button type="button" class="history-tool" data-act="rename" aria-label="Rename chat" title="Rename">${ICON_RENAME}</button>
          <button type="button" class="history-tool history-tool--delete" data-act="delete" aria-label="Delete chat" title="Delete">${ICON_DELETE}</button>
        </span>
      </div>`;
  };

  const bodyHtml = () => {
    if (status === 'loading') return '<p class="history-note">Loading chats…</p>';
    if (status === 'error') {
      if (starting) return '<p class="history-note">Starting the assistant…</p>';
      return '<p class="history-note">Chat history is unavailable.</p><button type="button" class="history-retry" data-act="retry">Try again</button>';
    }
    const deleteErrorHtml = deleteError
      ? '<p class="history-note history-error" role="alert">Could not delete the chat. Please try again.</p>'
      : '';
    if (!chats.length) return `${deleteErrorHtml}<p class="history-note">Your conversations will appear here.</p>`;

    const needle = filter.trim().toLowerCase();
    const visible = needle ? chats.filter((chat) => chat.title.toLowerCase().includes(needle)) : chats;
    if (!visible.length) return `${deleteErrorHtml}<p class="history-note">No chats match.</p>`;

    return `${deleteErrorHtml}${groupChats(visible).map((group) => `
      <section class="history-group">
        <h2 class="history-group-title">${group.label}</h2>
        ${group.items.map(rowHtml).join('')}
      </section>`).join('')}`;
  };

  const render = () => {
    if (disposed) return;
    // Never rebuild the DOM under a rename input; apply the change afterwards.
    if (renaming) { dirty = true; return; }

    const hadFocus = root.contains(document.activeElement) && document.activeElement?.classList.contains('history-search');
    const searchHtml = status === 'ready' && chats.length >= SEARCH_MIN_CHATS
      ? `<label class="history-search-wrap">
           <span class="icon icon-search" aria-hidden="true"></span>
           <input class="history-search" type="search" placeholder="Search chats" aria-label="Search chats" value="${escapeHtml(filter)}" />
         </label>`
      : '';
    const collapsedSearchHtml = status === 'ready' && chats.length >= SEARCH_MIN_CHATS
      ? `<button type="button" class="history-search-collapsed" data-act="expand-search" aria-label="Search chats"
           data-tooltip="Search chats" data-tooltip-side="right" data-tooltip-when="collapsed">
           <span class="icon icon-search" aria-hidden="true"></span>
         </button>`
      : '';

    root.innerHTML = `${searchHtml}${collapsedSearchHtml}<div class="history-scroll">${bodyHtml()}</div>`;

    if (hadFocus) {
      const input = root.querySelector('.history-search');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }

    if (typeFor) {
      const id = typeFor;
      typeFor = null;
      typeIn(id);
    }
  };

  /** Reveal a new title character by character. Text only: never HTML. */
  const typeIn = (id) => {
    if (reducedMotion()) return;
    const name = root.querySelector(`.history-row[data-id="${CSS.escape(id)}"] .history-name`);
    if (!name) return;

    const full = name.textContent;
    let shown = 0;
    clearInterval(typeTimer);
    name.textContent = '';
    typeTimer = setInterval(() => {
      shown += 1;
      name.textContent = full.slice(0, shown);
      if (shown >= full.length) clearInterval(typeTimer);
    }, 22);
  };

  /* ---------------------------------------------------------------- */
  /* data                                                               */
  /* ---------------------------------------------------------------- */
  const sortChats = (list = chats) => list.sort((a, b) => b.updatedAt - a.updatedAt);

  /**
   * The list loads once at startup, which races the agent's own boot: a slow
   * cold start (antivirus scanning the bundle) or the previous session's
   * agent still shutting down can both make this first attempt fail. A failed
   * load must not be final - older chats would look deleted until somebody
   * clicked "Try again". Retry indefinitely with capped backoff.
   */
  const clearRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    clearRetry();
    retryAttempts += 1;
    const delay = Math.min(1500 * retryAttempts, 5000);
    retryTimer = setTimeout(load, delay);
  };

  const load = async () => {
    clearRetry();
    const seq = ++loadSeq;
    lastLoadAt = Date.now();

    // A list that is already on screen stays there while it refreshes: no
    // flash of "Loading chats..." and no blank panel if the refresh fails.
    if (status !== 'ready') {
      status = 'loading';
      render();
    }

    try {
      const up = await waitForBackend({ attempts: 20 });
      if (!up) {
        const notUp = new Error('the AI agent is not reachable yet');
        notUp.code = 'network';
        throw notUp;
      }
      const list = normalizeChatList(await client.listChats());
      if (seq !== loadSeq || disposed) return; // a newer load owns the list now

      chats = sortChats(list);
      status = 'ready';
      starting = false;
      retryAttempts = 0;
    } catch (error) {
      if (seq !== loadSeq || disposed) return;
      console.warn('[history] could not load chats:', error?.message || error);

      // Keep showing what we already have; only a panel that never loaded
      // turns into the error state and starts retrying.
      if (status !== 'ready') {
        status = 'error';
        starting = error?.code === 'network';
        scheduleRetry();
      }
    }
    render();
  };

  const upsert = (chat, { titleChanged = false } = {}) => {
    /*
     * Never let one new chat mask a failed list load. Flipping the status to
     * 'ready' here would render a sidebar with only the current conversation
     * on it, and every older chat would look deleted until a full reload.
     */
    if (status !== 'ready') return;

    const next = normalizeChatEntry(chat);
    if (!next) return;

    const index = chats.findIndex((entry) => entry.id === next.id);
    if (index === -1) chats.push(next); else chats[index] = next;
    sortChats();
    if (titleChanged) typeFor = next.id;

    render();
  };

  /* ---------------------------------------------------------------- */
  /* actions                                                            */
  /* ---------------------------------------------------------------- */
  const resetDeleteConfirm = () => {
    clearTimeout(confirmTimer);
    root.querySelectorAll('.history-row[data-confirm]').forEach((row) => {
      row.removeAttribute('data-confirm');
      const bin = row.querySelector('.history-tool--delete');
      if (bin) { bin.innerHTML = ICON_DELETE; bin.setAttribute('aria-label', 'Delete chat'); }
    });
  };

  const askToDelete = (row) => {
    resetDeleteConfirm();
    row.dataset.confirm = 'true';
    const bin = row.querySelector('.history-tool--delete');
    bin.textContent = 'Delete?';
    bin.setAttribute('aria-label', 'Confirm delete');
    confirmTimer = setTimeout(resetDeleteConfirm, DELETE_CONFIRM_MS);
  };

  const remove = async (id) => {
    resetDeleteConfirm();
    deleteError = false;
    const before = chats;
    chats = chats.filter((chat) => chat.id !== id);
    render();
    try {
      await client.deleteChat(id);
    } catch (error) {
      console.warn('[history] delete failed:', error?.message || error);
      chats = before; // the chat is still on disk: show it again
      deleteError = true;
      render();
      return;
    }

    bus.emit('chat:deleted', { id });
  };

  const startRename = (row) => {
    const id = row.dataset.id;
    const chat = chats.find((entry) => entry.id === id);
    const open = row.querySelector('.history-open');
    if (!chat || !open) return;

    renaming = true;
    resetDeleteConfirm();
    row.classList.add('is-renaming');

    const input = document.createElement('input');
    input.className = 'history-rename';
    input.type = 'text';
    input.value = chat.title;
    input.maxLength = 60;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Chat title');
    open.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      renaming = false;
      row.classList.remove('is-renaming');

      const next = input.value.trim();

      if (save && next && next !== chat.title) {
        try {
          upsert(await client.updateChat(id, { title: next }));
          return;
        } catch (error) {
          console.warn('[history] rename failed:', error?.message || error);
        }
      }
      dirty = false;
      render();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  };

  /* ---------------------------------------------------------------- */
  /* events                                                             */
  /* ---------------------------------------------------------------- */
  const onClick = (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const row = button.closest('.history-row');
    const id = row?.dataset.id;

    switch (button.dataset.act) {
      case 'open': bus.emit('chat:open', { chatId: id }); break;
      case 'rename': startRename(row); break;

      case 'delete':
        if (row.dataset.confirm === 'true') remove(id); else askToDelete(row);
        break;
      case 'expand-search':
        bus.emit('sidebar:toggle');
        requestAnimationFrame(() => root.querySelector('.history-search')?.focus());
        break;
      case 'retry': load(); break;
      default: break;
    }
  };

  const onInput = (event) => {
    if (!event.target.classList.contains('history-search')) return;
    filter = event.target.value;
    render();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);

  const offs = [
    bus.on('chat:updated', ({ chat, titleChanged }) => {
      // A save succeeded, so the agent is clearly reachable again: reload the
      // whole list rather than pinning one chat onto a broken panel.
      if (status === 'error') { load(); return; }
      upsert(chat, { titleChanged });
    }),
    bus.on('chat:deleted', ({ id }) => {
      if (chats.some((chat) => chat.id === id)) { chats = chats.filter((chat) => chat.id !== id); render(); }
    }),
    bus.on('chat:active', ({ chatId }) => {
      activeId = chatId;
      if (status === 'error') { load(); return; }
      render();
    }),
    bus.on('history:refresh', () => load()),
  ];

  /*
   * Coming back to the window is a good moment to be sure the list is right:
   * a panel stuck in the error state gets a fresh start (the retry budget is
   * reset), and a healthy one is refreshed quietly. Both cover an agent that
   * restarted, or chats written by another window, while this one sat idle.
   */
  const onWake = () => {
    if (disposed || document.visibilityState === 'hidden') return;
    if (status === 'loading') return;

    if (status === 'error') {
      retryAttempts = 0;
      load();
    } else if (Date.now() - lastLoadAt > WAKE_REFRESH_MS) {
      load();
    }
  };
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onWake);

  /*
   * A quiet refresh while the window sits open: an agent that was replaced on
   * the port, or chats written by another window, show up without the user
   * having to refocus or restart. Skipped while a load is in flight, and while
   * the error state owns the panel (its own retry loop is already running).
   */
  refreshTimer = setInterval(() => {
    if (disposed || status === 'loading' || status === 'error') return;
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastLoadAt >= REFRESH_MS) load();
  }, REFRESH_MS);

  load();

  return () => {
    disposed = true;
    offs.forEach((off) => off());
    root.removeEventListener('click', onClick);

    root.removeEventListener('input', onInput);
    window.removeEventListener('focus', onWake);
    document.removeEventListener('visibilitychange', onWake);
    clearTimeout(confirmTimer);
    clearInterval(typeTimer);
    clearInterval(refreshTimer);
    clearRetry();
    root.replaceChildren();
  };
}
