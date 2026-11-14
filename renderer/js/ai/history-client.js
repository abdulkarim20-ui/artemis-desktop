/**
 * ============================================================================
 * HISTORY CLIENT (renderer/js/ai/history-client.js)
 * ============================================================================
 * Renderer-side wrapper around the agent's /api/chats routes. Same shape as
 * rag-client.js: plain functions, structured errors, AbortSignal support.
 *
 * The chat history itself lives on disk in the agent (Electron's userData
 * folder), NOT in localStorage: localStorage is capped at a few MB, and chats
 * carry attachments.
 * ============================================================================
 */
import { DEFAULT_AI_BASE_URL } from './ai-client.js';

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

export class HistoryClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HistoryClientError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * A new chat id. Also the chat's RAG collection id, so it must match what the
 * agent accepts (see CHAT_ID_RE in ai-agent/chats/chat-paths.js): letters,
 * digits, "-" and "_", starting and ending with a letter or digit.
 */
export function makeChatId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `chat-${Date.now().toString(36)}-${random}`;
}

async function readError(response) {
  try {
    const json = await response.json();
    return { code: json.code || `http${response.status}`, message: json.message || json.error || `HTTP ${response.status}` };
  } catch {
    return { code: `http${response.status}`, message: `HTTP ${response.status}` };
  }
}

async function request(path, { baseUrl, ...options } = {}, parse = 'json') {
  let response;
  try {
    response = await fetch(`${trimTrailingSlash(baseUrl || DEFAULT_AI_BASE_URL)}/api/chats${path}`, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new HistoryClientError('network', `could not reach the AI agent (${error?.message || 'network error'})`);
  }

  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new HistoryClientError(code, message, { status: response.status });
  }
  return parse === 'blob' ? response.blob() : response.json();
}

const jsonBody = (method, body, signal) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
  signal,
});

const enc = encodeURIComponent;

/** @returns {Promise<Array<object>>} chat metadata, newest activity first */
export async function listChats({ baseUrl, signal } = {}) {
  return (await request('', { baseUrl, signal })).chats;
}

/** @returns {Promise<{ meta: object, messages: object[] }>} */
export async function getChat(id, { baseUrl, signal } = {}) {
  return (await request(`/${enc(id)}`, { baseUrl, signal })).chat;
}

/** Idempotent: creating an existing chat returns it. @returns {Promise<object>} meta */
export async function createChat(id, { title, baseUrl, signal } = {}) {
  return (await request('', { baseUrl, ...jsonBody('POST', { id, title }, signal) })).chat;
}

/** @returns {Promise<object>} the updated meta */
export async function appendMessages(id, { messages, ragIndexed, baseUrl, signal }) {
  return (await request(`/${enc(id)}/messages`, { baseUrl, ...jsonBody('POST', { messages, ragIndexed }, signal) })).chat;
}

/** Rename and/or flag the chat as having an index. @returns {Promise<object>} meta */
export async function updateChat(id, { title, ragIndexed, baseUrl, signal } = {}) {
  const body = {};

  if (title !== undefined) body.title = title;
  if (ragIndexed !== undefined) body.ragIndexed = ragIndexed;
  return (await request(`/${enc(id)}`, { baseUrl, ...jsonBody('PATCH', body, signal) })).chat;
}

/** Deletes the chat, its files and its knowledge-base index. */
export async function deleteChat(id, { baseUrl, signal } = {}) {
  return request(`/${enc(id)}`, { baseUrl, method: 'DELETE', signal });
}

/** @returns {Promise<{ title: string, source: 'ai'|'fallback', applied: boolean, chat: object }>} */
export async function requestTitle(id, { query, fileNames, modelId, baseUrl, signal } = {}) {
  return request(`/${enc(id)}/title`, { baseUrl, ...jsonBody('POST', { query, fileNames, modelId }, signal) });
}

/** @returns {Promise<{ id: string, name: string, type: string, size: number }>} */
export async function uploadChatFile(id, file, { baseUrl, signal } = {}) {
  const type = file.type || 'application/octet-stream';
  const name = file.name || 'file';
  const result = await request(`/${enc(id)}/files?name=${enc(name)}&type=${enc(type)}`, {
    baseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal,
  });
  return result.file;
}

/** @returns {Promise<Blob>} */
export async function fetchChatFile(id, fileId, { baseUrl, signal } = {}) {
  return request(`/${enc(id)}/files/${enc(fileId)}`, { baseUrl, signal }, 'blob');
}

/** Everything bundled, so callers (and tests) can inject a fake. */
export const historyClient = {
  listChats,
  getChat,
  createChat,
  appendMessages,
  updateChat,
  deleteChat,
  requestTitle,
  uploadChatFile,
  fetchChatFile,
};
