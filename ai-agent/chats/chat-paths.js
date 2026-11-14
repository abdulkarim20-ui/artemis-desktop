/**
 * ============================================================================
 * CHAT PATHS & IDS (chats/chat-paths.js)
 * ============================================================================
 * Where chat history lives on disk, and what a valid id looks like.
 *
 * Ids become directory names and double as RAG collection ids, so the rules
 * are strict and live in exactly one place.
 * ============================================================================
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(__dirname, "..");

/**
 * Where a STANDALONE agent run (`npm run agent` from the repository root,
 * without ARTEMIS_DATA_DIR)
 * keeps its chats. resolveChatsRoot() falls back to it, and chat-import.js
 * treats it as one of the other known folders an older history may sit in.
 */
export function standaloneChatsRoot() {
    return path.join(AGENT_DIR, ".data", "chats");
}

/**
 * Where chats are written.
 *
 * Mirrors resolveStorageRoot() in rag/config.js: the packaged app passes
 * ARTEMIS_DATA_DIR (Electron's userData folder, which survives updates);
 * running the agent standalone falls back to ai-agent/.data/chats.
 */
export function resolveChatsRoot() {
    const explicit = process.env.ARTEMIS_CHATS_DIR;
    if (explicit && explicit.trim()) return path.resolve(explicit.trim());

    const appData = process.env.ARTEMIS_DATA_DIR;
    if (appData && appData.trim()) return path.join(path.resolve(appData.trim()), "chats");

    return standaloneChatsRoot();
}

/**
 * A chat id.
 *
 * Starts and ends with a letter or digit ON PURPOSE: the same string is used
 * as the RAG collection id, and sanitizeCollectionId() trims leading and
 * trailing "-" characters. An id that began with "-" would map to a different
 * collection than the one the chat thinks it owns, and deleting the chat would
 * leave its index behind.
 */
export const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{4,78}[A-Za-z0-9]$/;

/** An id minted by ChatStore.saveFile(). */
export const FILE_ID_RE = /^f-[a-f0-9]{16}$/;
