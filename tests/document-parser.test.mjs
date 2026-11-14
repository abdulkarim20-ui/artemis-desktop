/**
 * ============================================================================
 * DOCUMENT PARSER TESTS (tests/document-parser.test.mjs)
 * ============================================================================
 * Run with `npm test`. Covers the contract the renderer depends on: which
 * formats convert, what shape the Markdown has, and - most importantly - the
 * exact error code and wording for every case where nothing came out.
 *
 * These run against the real anydoc binding, so install dependencies once
 * from the repository root with `npm install`.
 * ============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DOCUMENT_BYTES } from '../shared/document-formats.js';
import { DocumentParseError, parseDocumentBytes } from '../ai-agent/runtime/document-parser.js';
import {
  buildDocx,
  buildGarbage,
  buildPptx,
  buildRtf,
  buildScannedPdf,
  buildTextPdf,
  buildXlsx,
} from './office-fixtures.mjs';

const bytes = (buffer) => new Uint8Array(buffer);

test('docx: structure survives into GitHub Markdown', async () => {
  const result = await parseDocumentBytes(bytes(buildDocx()), 'report.docx');

  assert.equal(result.format, 'docx');
  assert.equal(result.truncated, false);
  assert.match(result.markdown, /^# Quarterly Report$/m);
  assert.match(result.markdown, /^## Regional Split$/m);
  assert.match(result.markdown, /\*\*14 percent\*\*/);
  assert.match(result.markdown, /\*enterprise renewals\*/);
  assert.match(result.markdown, /\| Region \| Revenue \|/);
  assert.match(result.markdown, /\| EMEA \| 4\.2M \|/);
});

test('pptx: slide titles and bullet lists come through', async () => {
  const result = await parseDocumentBytes(bytes(buildPptx()), 'slides.pptx');

  assert.equal(result.format, 'pptx');
  assert.match(result.markdown, /^## Artemis Roadmap$/m);
  assert.match(result.markdown, /^- Ship document parsing$/m);
  assert.match(result.markdown, /^- Add retrieval later$/m);
});

test('xlsx: each sheet becomes a Markdown table', async () => {
  const result = await parseDocumentBytes(bytes(buildXlsx()), 'data.xlsx');

  assert.equal(result.format, 'xlsx');
  assert.match(result.markdown, /\| Region \| Revenue \|/);
  assert.match(result.markdown, /\| EMEA \| 4\.2M \|/);
});

test('rtf: formatting converts instead of shipping control words', async () => {
  const result = await parseDocumentBytes(bytes(buildRtf()), 'contract.rtf');

  assert.equal(result.format, 'rtf');
  assert.match(result.markdown, /\*\*Sample Contract\*\*/);
  assert.match(result.markdown, /\*Artemis Ltd\*/);
  // The bug this guards: RTF markup used to reach the model as "text".
  assert.doesNotMatch(result.markdown, /\\pard|\\par\b|\\ansicpg/);
});

test('pdf: text-based pages extract locally, no OCR service', async () => {
  const result = await parseDocumentBytes(bytes(buildTextPdf()), 'invoice.pdf');

  assert.equal(result.format, 'pdf');
  assert.match(result.markdown, /Invoice 2026-1147/);
  assert.match(result.markdown, /Total due: 4200\.00 EUR/);
});

test('format comes from the bytes, not the file name', async () => {
  // Artemis routes by extension, so a docx named .pdf must still be docx.
  const result = await parseDocumentBytes(bytes(buildDocx()), 'mislabeled.pdf');
  assert.equal(result.format, 'docx');
});

test('scanned PDF reports the pages instead of guessing or uploading', async () => {
  await assert.rejects(
    () => parseDocumentBytes(bytes(buildScannedPdf()), 'scan.pdf'),
    (error) => {
      assert.ok(error instanceof DocumentParseError);
      assert.equal(error.code, 'needsOcr');
      assert.deepEqual(error.pages, [1]);
      assert.equal(error.pageCount, 1);
      assert.equal(
        error.message,
        'page 1 of 1 is a scanned image and needs OCR'
      );
      return true;
    }
  );
});

test('unrecognizable bytes fail as unsupported', async () => {
  await assert.rejects(
    () => parseDocumentBytes(bytes(buildGarbage()), 'mystery.bin'),
    (error) => {
      assert.equal(error.code, 'unsupported');
      return true;
    }
  );
});

test('an empty file fails as empty, not as a conversion error', async () => {
  await assert.rejects(
    () => parseDocumentBytes(new Uint8Array(0), 'nothing.pdf'),
    (error) => {
      assert.equal(error.code, 'empty');
      return true;
    }
  );
});

test('oversized files are refused before the converter is called', async () => {
  const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
  tooBig[0] = 0x25; // '%' so it looks like a PDF header if it ever got further

  await assert.rejects(
    () => parseDocumentBytes(tooBig, 'huge.pdf'),
    (error) => {
      assert.equal(error.code, 'tooLarge');
      assert.match(error.message, /larger than the 25 MB document limit/);
      return true;
    }
  );
});

test('every rejection carries a code the renderer can phrase', async () => {
  const known = new Set([
    'unsupported', 'needsOcr', 'malformed', 'encrypted', 'resourceLimit',
    'missingPart', 'io', 'hosted', 'empty', 'tooLarge', 'parserUnavailable',
  ]);

  for (const [buffer, name] of [[buildGarbage(), 'x.bin'], [new Uint8Array(0), 'x.pdf']]) {
    await assert.rejects(
      () => parseDocumentBytes(bytes(buffer), name),
      (error) => {
        assert.ok(known.has(error.code), `unexpected code: ${error.code}`);
        assert.ok(error.message.length > 0);
        return true;
      }
    );
  }
});
