/**
 * ============================================================================
 * CHAT SESSION (renderer/js/core/chat-session.js)
 * ============================================================================
 * Owns the persistence of ONE conversation, so the chat view only has to say
 * "the user sent this" and "the assistant answered that".
 *
 *   - Creates the chat on the agent when the first message is sent (an
 *     untouched "New chat" never reaches the history).
 *   - Uploads the files the user attached, so the chat can show them again.
 *   - Appends messages in the order they were recorded.
 *   - Asks for an AI-written title after the first message.
 *   - Announces changes on the bus ('chat:updated'), which the sidebar
 *     listens to.
 *
 * Persistence is best effort. A failed save is reported (console + a
 * 'chat:persist-error' event) but never blocks or breaks the live chat.
 *
 * This module touches no DOM, so it is covered by plain unit tests.
 * ============================================================================
 */
import { bus as defaultBus } from './events.js';
import { historyClient, makeChatId } from '../ai/history-client.js';

/** Same ceiling as the agent (CHAT_LIMITS.maxFileBytes). Larger files are not kept. */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024;

export class ChatSession {
  #client;
  #bus;
  #tail = Promise.resolve();
  #created = false;
  #titleRequested = false;
  #started = false;
  #meta = null;

  /**
   * @param {object} [options]
   * @param {string} [options.id]        an existing chat id to continue; omit for a new chat
   * @param {object} [options.client]    history client (injectable for tests)
   * @param {object} [options.bus]       event bus (injectable for tests)
   */
  constructor({ id, client = historyClient, bus = defaultBus } = {}) {
    this.id = id || makeChatId();
    this.isExisting = Boolean(id);
    this.#client = client;
    this.#bus = bus;

    if (this.isExisting) {
      // Already on disk with a title: never ask for another one.
      this.#created = true;
      this.#titleRequested = true;
      this.#started = true;
    }
  }

  /** True once the user has sent (or restored) at least one message. Set synchronously. */
  get started() { return this.#started; }

  get meta() { return this.#meta; }

  /** Load a saved chat: { meta, messages }. */
  async load({ signal } = {}) {
    const chat = await this.#client.getChat(this.id, { signal });
    this.#meta = chat.meta;
    return chat;
  }

  /**
   * Save a user turn.
   * @param {object} turn
   * @param {string} turn.text      what the user typed (shown in the bubble)
   * @param {string} turn.content   what was sent to the model (text + file block)
   * @param {File[]} [turn.files]   the attachments, uploaded so they can be shown again
   * @param {string[]} [turn.notes] "could not read / not indexed" notes
   * @param {string|null} [turn.modelId]
   * @param {boolean} [turn.ragIndexed]
   */
  recordUser({ text = '', content, files = [], notes = [], modelId = null, ragIndexed = false }) {
    this.#started = true;

    const attachments = Array.from(files || []);

    return this.#enqueue(async () => {
      await this.#ensureCreated();
      const refs = await this.#uploadAll(attachments);

      const record = { role: 'user', text, content, files: refs, notes, modelId, createdAt: Date.now() };
      const meta = await this.#client.appendMessages(this.id, { messages: [record], ragIndexed });
      this.#meta = meta;
      this.#bus.emit('chat:updated', { chat: meta });

      if (!this.#titleRequested) {
        this.#titleRequested = true;
        // Deliberately not awaited: the title must never delay the next save.
        this.#generateTitle({ text, fileNames: refs.map((file) => file.name), modelId });
      }
      return record;
    });
  }

  /**
   * Save an assistant turn.
   * @param {object} turn
   * @param {string} turn.content
   * @param {object|null} [turn.sources]   the retrieval info shown under the answer
   * @param {boolean} [turn.interrupted]   the user left before it finished
   * @param {boolean} [turn.ragIndexed]
   */
  recordAssistant({ content, sources = null, interrupted = false, modelId = null, ragIndexed = false }) {
    return this.#enqueue(async () => {
      await this.#ensureCreated();
      const record = { role: 'assistant', content, sources, interrupted, modelId, createdAt: Date.now() };

      const meta = await this.#client.appendMessages(this.id, { messages: [record], ragIndexed });
      this.#meta = meta;
      this.#bus.emit('chat:updated', { chat: meta });
      return record;
    });
  }

  /** Remember that this chat has a knowledge-base index (call when it appears late). */
  markIndexed() {
    if (!this.#started) return Promise.resolve(null);
    return this.#enqueue(async () => {
      await this.#ensureCreated();
      return this.#client.updateChat(this.id, { ragIndexed: true });
    });
  }

  /** Resolves when every queued save has finished. For tests and shutdown. */
  flush() {
    return this.#tail;
  }

  /* ------------------------------------------------------------------ */

  /** Run saves one at a time, in the order they were requested. Never rejects. */
  #enqueue(task) {
    const run = this.#tail.then(task);
    this.#tail = run.then(() => undefined, () => undefined);
    return run.catch((error) => {
      console.warn('[history] could not save the chat:', error?.message || error);
      this.#bus.emit('chat:persist-error', { chatId: this.id, message: error?.message || String(error) });
      return null;
    });
  }

  async #ensureCreated() {
    if (this.#created) return;
    await this.#client.createChat(this.id);
    this.#created = true;
  }

  async #uploadAll(files) {
    return Promise.all(files.map(async (file) => {
      const ref = {
        name: file.name || 'file',
        path: file.webkitRelativePath || file.name || 'file',
        size: file.size || 0,
        type: file.type || 'application/octet-stream',
      };
      if (!file.size || file.size > MAX_STORED_FILE_BYTES) return ref; // shown, but not kept

      try {
        const stored = await this.#client.uploadChatFile(this.id, file);
        return { ...ref, id: stored.id };
      } catch (error) {
        console.warn(`[history] could not keep ${ref.name}:`, error?.message || error);
        return ref;
      }
    }));
  }

  async #generateTitle({ text, fileNames, modelId }) {
    try {
      const result = await this.#client.requestTitle(this.id, { query: text, fileNames, modelId });
      if (result?.applied && result.chat) {
        this.#meta = result.chat;
        this.#bus.emit('chat:updated', { chat: result.chat, titleChanged: true });
      }
    } catch (error) {
      // The automatic title from the first message is already showing.
      console.warn('[history] title generation failed:', error?.message || error);
    }
  }
}
