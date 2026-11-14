/**
 * ============================================================================
 * LANGUAGE MAP (shared/language-map.js)
 * ============================================================================
 * File-name -> language classification and binary sniffing, shared by BOTH
 * sides of the app:
 *
 *   - renderer (js/ai/file-context.js) - decides what to put in <attached_files>
 *   - ai-agent (rag/ingest.js)         - decides how to chunk a file for retrieval
 *
 * These must agree. If the renderer calls a file "typescript" and the indexer
 * calls it "text", the chunker picks the wrong break points and retrieval gets
 * quietly worse with no error anywhere.
 * ============================================================================
 */

export const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  md: 'markdown', txt: 'text', sh: 'bash', bat: 'batch', ps1: 'powershell',
  sql: 'sql', vue: 'vue', svelte: 'svelte', env: 'dotenv', ini: 'ini',
  lock: 'text', csv: 'csv', log: 'text',
};

/**
 * Extensions that carry no readable text at all.
 *
 * Office documents and PDFs are deliberately NOT here: shared/document-formats.js
 * owns those, and they are converted rather than skipped. Keeping them out of
 * this set is what makes the two lists impossible to confuse.
 */
export const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svgz', 'zip',
  'rar', '7z', 'tar', 'gz', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2',
  'ttf', 'otf', 'mp3', 'mp4', 'mov', 'avi', 'wav',
  'bin', 'class', 'jar', 'pyc',
]);

/** Lowercased extension of a file name, or '' when there is none. */
export const extOf = (name) => {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
};

/** Language used for highlighting and for choosing chunk boundaries. */
export function detectLanguage(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANG_BY_EXT[extOf(name)] || 'text';
}

/**
 * Heuristic sniff for "this decoded text is really bytes".
 *
 * A NUL is decisive. Otherwise we sample the head and count U+FFFD replacement
 * characters, which is what a UTF-8 decoder emits for invalid sequences: above
 * 2% the file is binary no matter what its extension claims.
 */
export function looksBinary(text) {
  if (typeof text !== 'string') return true;
  if (text.includes('\u0000')) return true;

  const sample = text.slice(0, 4000);
  if (!sample.length) return false;

  const bad = (sample.match(/\uFFFD/g) || []).length;
  return bad / sample.length > 0.02;
}
