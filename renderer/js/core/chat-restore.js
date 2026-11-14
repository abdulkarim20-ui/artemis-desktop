/**
 * ============================================================================
 * CHAT RESTORE (renderer/js/core/chat-restore.js)
 * ============================================================================
 * Turns a saved chat back into (a) the model-facing `history` array the chat
 * view keeps, and (b) the messages on screen.
 *
 * buildHistory() is pure and unit tested. renderSavedChat() drives ChatManager
 * and is browser-only.
 * ============================================================================
 */
import { compactHistoryFileBlocks } from '../ai/file-context.js';
import { prepareImages } from '../ai/image-pipeline.js';
import { historyClient } from '../ai/history-client.js';
import { isImageFile } from '../../../shared/image-formats.js';

/**
 * The array streamChat() sends to the model.
 *
 * The newest file blocks are kept in full and older ones are replaced with the
 * same honest stub a live chat would have produced - compactHistoryFileBlocks()
 * is the function the live chat already uses, so a reopened conversation
 * behaves like one that was never closed.
 *
 * @param {Array<{ role: string, content: string }>} messages saved messages
 * @param {{ ragIndexed?: boolean }} [meta]
 */
export function buildHistory(messages, meta = {}) {
  const history = (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => {
      const entry = { role: m.role, content: m.content };
      const refs = m.role === 'user'
        ? (m.files || []).filter((f) => f.id && isImageFile({ name: f.name, type: f.type }))
        : [];
      if (refs.length) {
        Object.defineProperty(entry, '_imageRefs', { value: refs, enumerable: false, configurable: true });
      }
      return entry;
    });

  compactHistoryFileBlocks(history, { indexed: Boolean(meta?.ragIndexed) });
  return history;
}

const isImage = (type) => String(type || '').startsWith('image/');

/**
 * Rebuild File objects for a saved message.
 *
 * ChatManager.addUserMessage() renders from File objects. Images need their
 * real bytes (it makes an object URL for the thumbnail), so they are fetched
 * back from the agent. Documents are shown as name pills, so an empty File
 * with the right name and type is enough and costs no download.
 */
export async function hydrateFiles(chatId, files, { client = historyClient } = {}) {
  return Promise.all((files || []).map(async (ref) => {
    const type = ref.type || 'application/octet-stream';

    if (ref.id && isImage(type)) {
      try {
        const blob = await client.fetchChatFile(chatId, ref.id);
        return new File([blob], ref.name, { type });
      } catch {
        /* fall through to the placeholder: the name still shows */
      }
    }
    return new File([], ref.name, { type });
  }));
}

/**
 * Re-attach bytes for the newest saved images so a reopened chat can keep
 * talking about them. Newest first; stops at `maxImages`. Never throws.
 */
export async function restoreHistoryImages(history, {
  chatId,
  client = historyClient,
  maxImages = 3,
  prepare = prepareImages,
} = {}) {
  let budget = maxImages;
  for (let i = history.length - 1; i >= 0 && budget > 0; i -= 1) {
    const refs = history[i]._imageRefs;
    if (!refs?.length) continue;
    const files = await hydrateFiles(chatId, refs.slice(-budget), { client });
    const { images } = await prepare(files.filter((file) => file.size > 0), { maxImages: budget });
    if (images.length) {
      history[i].images = images;
      budget -= images.length;
    }
  }
}

/**
 * Draw saved messages into the chat. Nothing is streamed or animated.
 *
 * @param {object} options
 * @param {ChatManager} options.chatManager
 * @param {string} options.chatId
 * @param {Array<object>} options.messages
 */
export async function renderSavedChat({ chatManager, chatId, messages, client = historyClient }) {
  for (const message of messages) {
    if (message.role === 'user') {
      const attachments = await hydrateFiles(chatId, message.files, { client });
      const { row } = chatManager.addUserMessage({
        text: message.text || '',
        attachments,
        createdAt: message.createdAt,
      });
      chatManager.showFileNotes(row, message.notes);
    } else if (message.role === 'assistant') {
      const controller = chatManager.initiateEmptyAssistantResponse();
      // Saved chats carry the real timestamp; the fallback covers rows saved
      // before messages recorded one.
      controller.createdAt = message.createdAt || Date.now();
      controller.accumulatedText = message.interrupted

        ? `${message.content}\n\n*This response was interrupted.*`
        : message.content;
      chatManager.finalizeResponse(controller);
      if (message.sources) chatManager.showSources(controller, message.sources);
    }
  }

  chatManager.scrollToBottom(false);
}
