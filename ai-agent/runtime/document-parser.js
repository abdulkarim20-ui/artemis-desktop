/**
 * ============================================================================
 * DOCUMENT PARSER (runtime/document-parser.js)
 * ============================================================================
 * Turns office documents and text-based PDFs into GitHub-Flavored Markdown so
 * the chat view can put their real contents in front of the model.
 *
 * Backed by anydoc (Rust, via a node-api binding). Conversion is local, no API
 * key and no OCR: a PDF with scanned pages rejects with `needsOcr` naming those
 * pages, and Artemis reports that to the user instead of shipping the document
 * to an external service.
 *
 * The binding is loaded lazily. If the native module is missing (a partial
 * install, an unsupported CPU), the agent still starts and every document
 * reports `parserUnavailable` rather than the whole app failing to boot.
 *
 * Limits and the format list come from shared/document-formats.js, which the
 * renderer reads from the same file, so neither side can drift.
 * ============================================================================
 */

import {
    MAX_DOCUMENT_BYTES,
    MAX_MARKDOWN_CHARS,
} from "../../shared/document-formats.js";
import { createHash } from "node:crypto";

export { MAX_DOCUMENT_BYTES, MAX_MARKDOWN_CHARS };

/**
 * Parse results are cached by content hash. The same bytes reach the converter
 * twice in a normal turn (once from /api/rag/documents when indexing, once from
 * /api/parse when the renderer builds the inline block). Caching the *promise*
 * also de-duplicates two requests that arrive at the same moment.
 */
const PARSE_CACHE_MAX = 32;
const parseCache = new Map(); // sha1(bytes) -> Promise<{ markdown, format, truncated }>

let bindingPromise = null;

/**
 * Loads (once) the anydoc binding. Kept as a dynamic import so a broken native
 * dependency surfaces as a per-document error instead of a startup crash.
 */
async function loadBinding() {
    if (!bindingPromise) {
        bindingPromise = import("@firecrawl/anydoc").catch((error) => {
            // Retry on the next request: a failed load is often environmental.
            bindingPromise = null;
            throw error;
        });
    }
    return bindingPromise;
}

/** A conversion problem that the caller is expected to render, not throw at. */
export class DocumentParseError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "DocumentParseError";
        this.code = code;
        if (details.pages) this.pages = details.pages;
        if (details.pageCount) this.pageCount = details.pageCount;
    }
}

/** 1-based page list, collapsed into ranges: [2,5,6,7] -> "2, 5-7". */
function formatPages(pages) {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (const page of sorted.slice(1)) {
        if (page === prev + 1) {
            prev = page;
            continue;
        }
        parts.push(start === prev ? `${start}` : `${start}-${prev}`);
        start = page;
        prev = page;
    }
    if (start !== undefined) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    return parts.join(", ");
}

/**
 * Convert document bytes to Markdown (uncached).
 *
 * @param {Uint8Array|Buffer} bytes raw file bytes
 * @param {string} [name] original file name, used only for logging and as the
 *   fallback when the bytes carry no signature
 * @returns {Promise<{ markdown: string, format: string, truncated: boolean }>}
 * @throws {DocumentParseError} with a stable `code` for every rejected case
 */
async function parseDocumentBytesUncached(bytes, name = "") {
    const size = bytes ? bytes.length : 0;

    if (!size) {
        throw new DocumentParseError("empty", "the file is empty");
    }
    if (size > MAX_DOCUMENT_BYTES) {
        throw new DocumentParseError(
            "tooLarge",
            `${Math.round(size / (1024 * 1024))} MB is larger than the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB document limit`
        );
    }

    const anydoc = await loadBinding().catch((error) => {
        throw new DocumentParseError(
            "parserUnavailable",
            `the local document converter failed to load (${error.message})`
        );
    });

    // Detect from the content, which is what makes a mislabeled file work.
    // Signature-less formats (CSV) get the text path and never reach here.
    const format = anydoc.formatFromBytes(bytes);
    if (!format) {
        throw new DocumentParseError(
            "unsupported",
            "unrecognized file content; it may be corrupted or a format anydoc cannot read"
        );
    }

    let markdown;
    try {
        markdown = await anydoc.toMarkdownBytes(bytes, format);
    } catch (error) {
        // anydoc rejects with a `code`, and for PDFs needing OCR it names the
        // pages. Nothing here leaves the machine.
        if (error.code === "needsOcr") {
            const pages = Array.isArray(error.pages) ? error.pages : [];
            const pageCount = error.pageCount || 0;
            const singular = pages.length === 1;
            const where = `${singular ? "page" : "pages"} ${formatPages(pages)} of ${pageCount}`;
            const listed = pages.length && pageCount
                ? singular
                    ? `${where} is a scanned image and needs OCR`
                    : `${where} are scanned images and need OCR`
                : "the pages needed OCR";
            throw new DocumentParseError("needsOcr", listed, { pages, pageCount });
        }
        throw new DocumentParseError(
            error.code || "malformed",
            error.message || "the document could not be converted"
        );
    }

    const truncated = markdown.length > MAX_MARKDOWN_CHARS;
    if (truncated) markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);

    if (!markdown.trim()) {
        throw new DocumentParseError("empty", "the document contained no readable text");
    }

    return { markdown, format, truncated };
}

/**
 * Convert document bytes to Markdown, cached by content hash.
 * Same contract as the uncached converter; failures are never cached.
 */
export async function parseDocumentBytes(bytes, name = "") {
    if (!bytes || !bytes.length) return parseDocumentBytesUncached(bytes, name);

    const key = createHash("sha1").update(bytes).digest("hex");
    let pending = parseCache.get(key);

    if (pending) {
        // Refresh recency (Map keeps insertion order).
        parseCache.delete(key);
        parseCache.set(key, pending);
        console.log(`[parse] cache hit ${name || "(unnamed)"}`);
        return pending;
    }

    const startedAt = Date.now();
    pending = parseDocumentBytesUncached(bytes, name).then(
        (result) => {
            console.log(`[parse] ${name || "(unnamed)"} converted in ${Date.now() - startedAt}ms`);
            return result;
        },
        (error) => {
            // Never cache failures: the converter may be booting or the file may be fixed.
            parseCache.delete(key);
            throw error;
        }
    );

    parseCache.set(key, pending);
    while (parseCache.size > PARSE_CACHE_MAX) {
        parseCache.delete(parseCache.keys().next().value);
    }
    return pending;
}
