/**
 * ============================================================================
 * INGEST (rag/ingest.js)
 * ============================================================================
 * Normalizes raw file bytes into the text the chunker expects, and decides
 * which chunking strategy applies.
 *
 * Three kinds of input reach a knowledge base:
 *   - office documents and PDFs -> converted locally by anydoc (no upload, no OCR)
 *   - source code               -> read as text, chunked on declaration boundaries
 *   - prose / markdown / csv    -> read as text, chunked on paragraphs
 *
 * Anything else is rejected with a stable code and a sentence a human can read,
 * so the UI can say exactly why a file did not make it into the index instead
 * of showing a smaller number with no explanation.
 *
 * The document converter is injected rather than imported directly: it loads a
 * native binding, and tests (plus the agent's own degraded mode) must be able
 * to run without it.
 * ============================================================================
 */

import { createHash } from "node:crypto";

import { DOCUMENT_EXT, extensionOf } from "../../shared/document-formats.js";
import { BINARY_EXT, detectLanguage, looksBinary } from "../../shared/language-map.js";
import { CHUNK_KINDS } from "./chunker.js";
import { RAG_DEFAULTS } from "./config.js";

/** Languages that are prose rather than code, and so chunk on paragraphs. */
const PROSE_LANGUAGES = new Set(["text", "csv", "markdown", "dotenv", "ini"]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif"]);

/** A rejection the caller should report to the user, not crash on. */
export class IngestError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "IngestError";
        this.code = code;
        if (details.pages) this.pages = details.pages;
        if (details.pageCount) this.pageCount = details.pageCount;
    }
}

/**
 * Content hash used for idempotent ingestion.
 *
 * The renderer re-sends every attachment with every message in a conversation.
 * Hashing the bytes means the second send is a no-op instead of re-embedding the
 * whole corpus and paying for it again - and it also means an edited file is
 * correctly treated as a new document rather than a duplicate.
 */
export function contentHash(bytes) {
    return createHash("sha256").update(Buffer.from(bytes || [])).digest("hex");
}

function kindFor(language) {
    if (language === "markdown") return CHUNK_KINDS.MARKDOWN;
    if (PROSE_LANGUAGES.has(language)) return CHUNK_KINDS.TEXT;
    return CHUNK_KINDS.CODE;
}

/**
 * @param {object} params
 * @param {Uint8Array|Buffer} params.bytes
 * @param {string} params.name file name or relative path
 * @param {(bytes, name) => Promise<{markdown: string, format: string, truncated: boolean}>} [params.parseDocument]
 * @param {number} [params.maxTextChars]
 * @returns {Promise<{
 *   text: string, kind: string, language: string, convertedFrom: string,
 *   truncated: boolean, chars: number, hash: string
 * }>}
 * @throws {IngestError} with a stable `code`
 */
export async function prepareDocument({ bytes, name, parseDocument, maxTextChars }) {
    const buffer = bytes ? Buffer.from(bytes) : Buffer.alloc(0);
    const limit = maxTextChars || RAG_DEFAULTS.maxDocumentTextChars;
    const ext = extensionOf(name);
    const language = detectLanguage(name);

    if (buffer.length === 0) {
        throw new IngestError("empty", "the file is empty");
    }

    let text = "";
    let kind = kindFor(language);
    let convertedFrom = "";
    let truncated = false;

    if (DOCUMENT_EXT.has(ext)) {
        if (typeof parseDocument !== "function") {
            throw new IngestError(
                "parserUnavailable",
                "no document converter is available, so this file cannot be indexed"
            );
        }

        try {
            // Reuses the exact converter behind POST /api/parse, so a file that
            // attaches successfully also indexes successfully - same rules, same
            // honest failures, including "pages 2, 5-7 need OCR".
            const result = await parseDocument(buffer, name);
            text = String(result.markdown || "");
            convertedFrom = result.format || ext;
            truncated = Boolean(result.truncated);
            kind = CHUNK_KINDS.MARKDOWN;
        } catch (error) {
            // Preserve the converter's own code and page numbers: needsOcr is
            // only useful if the user is told WHICH pages were unreadable.
            throw new IngestError(
                error.code || "malformed",
                error.message || "the document could not be converted",
                { pages: error.pages, pageCount: error.pageCount }
            );
        }
    } else if (IMAGE_EXT.has(ext)) {
        // The embedding model can take page images, but that path is not wired
        // up yet. Say so plainly rather than indexing the file name and
        // pretending the picture is searchable.
        throw new IngestError(
            "imageNotIndexed",
            "images are not indexed yet; only their text would be searchable, and this file has none"
        );
    } else if (BINARY_EXT.has(ext)) {
        throw new IngestError("binary", "this file type has no readable text to index");
    } else {
        text = buffer.toString("utf8").replace(/^\uFEFF/, "");

        if (looksBinary(text)) {
            throw new IngestError("binary", "the file looks binary, not text, despite its extension");
        }
    }

    text = text.replace(/\r\n?/g, "\n");

    if (!text.trim()) {
        throw new IngestError("empty", "the file contained no readable text");
    }

    // A huge file is worth indexing partially; a huge file that silently
    // disappears is not. Record the cut so the UI can say so.
    if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
    }

    return {
        text,
        kind,
        // Converted documents are Markdown regardless of what the file was called.
        language: convertedFrom ? "markdown" : language,
        convertedFrom,
        truncated,
        chars: text.length,
        hash: contentHash(buffer),
    };
}
