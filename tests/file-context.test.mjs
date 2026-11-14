/**
 * ============================================================================
 * FILE CONTEXT TESTS (tests/file-context.test.mjs)
 * ============================================================================
 * The renderer half of document support: which attachments get converted, what
 * the model is told when a conversion fails, and what happens when the agent is
 * not there at all. The parse endpoint is stubbed, so these run offline.
 * ============================================================================
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_MB } from '../shared/document-formats.js';
import {
  DOCUMENT_EXT,
  LIMITS,
  buildFileContext,
  estimateBudget,
} from '../renderer/js/ai/file-context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;
let calls = [];

/** Replaces fetch with a recorder; `handler` returns the payload or throws. */
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const result = await handler(url, options);
    if (result instanceof Error) throw result;
    return { json: async () => result };
  };
}

const file = (name, size = 1024, type = '') =>
  new File([new Uint8Array(size)], name, { type });

const converted = { ok: true, markdown: '# Quarterly Report\n\nRevenue grew.\n', format: 'docx', truncated: false };

beforeEach(() => stubFetch(() => converted));
afterEach(() => { globalThis.fetch = realFetch; });

/* ------------------------------------------------------------------ routing */

test('office documents go to the converter, not the text reader', async () => {
  for (const name of ['report.docx', 'slides.pptx', 'data.xlsx', 'legacy.doc', 'old.ppt', 'notes.rtf', 'book.epub']) {
    if (!DOCUMENT_EXT.has(name.split('.').pop())) assert.fail(`${name} is not routed as a document`);
  }

  const ctx = await buildFileContext([file('report.docx')]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/parse/);
  assert.equal(ctx.readCount, 1);
  assert.match(ctx.block, /converted-from="docx"/);
  assert.match(ctx.block, /markdown converted from docx/);
  assert.match(ctx.block, /# Quarterly Report/);
});

test('CSV stays on the text path and never touches the converter', async () => {
  const csv = new File(['region,revenue\nEMEA,4.2M\n'], 'notes.csv', { type: 'text/csv' });
  const ctx = await buildFileContext([csv]);

  assert.equal(calls.length, 0, 'CSV must not be sent to the converter');
  assert.match(ctx.block, /language="csv"/);
  assert.match(ctx.block, /EMEA,4\.2M/);
});

test('images are still skipped without a pointless conversion call', async () => {
  const ctx = await buildFileContext([file('diagram.png', 2048, 'image/png')]);

  assert.equal(calls.length, 0);
  assert.match(ctx.block, /status="skipped"/);
  assert.equal(ctx.readCount, 0);
});

test('a file over the shared cap is refused before any request is made', async () => {
  const ctx = await buildFileContext([file('huge.pdf', MAX_DOCUMENT_BYTES + 1)]);

  assert.equal(calls.length, 0, 'oversized files must not be uploaded to the agent');
  assert.match(ctx.block, new RegExp(`larger than ${MAX_DOCUMENT_MB} MB`));
});

/* --------------------------------------------------------------- honest gaps */

test('a scanned PDF tells the model which pages are missing, and why', async () => {
  stubFetch(() => ({
    ok: false,
    code: 'needsOcr',
    message: 'pages 2, 5-7 of 12 are scanned images and need OCR',
    pages: [2, 5, 6, 7],
    pageCount: 12,
  }));

  const ctx = await buildFileContext([file('scan.pdf')]);

  assert.equal(ctx.readCount, 0);
  assert.match(ctx.block, /status="skipped"/);
  assert.match(ctx.block, /pages 2, 5-7 of 12 are scanned images/);
  assert.match(ctx.block, /Artemis does not send documents to an external OCR service/);
  assert.match(ctx.warnings.join('\n'), /scan\.pdf: skipped/);
});

test('password-protected documents are reported, not guessed at', async () => {
  stubFetch(() => ({ ok: false, code: 'encrypted', message: 'encrypted input' }));

  const ctx = await buildFileContext([file('secret.docx')]);

  assert.match(ctx.block, /the file is encrypted or password-protected/);
  assert.equal(ctx.readCount, 0);
});

test('an unknown code still produces a usable reason', async () => {
  stubFetch(() => ({ ok: false, code: 'brandNewErrorCode', message: 'some future wording' }));

  const ctx = await buildFileContext([file('weird.docx')]);

  assert.match(ctx.block, /some future wording/);
  assert.match(ctx.block, /status="skipped"/);
});

test('when the agent is down the request still succeeds and says so', async () => {
  stubFetch(() => new TypeError('fetch failed'));

  const ctx = await buildFileContext([
    file('report.docx'),
    new File(['console.log(1)\n'], 'app.js', { type: 'text/javascript' }),
  ]);

  // The document is honestly skipped; the code file still gets through.
  assert.match(ctx.block, /the local document converter is not running/);
  assert.equal(ctx.readCount, 1);
  assert.match(ctx.block, /language="javascript"/);
});

test('a failed conversion never claims language="text"', async () => {
  stubFetch(() => ({ ok: false, code: 'malformed', message: 'structurally unusable' }));

  const ctx = await buildFileContext([file('broken.docx')]);

  assert.match(ctx.block, /language="document"/);
  assert.doesNotMatch(ctx.block, /path="broken\.docx" language="text"/);
});

/* ------------------------------------------------------------------ budgets */

test('document sizes are estimated, then capped at the per-file budget', () => {
  const halfMB = estimateBudget([file('deck.pptx', 512 * 1024)]);

  assert.equal(halfMB.readable, 1, 'documents are readable, not skipped');
  assert.equal(halfMB.skipped, 0);
  assert.equal(halfMB.demand, LIMITS.MAX_FILE_CHARS, 'estimate is capped at MAX_FILE_CHARS');
});

test('the renderer and the converter share one size cap', async () => {
  assert.equal(LIMITS.MAX_DOC_BYTES, MAX_DOCUMENT_BYTES, 'MAX_DOC_BYTES drifted from the agent');
});

test('a truncated document states which lines were not sent', async () => {
  // Well past MAX_FILE_CHARS so the head/tail cut is guaranteed.
  stubFetch(() => ({
    ...converted,
    markdown: `# Head\n\n${Array.from({ length: 12000 }, (_, i) => `${'x'.repeat(40)}${i}`).join('\n')}\n`,
  }));

  const ctx = await buildFileContext([file('long.docx')]);

  assert.match(ctx.block, /status="truncated"/);
  assert.match(ctx.block, /OMITTED \(not visible to you\)/);
  assert.match(ctx.warnings.join('\n'), /were not sent/);
});

/* -------------------------------------------------------------------- drift */

test('the folder-upload binary list can never swallow a document format', async () => {
  const source = await readFile(path.join(here, '../renderer/ai/components/attachments/attachments.js'), 'utf8');
  const block = /static BINARY_EXT = new Set\(\[([\s\S]*?)\]\);/.exec(source);

  assert.ok(block, 'AIAttachments.BINARY_EXT no longer parseable; update this guard');

  const listed = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const swallowed = [...listed].filter((ext) => DOCUMENT_EXT.has(ext));

  assert.deepEqual(swallowed, [], `folder uploads would drop: ${swallowed.join(', ')}`);
});
