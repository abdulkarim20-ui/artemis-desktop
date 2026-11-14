/**
 * ============================================================================
 * DOCUMENT FORMATS (shared/document-formats.js)
 * ============================================================================
 * Single source of truth for what Artemis can convert and how much of it it
 * will accept. Imported by BOTH sides of the app:
 *
 *   - ai-agent  (runtime/document-parser.js, server.js) - enforces the limits
 *   - renderer  (js/ai/file-context.js)                 - respects them before sending
 *
 * Keeping one copy matters: a renderer that sends a bigger file than the agent
 * accepts gets a raw 413 instead of a clean, explainable reason.
 * ============================================================================
 */

const MB = 1024 * 1024;

/** Largest file handed to the converter. */
export const MAX_DOCUMENT_BYTES = 25 * MB;

export const MAX_DOCUMENT_MB = MAX_DOCUMENT_BYTES / MB;

/**
 * Cap on the Markdown returned per document. Deliberately far above the
 * renderer's per-file budget: it stops a pathological file from moving
 * megabytes over the local socket without deciding what reaches the model.
 */
export const MAX_MARKDOWN_CHARS = 400000;

/**
 * Extensions Artemis converts with anydoc.
 *
 * CSV is intentionally absent: it is already read as plain text, which needs no
 * converter and cannot fail. The list is advisory only - the real format comes
 * from the file's own bytes, so a .doc holding a .docx still converts.
 */
export const DOCUMENT_EXT = new Set([
  'doc', 'docm', 'docx',
  'pot', 'pps', 'ppsx', 'ppt', 'pptm', 'pptx',
  'xls', 'xlsb', 'xlsm', 'xlsx',
  'odt', 'ods', 'odp',
  'rtf', 'epub', 'pdf',
]);

/** Extension of a file name, lowercased, or '' when there is none. */
export const extensionOf = (name) => {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
};

/** True when this file name should go to the converter. */
export const isDocumentFile = (name) => DOCUMENT_EXT.has(extensionOf(name));
