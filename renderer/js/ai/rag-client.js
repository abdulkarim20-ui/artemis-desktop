/**
 * ============================================================================
 * RAG CLIENT (renderer/js/ai/rag-client.js)
 * ============================================================================
 * Renderer-side wrapper around the agent's /api/rag/* routes.
 *
 * Everything here is optional and non-fatal. A chat that worked before the
 * knowledge base existed has to keep working when there is no NVIDIA_API_KEY,
 * when the embedding endpoint is rate limited, or when a file cannot be
 * indexed. Callers get a structured result and a sentence to show the user,
 * never an exception that cancels the message.
 *
 * PRIVACY: indexing a file sends its text chunks to NVIDIA's hosted endpoint.
 * Conversion and chunking are local; embedding is not. getRagStatus() reports
 * `hosted: true` so the UI can say this before the first file is indexed.
 * ============================================================================
 */

import { DEFAULT_AI_BASE_URL } from './ai-client.js';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_MB, DOCUMENT_EXT } from '../../../shared/document-formats.js';
import { BINARY_EXT, extOf } from '../../../shared/language-map.js';

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

/**
 * A knowledge-base request that failed.
 * `code` mirrors the agent's own codes so the UI can react to "not configured"
 * differently from "the endpoint is down".
 */
export class RagClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RagClientError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Codes that mean "retrieval is not available at all" rather than "this one
 * request failed". Callers should stop trying for the rest of the session.
 */
export const RAG_UNAVAILABLE_CODES = new Set([
  'noApiKey',
  'disabled',
  'badRegistry',
  'parserUnavailable',
]);

async function readError(response) {
  try {
    const text = await response.text();
    if (!text) return { code: `http${response.status}`, message: `HTTP ${response.status}` };
    try {
      const json = JSON.parse(text);
      return {
        code: json.code || `http${response.status}`,
        message: json.message || json.error || `HTTP ${response.status}`,
      };
    } catch {
      return { code: `http${response.status}`, message: text.slice(0, 300) };
    }
  } catch {
    return { code: `http${response.status}`, message: `HTTP ${response.status}` };
  }
}

async function requestJson(baseUrl, path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new RagClientError('network', `could not reach the AI agent (${error?.message || 'network error'})`);
  }

  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new RagClientError(code, message, { status: response.status });
  }

  return response.json();
}

/* ------------------------------------------------------------------ */
/* collection identity                                                 */
/* ------------------------------------------------------------------ */

/**
 * A collection id for one conversation.
 *
 * The renderer keeps no conversation id of its own - the chat view's history
 * lives for as long as the view is mounted - so the id is minted per mount and
 * the collection is deleted on unmount. Without that cleanup, orphaned indexes
 * would accumulate in userData with no UI to remove them.
 */
export function makeCollectionId(prefix = 'conv') {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/**
 * Which attachments are worth indexing.
 *
 * The agent skips images and binaries on its own, but skipping them here means
 * their bytes are never uploaded in the first place. A 20 MB screenshot that is
 * rejected server-side is still a 20 MB upload on a free-tier connection.
 *
 * Documents are checked before binaries: a .docx and a .pdf are both binary on
 * the inside, and only they have a parser. The same ordering is used by
 * buildFileContext(), so the two never disagree about what a file is.
 *
 * Anything not recognised is passed through. An extension-less text file is
 * indexable, and the agent's own classifier is better placed to decide that than
 * a second, stricter guess here.
 *
 * @param {Array<File>} attachments
 * @returns {Array<File>}
 */
export function indexableFiles(attachments) {
  const out = [];

  for (const file of Array.from(attachments || [])) {
    const ext = extOf(file?.webkitRelativePath || file?.name || '');
    if (DOCUMENT_EXT.has(ext)) { out.push(file); continue; }
    if (BINARY_EXT.has(ext)) continue;
    if (String(file?.type || '').startsWith('image/')) continue;
    out.push(file);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* status and management                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{ baseUrl?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ enabled: boolean, configured: boolean, model: string|null,
 *   dims: number|null, hosted: boolean, reason: string|null, storageRoot: string }>}
 */
export async function getRagStatus(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const result = await requestJson(baseUrl, '/api/rag/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  return result;
}

export async function listCollections(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const result = await requestJson(baseUrl, '/api/rag/collections', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  return result.collections || [];
}

export async function getCollection(collection, options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const result = await requestJson(
    baseUrl,
    `/api/rag/collections/${encodeURIComponent(collection)}`,
    { method: 'GET', headers: { Accept: 'application/json' }, signal: options.signal }
  );
  return result.collection;
}

export async function deleteCollection(collection, options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  await requestJson(baseUrl, `/api/rag/collections/${encodeURIComponent(collection)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  return { ok: true };
}

export async function deleteDocument({ collection, path, baseUrl, signal }) {
  const base = trimTrailingSlash(baseUrl || DEFAULT_AI_BASE_URL);
  const query = new URLSearchParams({ collection: String(collection), path: String(path) });
  return requestJson(base, `/api/rag/documents?${query}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    signal,
  });
}

/* ------------------------------------------------------------------ */
/* indexing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Index one file.
 *
 * The route takes raw bytes with `express.raw({ type: 'application/octet-stream' })`.
 * Any other content type leaves req.body as an empty object on the server, which
 * arrives back as "the file is empty" - a confusing answer to a correct request.
 * So the content type here is not cosmetic.
 *
 * @returns {Promise<object>} the agent's per-file result. A file that cannot be
 *   indexed resolves with `status: 'skipped'` and a `skippedReason` rather than
 *   rejecting, because in a batch of attachments that is an expected outcome.
 */
export async function ingestFile({ collection, file, bytes, name, baseUrl, signal }) {
  const base = trimTrailingSlash(baseUrl || DEFAULT_AI_BASE_URL);
  const fileName = String(name || file?.name || 'file');

  let payload = bytes;
  if (!payload) {
    if (!file) throw new RagClientError('badRequest', 'ingestFile needs a File or raw bytes');
    payload = new Uint8Array(await file.arrayBuffer());
  }

  if (!payload.byteLength) {
    return { status: 'skipped', path: fileName, chunks: 0, code: 'empty', skippedReason: 'the file is empty' };
  }

  // Pre-check against the converter's own cap so the user gets a real sentence
  // instead of a bare 413 from the body parser.
  if (payload.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      status: 'skipped',
      path: fileName,
      chunks: 0,
      code: 'tooLarge',
      skippedReason: `${fileName} is ${(payload.byteLength / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_DOCUMENT_MB} MB limit`,
    };
  }

  const query = new URLSearchParams({ name: fileName, collection: String(collection) });
  const result = await requestJson(base, `/api/rag/documents?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
    body: payload,
    signal,
  });

  return result;
}

/**
 * How many files upload at once.
 *
 * Files that attach together index together: with five attachments a
 * sequential loop pays five full round trips before the send path can
 * unblock. Three keeps the pipeline busy without piling onto the hosted
 * embedding endpoint - each upload already runs `maxConcurrentBatches`
 * embedding requests server-side, so 3 files x 3 batches is the real ceiling.
 */
const INGEST_CONCURRENCY = 3;

/**
 * Index a batch of files, a few at a time (see INGEST_CONCURRENCY).
 *
 * A worker pool rather than Promise.all over the whole batch: only
 * INGEST_CONCURRENCY uploads are ever in flight, and a finished slot picks up
 * the next file. The per-file embedding batches inside each upload are still
 * throttled by the agent, so this multiplies the request rate by a bounded,
 * small factor instead of one-per-file.
 *
 * Never rejects for a per-file problem - each file gets its own result object.
 * Only a whole-subsystem failure (no API key, agent down) throws, and callers
 * are expected to catch it and carry on without retrieval. When that happens
 * no NEW upload is started; the ones already in flight are left to finish or
 * fail on their own.
 *
 * @param {object} params
 * @param {string} params.collection
 * @param {Array<File|{name: string, bytes: Uint8Array}>} params.files
 * @param {(done: number, total: number, result: object) => void} [params.onProgress]
 * @param {number} [params.maxConcurrent] files uploading at once (default INGEST_CONCURRENCY)
 * @returns {Promise<{ results: Array<object>, indexed: number, unchanged: number, skipped: number, chunks: number }>}
 */
export async function ingestFiles({ collection, files, baseUrl, signal, onProgress, maxConcurrent }) {
  const all = Array.from(files || []);
  // Assigned by index so `results` stays in input order even though uploads
  // complete out of order.
  const results = new Array(all.length);
  let indexed = 0;
  let unchanged = 0;
  let skipped = 0;
  let chunks = 0;
  let done = 0;
  let nextIndex = 0;

  // Set by the first unavailable-code failure. Workers stop claiming new
  // files once it is set: the rest would fail identically, and nine identical
  // "no API key" notes would bury the one that matters.
  let fatal = false;

  /** Upload one entry. Resolves null (not a result) when the signal aborted. */
  const runOne = async (entry) => {
    if (signal?.aborted) return null;

    const isFile = typeof entry?.arrayBuffer === 'function';

    try {
      return await ingestFile({
        collection,
        baseUrl,
        signal,
        file: isFile ? entry : null,
        bytes: isFile ? null : entry?.bytes,
        name: isFile ? entry.name : entry?.name,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;

      // A subsystem-level failure means the rest will fail the same way. Stop
      // the batch and let the caller decide.
      if (RAG_UNAVAILABLE_CODES.has(error.code)) {
        fatal = true;
        throw error;
      }

      return {
        status: 'skipped',
        path: isFile ? entry.name : entry?.name,
        chunks: 0,
        code: error.code || 'error',
        skippedReason: error.message,
      };
    }
  };

  const worker = async () => {
    while (!fatal && !signal?.aborted) {
      const index = nextIndex;
      if (index >= all.length) return;
      nextIndex += 1;

      let result;
      try {
        result = await runOne(all[index]);
      } catch (error) {
        // A caller abort can land while a claimed file is mid-upload. That is
        // the "stop the batch" case, not a failure: end this worker quietly
        // like the old sequential loop's break did. A spurious AbortError with
        // a live signal is still a real error and propagates.
        if (error?.name === 'AbortError' && signal?.aborted) return;
        throw error;
      }
      if (!result) continue; // the signal aborted before this upload started

      results[index] = result;
      done += 1;
      if (result.status === 'indexed') {
        indexed += 1;
        chunks += result.chunks || 0;
      } else if (result.status === 'unchanged') {
        unchanged += 1;
        chunks += result.chunks || 0;
      } else {
        skipped += 1;
      }

      onProgress?.(done, all.length, result);
    }
  };

  const workers = Math.min(Math.max(1, maxConcurrent || INGEST_CONCURRENCY), all.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  // `filter` drops the holes left by aborted-before-start files, so a
  // half-cancelled batch reports only the files that were really attempted.
  return { results: results.filter(Boolean), indexed, unchanged, skipped, chunks };
}

/**
 * Turn per-file results into notes for the user.
 *
 * Mirrors the file-context warnings: a file that could not be indexed has to be
 * visibly accounted for, otherwise the user sees a smaller knowledge base than
 * the files they attached and has no way to know why.
 *
 * Plain text, matching the `${path}: skipped, ${reason}` shape used by
 * buildFileContext(). ChatManager.showFileNotes() escapes its input and inserts
 * it as text, so markdown here would reach the user as literal asterisks.
 *
 * Only failures are reported. Successful indexing does not mean the answer
 * used a file; the source panel reports validated citations separately.
 *
 * @returns {string[]} one line per file that could not be indexed
 */
export function describeIngestResults(summary) {
  const notes = [];

  for (const result of summary?.results || []) {
    if (result.status !== 'skipped') continue;
    const path = result.path || result.name || 'attachment';
    notes.push(`${path}: not indexed, ${result.skippedReason || 'unknown reason'}`);
  }

  return notes;
}

/* ------------------------------------------------------------------ */
/* searching                                                           */
/* ------------------------------------------------------------------ */

/**
 * Search a collection without sending a chat message.
 * Used by the UI to show what the knowledge base actually holds.
 */
export async function queryCollection({ collection, query, topK, baseUrl, signal }) {
  const base = trimTrailingSlash(baseUrl || DEFAULT_AI_BASE_URL);
  return requestJson(base, '/api/rag/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ collection: String(collection), query: String(query), topK }),
    signal,
  });
}
