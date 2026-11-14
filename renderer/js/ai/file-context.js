/**
 * ============================================================================
 * FILE CONTEXT (renderer/js/ai/file-context.js)
 * ============================================================================
 * Turns attached files into a structured, model-friendly context block.
 *
 * Goals:
 *  - The model sees the REAL file contents (not just names).
 *  - Office documents and text-based PDFs are converted to Markdown by the
 *    local agent (anydoc) instead of being skipped as unreadable binaries.
 *  - Multi-file projects keep their structure (paths, outline, dependencies).
 *  - Anything that is skipped or truncated is stated explicitly, so the model
 *    never has to guess what it could not see.
 * ============================================================================
 */

import { DEFAULT_AI_BASE_URL } from './ai-client.js';
import { DOCUMENT_EXT, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_MB } from '../../../shared/document-formats.js';
import { BINARY_EXT, detectLanguage, extOf, looksBinary } from '../../../shared/language-map.js';

// The converter's format list and size cap are shared with the agent, so the
// renderer never sends a file the agent would reject with a bare 413.
// Language and binary classification are shared for the same reason: the RAG
// indexer must chunk a file the same way this module describes it.
export { DOCUMENT_EXT, BINARY_EXT, detectLanguage };

export const LIMITS = {
  MAX_READ_BYTES: 2 * 1024 * 1024, // refuse to read files bigger than 2 MB
  MAX_DOC_BYTES: MAX_DOCUMENT_BYTES, // documents go to the converter, so they may be bigger
  MAX_FILE_CHARS: 60000,           // per-file budget
  MAX_TOTAL_CHARS: 120000,         // raw file text budget for one message
  MAX_FILES: 100,                  // files read per message (extras are listed as skipped)
  BLOCK_HARD_LIMIT: 135000,        // final block must stay under the backend's 150000
  HEAD_RATIO: 0.7,                 // when truncating, keep 70% head / 30% tail
  MAX_OUTLINE_ITEMS: 80,
  HISTORY_FILE_BUDGET: 40000,      // total chars of file blocks kept in history
  DOC_CHAR_FACTOR: 1.5,            // pre-conversion estimate only, see estimateBudget
};

/**
 * The converter's format list lives in shared/document-formats.js (imported
 * and re-exported above). CSV is absent from it on purpose: CSV is already read
 * as plain text, which costs nothing and cannot fail.
 */

/** Failure codes from /api/parse, phrased for the model and the user. */
const PARSE_REASONS = {
  needsOcr: (message) => `${message}. Artemis does not send documents to an external OCR service`,
  encrypted: 'the file is encrypted or password-protected',
  unsupported: 'not a document format the converter recognizes',
  malformed: 'the file is damaged; no readable content could be extracted',
  missingPart: 'a part required to read the file is missing',
  empty: 'the file contained no readable text',
  resourceLimit: 'the file is too complex to convert safely',
  tooLarge: (message) => message,
  parserUnavailable: 'the local document converter is not available',
};

const parseReason = (json) => {
  const code = json?.code || 'malformed';
  const entry = PARSE_REASONS[code];
  if (typeof entry === 'function') return entry(json?.message || code);
  return entry || json?.message || 'the document could not be converted';
};

/* ---------- small helpers ---------- */

const displayPath = (file) => file.webkitRelativePath || file.name || 'file';

/** Prevent file content from closing our own wrapper tags. */
function escapeWrapperTags(text) {
  return text.replace(/<(\/?)(attached_files|file|content|outline|dependencies)\b/gi, '<\\$1$2');
}

function numberLines(text, startLine = 1) {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

/* ---------- outline + imports ---------- */

const OUTLINE_PATTERNS = {
  javascript: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/,
    /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/,
    /^\s{2,4}(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*$/,
  ],
  python: [/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/, /^\s*class\s+([A-Za-z0-9_]+)/],
  java: [/^\s*(?:public|private|protected|static|final|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z0-9_]+)\s*\([^;]*\)\s*(?:throws [\w, .]+)?\{/, /^\s*(?:public\s+)?(?:class|interface|enum)\s+([A-Za-z0-9_]+)/],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, /^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/],
  rust: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z0-9_]+)/],
  css: [/^\s*([.#@][^{]+)\{/],
  markdown: [/^(#{1,4}\s+.+)$/],
};
OUTLINE_PATTERNS.typescript = OUTLINE_PATTERNS.javascript;
OUTLINE_PATTERNS.jsx = OUTLINE_PATTERNS.javascript;
OUTLINE_PATTERNS.tsx = OUTLINE_PATTERNS.javascript;
OUTLINE_PATTERNS.kotlin = OUTLINE_PATTERNS.java;
OUTLINE_PATTERNS.csharp = OUTLINE_PATTERNS.java;
OUTLINE_PATTERNS.scss = OUTLINE_PATTERNS.css;

const IMPORT_PATTERNS = [
  /import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/,
  /require\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s/,
  /^\s*import\s+([A-Za-z0-9_.]+)\s*$/,
  /<script[^>]+src=["']([^"']+)["']/i,
  /<link[^>]+href=["']([^"']+\.css)["']/i,
  /@import\s+(?:url\()?['"]?([^'")\s;]+)/,
];

export function extractOutline(text, language) {
  const patterns = OUTLINE_PATTERNS[language];
  const items = [];
  const imports = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    for (const re of IMPORT_PATTERNS) {
      const m = re.exec(line);
      if (m) { imports.push(m[1]); break; }
    }

    if (!patterns || items.length >= LIMITS.MAX_OUTLINE_ITEMS) continue;
    for (const re of patterns) {
      const m = re.exec(line);
      if (m) {
        items.push(`L${i + 1}: ${line.trim().slice(0, 90)}`);
        break;
      }
    }
  }

  return { items, imports: [...new Set(imports)] };
}

/** Map each file's imports onto OTHER attached files (by file name). */
function buildDependencyMap(entries) {
  const byBase = new Map();
  entries.forEach((e) => {
    if (e.status === 'skipped') return;
    byBase.set(e.path.split('/').pop().toLowerCase(), e.path);
  });

  const lines = [];
  entries.forEach((e) => {
    if (e.status === 'skipped' || !e.imports.length) return;
    const resolved = [];
    const external = [];
    e.imports.forEach((spec) => {
      const base = spec.split('/').pop().toLowerCase();
      const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.py`, `${base}.css`];
      const hit = candidates.find((c) => byBase.has(c));
      if (hit && byBase.get(hit) !== e.path) resolved.push(byBase.get(hit));
      else external.push(spec);
    });
    if (resolved.length || external.length) {
      lines.push(
        `${e.path} -> attached: [${[...new Set(resolved)].join(', ') || 'none'}]` +
        ` | not attached: [${external.slice(0, 12).join(', ') || 'none'}]`
      );
    }
  });
  return lines;
}

/* ---------- reading + truncation ---------- */

function truncateHeadTail(text, budget) {
  if (text.length <= budget) return { text, truncated: false };

  const lines = text.split('\n');
  const headChars = Math.floor(budget * LIMITS.HEAD_RATIO);
  const tailChars = budget - headChars;

  let headEnd = 0; let used = 0;
  while (headEnd < lines.length && used + lines[headEnd].length + 1 <= headChars) {
    used += lines[headEnd].length + 1; headEnd += 1;
  }

  let tailStart = lines.length; used = 0;
  while (tailStart > headEnd && used + lines[tailStart - 1].length + 1 <= tailChars) {
    used += lines[tailStart - 1].length + 1; tailStart -= 1;
  }

  return {
    truncated: true,
    headLines: lines.slice(0, headEnd),
    tailLines: lines.slice(tailStart),
    omittedFrom: headEnd + 1,
    omittedTo: tailStart,
    totalLines: lines.length,
    tailStartLine: tailStart + 1,
  };
}

/* Each attachment is read (and, for documents, converted) once per session.
 * Keyed by name + size + mtime so an edited file is read again. */
const readCache = new Map();
const readKey = (file) => `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;

function readOne(file) {
  const key = readKey(file);
  let pending = readCache.get(key);
  if (!pending) {
    pending = readOneUncached(file);
    readCache.set(key, pending);
    if (readCache.size > 60) readCache.delete(readCache.keys().next().value);
    // A converter that was still booting must be retried, not remembered.
    pending.then((entry) => {
      if (entry?.status === 'skipped' && /converter is not running/.test(entry.reason || '')) {
        readCache.delete(key);
      }
    });
  }
  return pending;
}

/** Warm the cache at attach time so the send path finds everything ready. */
export function prefetchFiles(files) {
  for (const file of Array.from(files || []).slice(0, LIMITS.MAX_FILES)) {
    readOne(file).catch(() => {});
  }
}

/**
 * Total readable characters across the files. Uses the read cache, so after
 * prefetchFiles() this costs nothing.
 */
export async function measureFiles(files) {
  const list = Array.from(files || []).slice(0, LIMITS.MAX_FILES);
  const entries = await Promise.all(list.map((file) => readOne(file)));
  return entries.reduce((sum, e) => sum + (e.status === 'ok' ? e.text.length : 0), 0);
}

async function readOneUncached(file) {
  const path = displayPath(file);
  const language = detectLanguage(path);
  const base = { path, language, bytes: file.size || 0 };

  // Documents are converted, not text-read. Checked first, because a .doc and
  // a .pdf are both binary-ish but only one of them has a parser.
  if (DOCUMENT_EXT.has(extOf(path))) return readDocument(file, base);

  if (BINARY_EXT.has(extOf(path)) || (file.type || '').startsWith('image/')) {
    return { ...base, status: 'skipped', reason: 'binary or image file (this model cannot read it)', imports: [], outline: [] };
  }
  if (file.size > LIMITS.MAX_READ_BYTES) {
    return { ...base, status: 'skipped', reason: `file is larger than ${LIMITS.MAX_READ_BYTES / 1024 / 1024} MB`, imports: [], outline: [] };
  }

  try {
    const raw = await file.text();
    if (looksBinary(raw)) {
      return { ...base, status: 'skipped', reason: 'file looks binary, not text', imports: [], outline: [] };
    }
    const text = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    const { items, imports } = extractOutline(text, language);
    return { ...base, status: 'ok', text, lines: text.split('\n').length, outline: items, imports };
  } catch (err) {
    return { ...base, status: 'skipped', reason: `could not be read (${err?.message || 'unknown error'})`, imports: [], outline: [] };
  }
}

/**
 * Sends document bytes to the agent's local converter (anydoc) and returns the
 * resulting Markdown as if it were the file's text. Runs on this machine only;
 * a scanned PDF is reported with its page numbers rather than sent elsewhere.
 */
async function readDocument(file, base) {
  // A skipped document must not claim language="text"; nothing was read as text.
  const doc = { ...base, language: 'document' };

  if ((file.size || 0) > LIMITS.MAX_DOC_BYTES) {
    return {
      ...doc,
      status: 'skipped',
      reason: `file is larger than ${MAX_DOCUMENT_MB} MB`,
      imports: [],
      outline: [],
    };
  }

  let json = null;
  try {
    const bytes = await file.arrayBuffer();
    const name = encodeURIComponent(base.path.split('/').pop() || '');
    const response = await fetch(`${DEFAULT_AI_BASE_URL}/api/parse?name=${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    json = await response.json().catch(() => null);
  } catch {
    // The agent is down or still booting: say so instead of pretending the
    // document was empty.
    return { ...doc, status: 'skipped', reason: 'the local document converter is not running', imports: [], outline: [] };
  }

  if (!json || json.ok !== true) {
    return { ...doc, status: 'skipped', reason: parseReason(json), imports: [], outline: [] };
  }

  const text = String(json.markdown || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { ...doc, status: 'skipped', reason: 'the document contained no readable text', imports: [], outline: [] };
  }

  // The heading outline is what keeps a long converted document navigable for
  // the model when the body has to be truncated to fit.
  const { items } = extractOutline(text, 'markdown');
  return {
    ...doc,
    language: 'markdown',
    converted: json.format || '',
    status: 'ok',
    text,
    lines: text.split('\n').length,
    outline: items,
    imports: [],
  };
}

/* ---------- public API ---------- */

/* ---------- budgeting for MANY files ---------- */

const floorFor = (count, scale) =>
  Math.max(300, Math.floor((count > 30 ? 600 : 2000) * scale));

const attr = (s) => String(s).replace(/"/g, '&quot;');

/**
 * Cheap estimate (no file reading) used by the attachments panel meter.
 * demand = how many characters the readable files would need in total.
 *
 * File size is only a proxy. A document's own bytes say little about its text
 * (an image-heavy deck is huge and says almost nothing; a 200 KB .docx is pure
 * prose), so converted files use an expansion factor - and every file is
 * capped at MAX_FILE_CHARS, which is what the real budget in assemble() will
 * enforce once the contents are known.
 */
export function estimateBudget(files) {
  const list = Array.from(files || []).slice(0, LIMITS.MAX_FILES);
  const sizes = [];
  let skipped = 0;
  let demand = 0;

  const capped = (chars) => Math.min(Math.round(chars), LIMITS.MAX_FILE_CHARS);

  for (const f of list) {
    const path = displayPath(f);
    const ext = extOf(path);
    const isDocument = DOCUMENT_EXT.has(ext);

    const unreadable = isDocument
      ? (f.size || 0) > LIMITS.MAX_DOC_BYTES
      : BINARY_EXT.has(ext) ||
        (f.type || '').startsWith('image/') ||
        (f.size || 0) > LIMITS.MAX_READ_BYTES;

    if (unreadable) { skipped += 1; continue; }

    const chars = capped((f.size || 0) * (isDocument ? LIMITS.DOC_CHAR_FACTOR : 1));
    sizes.push(chars);
    demand += chars;
  }

  const floor = floorFor(list.length, 1);
  let remaining = LIMITS.MAX_TOTAL_CHARS;
  let left = sizes.length;
  let partial = 0;

  for (const size of sizes) {
    const per = Math.max(floor, Math.min(LIMITS.MAX_FILE_CHARS, Math.floor(remaining / Math.max(left, 1))));
    left -= 1;
    if (size <= per) remaining -= size;
    else { remaining -= per; partial += 1; }
  }

  return {
    readable: sizes.length,
    skipped,
    partial,
    demand,
    budget: LIMITS.MAX_TOTAL_CHARS,
    fits: partial === 0,
  };
}

if (typeof window !== 'undefined') {
  // The attachments panel is a classic script, so it reads this from window.
  window.ArtemisFileContext = { LIMITS, DOCUMENT_EXT, estimateBudget };
}

/** Build the <attached_files> block at a given shrink scale (1 = full budget). */
function assemble(entries, scale) {
  const warnings = [];
  const count = entries.length;
  const outlineCap = count > 40 ? 8 : count > 20 ? 15 : count > 8 ? 30 : LIMITS.MAX_OUTLINE_ITEMS;
  const floor = floorFor(count, scale);
  const perFileMax = Math.floor(LIMITS.MAX_FILE_CHARS * scale);

  let remaining = Math.floor(LIMITS.MAX_TOTAL_CHARS * scale);
  let filesLeft = entries.filter((e) => e.status === 'ok').length;

  const fileBlocks = entries.map((e) => {
    const from = e.converted ? ` converted-from="${e.converted}"` : '';
    const attrs = `path="${attr(e.path)}" language="${e.language}" bytes="${e.bytes}"${from}`;

    if (e.status === 'skipped') {
      warnings.push(`${e.path}: skipped, ${e.reason}`);
      return `<file ${attrs} status="skipped" reason="${attr(e.reason)}" />`;
    }

    const budget = Math.max(floor, Math.min(perFileMax, Math.floor(remaining / Math.max(filesLeft, 1))));
    filesLeft -= 1;

    const result = truncateHeadTail(e.text, budget);
    let body;
    let status = 'complete';

    if (!result.truncated) {
      body = numberLines(escapeWrapperTags(e.text));
      remaining -= e.text.length;
    } else {
      status = 'truncated';
      const head = numberLines(escapeWrapperTags(result.headLines.join('\n')), 1);
      const tail = numberLines(escapeWrapperTags(result.tailLines.join('\n')), result.tailStartLine);
      body = `${head}\n[... lines ${result.omittedFrom}-${result.omittedTo} OMITTED (not visible to you) ...]\n${tail}`;
      remaining -= budget;
      warnings.push(`${e.path}: too large, lines ${result.omittedFrom}-${result.omittedTo} were not sent`);
    }

    const shown = e.outline.slice(0, outlineCap);
    const cut = e.outline.length > shown.length;
    const outline = shown.length
      ? `<outline note="built from the FULL file${cut ? `, first ${shown.length} items shown` : ''}">\n${shown.join('\n')}\n</outline>\n`
      : '';

    return `<file ${attrs} lines="${e.lines}" status="${status}">\n${outline}<content>\n${body}\n</content>\n</file>`;
  });

  const depLines = buildDependencyMap(entries);
  const deps = depLines.length
    ? `<dependencies note="derived from import statements">\n${depLines.join('\n')}\n</dependencies>\n`
    : '';

  const manifest = entries
    .map((e) => {
      const kind = e.converted ? `${e.language} converted from ${e.converted}` : e.language;
      return `- ${e.path} (${kind}, ${e.status === 'ok' ? `${e.lines} lines` : 'skipped'})`;
    })
    .join('\n');

  const block =
    `<attached_files count="${entries.length}">\n` +
    `<manifest>\n${manifest}\n</manifest>\n` +
    deps +
    fileBlocks.join('\n') +
    `\n</attached_files>`;

  return { block, warnings };
}

/** Last resort: the list of files only, so the request still succeeds. */
function manifestOnly(entries) {
  const manifest = entries
    .map((e) => `- ${e.path} (${e.converted ? `${e.language} converted from ${e.converted}` : e.language})`)
    .join('\n');
  return {
    block:
      `<attached_files count="${entries.length}" status="contents_omitted">\n` +
      `<manifest>\n${manifest}\n</manifest>\n` +
      `The file contents were too large to send. Only the file list is available. ` +
      `Ask the user to attach fewer or smaller files.\n</attached_files>`,
    warnings: ['File contents were too large to send; only the file list was included.'],
  };
}

/**
 * Outline mode: manifest, structure and a short head per file - no full body.
 *
 * Used when the same files are already indexed in the knowledge base. The
 * server-side <retrieved_context> block then supplies the passages that answer
 * the question, so repeating tens of thousands of characters of inline content
 * only delays the first token without adding anything the retrieval cannot
 * provide. The head is kept so the model can still see what kind of document
 * each file is, and answer anything the retrieval missed.
 */
function assembleOutline(entries, headChars) {
  const warnings = [];

  const fileBlocks = entries.map((e) => {
    const from = e.converted ? ` converted-from="${e.converted}"` : '';
    const attrs = `path="${attr(e.path)}" language="${e.language}" bytes="${e.bytes}"${from}`;

    if (e.status === 'skipped') {
      warnings.push(`${e.path}: skipped, ${e.reason}`);
      return `<file ${attrs} status="skipped" reason="${attr(e.reason)}" />`;
    }

    const head = e.text.slice(0, headChars);
    const shown = e.outline.slice(0, LIMITS.MAX_OUTLINE_ITEMS);
    const cut = e.outline.length > shown.length;
    const outline = shown.length
      ? `<outline note="built from the FULL file${cut ? `, first ${shown.length} items shown` : ''}">\n${shown.join('\n')}\n</outline>\n`
      : '';

    // Outline mode is an internal optimisation (the full text is in the knowledge
    // base). It is not a problem the user can act on, so it is NOT a warning.

    return (
      `<file ${attrs} lines="${e.lines}" status="outlined">\n` +
      outline +
      `<head>\n${numberLines(escapeWrapperTags(head))}\n</head>\n</file>`
    );
  });

  const manifest = entries
    .map((e) => {
      const kind = e.converted ? `${e.language} converted from ${e.converted}` : e.language;
      return `- ${e.path} (${kind}, ${e.status === 'ok' ? `${e.lines} lines` : 'skipped'})`;
    })
    .join('\n');

  const block =
    `<attached_files count="${entries.length}" mode="outline" note="full contents are indexed in the knowledge base; retrieved_context passages are drawn from them">\n` +
    `<manifest>\n${manifest}\n</manifest>\n` +
    fileBlocks.join('\n') +
    `\n</attached_files>`;

  return { block, warnings };
}

/**
 * @param {File[]} files
 * @param {{ outlineHeadChars?: number|null }} [options] when outlineHeadChars is
 *   a positive number the block is built in outline mode (see assembleOutline);
 *   omit it for the full-content block.
 * @returns {Promise<{ block: string, warnings: string[], readCount: number }>}
 */
export async function buildFileContext(files, options = {}) {
  const all = Array.from(files || []);
  if (!all.length) return { block: '', warnings: [], readCount: 0 };

  const toRead = all.slice(0, LIMITS.MAX_FILES);
  const entries = await Promise.all(toRead.map((file) => readOne(file)));

  // Anything beyond the file cap is listed as skipped, never silently dropped.
  all.slice(LIMITS.MAX_FILES).forEach((file) => {
    const path = displayPath(file);
    entries.push({
      path,
      language: detectLanguage(path),
      bytes: file.size || 0,
      status: 'skipped',
      reason: `more than ${LIMITS.MAX_FILES} files attached`,
      imports: [],
      outline: [],
    });
  });

  const readCount = entries.filter((e) => e.status === 'ok').length;

  // The knowledge base already holds these files, so the inline copy only needs
  // to orient the model - retrieval supplies the detail.
  if (Number.isInteger(options.outlineHeadChars) && options.outlineHeadChars > 0) {
    const outlined = assembleOutline(entries, options.outlineHeadChars);
    return { block: outlined.block, warnings: outlined.warnings, readCount };
  }

  // Shrink until the whole block (line numbers, outlines, manifest included) fits.
  let result = null;
  let usedScale = 1;
  for (const scale of [1, 0.75, 0.55, 0.4, 0.28]) {
    usedScale = scale;
    result = assemble(entries, scale);
    if (result.block.length <= LIMITS.BLOCK_HARD_LIMIT) break;
  }

  if (result.block.length > LIMITS.BLOCK_HARD_LIMIT) {
    result = manifestOnly(entries);
  } else if (usedScale < 1) {
    result.warnings.push('Files were shortened further to fit the size limit.');
  }

  return {
    block: result.block,
    warnings: result.warnings,
    readCount,
  };
}

/**
 * Keep the newest file blocks in history in full. Older ones are replaced with
 * an honest stub, so the model never pretends it still remembers them.
 *
 * `indexed` says the files live in the knowledge base, so the stub points at
 * <retrieved_context> instead of asking the user to re-attach.
 */
export function compactHistoryFileBlocks(history, { indexed = false } = {}) {
  const re = /<attached_files[\s\S]*?<\/attached_files>/g;
  let budget = LIMITS.HISTORY_FILE_BUDGET;

  const stub = indexed
    ? '<attached_files status="removed">The file text from this earlier message is not repeated here. ' +
      'It is in the knowledge base: use <retrieved_context> for details.</attached_files>'
    : '<attached_files status="removed">The file contents from this earlier message are no longer in context. ' +
      'Ask the user to re-attach them if you need them.</attached_files>';

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

    msg.content = msg.content.replace(re, (block) => {
      if (block.length <= budget) { budget -= block.length; return block; }
      return stub;
    });
  }
}
