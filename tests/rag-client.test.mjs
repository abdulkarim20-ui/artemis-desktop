/**
 * Tests for renderer/js/ai/rag-client.js.
 *
 * This module is the only thing that talks to /api/rag/* from the renderer, and
 * most of its behaviour is about NOT breaking a chat that already works: every
 * per-file problem has to come back as data, never as an exception that cancels
 * the message. The tests below pin that contract, plus two details that fail
 * silently rather than loudly:
 *
 *   - the request content type. The route is mounted with
 *     `express.raw({ type: 'application/octet-stream' })`, so any other value
 *     leaves req.body as `{}` on the server and comes back as "the file is
 *     empty" - a correct request producing a nonsense answer.
 *   - the collection id charset. makeCollectionId() feeds sanitizeCollectionId()
 *     on the server, which rewrites characters it does not allow. An id that
 *     gets rewritten would be stored under one name and searched under another.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    deleteCollection,
    deleteDocument,
    describeIngestResults,
    getCollection,
    getRagStatus,
    indexableFiles,
    ingestFile,
    ingestFiles,
    listCollections,
    makeCollectionId,
    queryCollection,
    RAG_UNAVAILABLE_CODES,
    RagClientError,
} from "../renderer/js/ai/rag-client.js";
import { MAX_DOCUMENT_BYTES } from "../shared/document-formats.js";
import { sanitizeCollectionId } from "../ai-agent/rag/vector-store.js";

const BASE = "http://127.0.0.1:3000";

/** A File stand-in. ingestFile only needs .name and .arrayBuffer(). */
function fakeFile(name, bytes) {
    const buffer = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    return {
        name,
        size: buffer.byteLength,
        type: "",
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
}

function jsonResponse(body, init = {}) {
    return {
        ok: init.status === undefined || (init.status >= 200 && init.status < 300),
        status: init.status ?? 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function textResponse(text, status) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { throw new SyntaxError("not json"); },
        text: async () => text,
    };
}

/**
 * Install a stub global fetch that records every request and replays `next`.
 * Returns the recorder; the stub is removed via t.after.
 *
 * Restores to the real fetch captured at module load rather than to whatever was
 * installed when this was called. Tests that stub twice (the unavailable-code
 * loop) would otherwise unwind in registration order and leak a stub.
 */
const REAL_FETCH = globalThis.fetch;

function stubFetch(t, next) {
    const calls = [];

    globalThis.fetch = async (url, options = {}) => {
        if (options.signal?.aborted) {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            throw error;
        }
        const call = { url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body };
        calls.push(call);
        return next(call, calls.length);
    };

    t.after(() => { globalThis.fetch = REAL_FETCH; });
    return calls;
}

/* ------------------------------------------------------------------ */
/* collection identity                                                 */
/* ------------------------------------------------------------------ */

test("a generated collection id survives the server's sanitizer unchanged", () => {
    // The cross-module invariant. sanitizeCollectionId replaces anything outside
    // [A-Za-z0-9._-] with '-', so an id containing e.g. ':' would be stored under
    // a different name than the renderer searches for - an empty knowledge base
    // with no error anywhere.
    for (let i = 0; i < 500; i += 1) {
        const id = makeCollectionId();
        assert.equal(sanitizeCollectionId(id), id, `${id} would be rewritten by the server`);
    }
});

test("a custom prefix also survives the sanitizer", () => {
    for (const prefix of ["conv", "kb", "docs-2026", "x"]) {
        const id = makeCollectionId(prefix);
        assert.ok(id.startsWith(`${prefix}-`), `${id} does not start with ${prefix}`);
        assert.equal(sanitizeCollectionId(id), id);
    }
});

test("generated ids are unique", () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(makeCollectionId());
    assert.equal(seen.size, 5000, "makeCollectionId repeated an id, so two conversations would share an index");
});

/* ------------------------------------------------------------------ */
/* which attachments get uploaded                                      */
/* ------------------------------------------------------------------ */

/** indexableFiles only reads name/type/webkitRelativePath, so plain objects do. */
const named = (name, type = "") => ({ name, type });

const picked = (files) => indexableFiles(files).map((f) => f.name);

test("documents are uploaded even though they are binary on the inside", () => {
    // The ordering matters: .docx and .pdf are both binary containers, and a
    // binary check that ran first would drop every document the user attached.
    assert.deepEqual(
        picked([named("report.docx"), named("scan.pdf"), named("slides.pptx"), named("legacy.doc")]),
        ["report.docx", "scan.pdf", "slides.pptx", "legacy.doc"]
    );
});

test("images are not uploaded", () => {
    assert.deepEqual(
        picked([named("shot.png"), named("photo.jpg"), named("icon.gif"), named("a.js")]),
        ["a.js"]
    );
});

test("an image with an unrecognised extension is still caught by its mime type", () => {
    // Drag-and-drop from some sources gives a blob with a generic name. The
    // extension check alone would upload it and the agent would skip it anyway.
    assert.deepEqual(picked([named("blob", "image/png"), named("a.js")]), ["a.js"]);
});

test("archives and executables are not uploaded", () => {
    assert.deepEqual(
        picked([named("bundle.zip"), named("app.exe"), named("lib.tar.gz"), named("font.woff2"), named("a.js")]),
        ["a.js"]
    );
});

test("code, text and unknown files are uploaded", () => {
    // Unknown has to default to included: an extension-less config file or an
    // unusual source extension is exactly the kind of thing worth indexing, and
    // the agent's own classifier is better placed to reject it than a stricter
    // second guess here.
    assert.deepEqual(
        picked([named("main.py"), named("notes.md"), named("data.csv"), named("Dockerfile"), named("config")]),
        ["main.py", "notes.md", "data.csv", "Dockerfile", "config"]
    );
});

test("a dropped folder is classified by the file, not by a directory name", () => {
    const files = [
        { name: "README", webkitRelativePath: "my.project/src/app.js" },
        { name: "logo.png", webkitRelativePath: "my.project/assets/logo.png" },
    ];

    // webkitRelativePath wins when present, and a dot inside a directory name
    // must not be mistaken for the file's extension.
    assert.deepEqual(indexableFiles(files).map((f) => f.webkitRelativePath), ["my.project/src/app.js"]);
});

test("indexableFiles tolerates missing input and preserves order", () => {
    assert.deepEqual(indexableFiles(), []);
    assert.deepEqual(indexableFiles(null), []);
    assert.deepEqual(indexableFiles([]), []);

    const files = [named("c.js"), named("a.js"), named("b.js")];
    assert.deepEqual(picked(files), ["c.js", "a.js", "b.js"], "reordering would desync the progress count");
});

/* ------------------------------------------------------------------ */
/* ingestFile                                                          */
/* ------------------------------------------------------------------ */

test("ingestFile posts raw bytes as application/octet-stream", async (t) => {
    // The single most important assertion in this file. A JSON content type here
    // does not fail - it succeeds with an empty body and reports "the file is
    // empty" for a file that has content.
    const calls = stubFetch(t, () => jsonResponse({ status: "indexed", path: "a.js", chunks: 3 }));

    const result = await ingestFile({ collection: "kb", file: fakeFile("a.js", "const a = 1;") });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "application/octet-stream");
    assert.ok(calls[0].body instanceof Uint8Array, "the body must stay binary, not be stringified");
    assert.equal(new TextDecoder().decode(calls[0].body), "const a = 1;");
    assert.equal(result.status, "indexed");
});

test("ingestFile puts the name and collection in the query string", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ status: "indexed", path: "p", chunks: 1 }));

    await ingestFile({ collection: "conv-1", file: fakeFile("my report.docx", "x") });

    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/rag/documents");
    assert.equal(url.searchParams.get("collection"), "conv-1");
    // Encoded, not interpolated: a filename with a space, '&' or '#' would
    // otherwise truncate the query and silently index into the wrong collection.
    // (URLSearchParams writes a space as '+', which is why this checks for the
    // absence of the raw character rather than for a specific escape.)
    assert.equal(url.searchParams.get("name"), "my report.docx");
    assert.ok(!/\s/.test(calls[0].url), "a raw space reached the URL");

    await ingestFile({ collection: "a&b", file: fakeFile("x#1?.js", "y") });
    const tricky = new URL(calls[1].url);
    assert.equal(tricky.searchParams.get("collection"), "a&b", "'&' broke the query string");
    assert.equal(tricky.searchParams.get("name"), "x#1?.js", "'#' truncated the URL");
});

test("ingestFile accepts raw bytes without a File", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ status: "indexed", path: "raw.bin", chunks: 2 }));

    const result = await ingestFile({
        collection: "kb",
        name: "raw.bin",
        bytes: new TextEncoder().encode("raw payload"),
    });

    assert.equal(result.chunks, 2);
    assert.equal(new TextDecoder().decode(calls[0].body), "raw payload");
});

test("an empty file is reported without making a request", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ status: "indexed" }));

    const result = await ingestFile({ collection: "kb", file: fakeFile("empty.txt", "") });

    assert.equal(calls.length, 0, "a zero-byte upload would come back as a confusing server error");
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "empty");
    assert.equal(result.path, "empty.txt");
});

test("an oversized file is reported without making a request", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ status: "indexed" }));
    const huge = new Uint8Array(MAX_DOCUMENT_BYTES + 1);

    const result = await ingestFile({ collection: "kb", name: "huge.pdf", bytes: huge });

    assert.equal(calls.length, 0, "uploading past the cap only earns a bare 413 from the body parser");
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "tooLarge");
    assert.match(result.skippedReason, /25\.0 MB/, "the note has to name the real limit");
    assert.match(result.skippedReason, /huge\.pdf/, "the note has to name the file");
});

test("ingestFile refuses to guess what to upload", async () => {
    await assert.rejects(
        () => ingestFile({ collection: "kb" }),
        (error) => error instanceof RagClientError && error.code === "badRequest"
    );
});

test("a trailing slash on the base url does not double up in the path", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ enabled: true }));

    await getRagStatus({ baseUrl: `${BASE}/` });

    assert.equal(calls[0].url, `${BASE}/api/rag/status`);
});

/* ------------------------------------------------------------------ */
/* error translation                                                   */
/* ------------------------------------------------------------------ */

test("a JSON error body keeps the server's code", async (t) => {
    stubFetch(t, () => textResponse(JSON.stringify({ code: "noApiKey", message: "NVIDIA_API_KEY is not set" }), 503));

    await assert.rejects(
        () => getRagStatus({}),
        (error) => error instanceof RagClientError
            && error.code === "noApiKey"
            && error.status === 503
            && error.message === "NVIDIA_API_KEY is not set"
    );
});

test("an HTML error body falls back to a truncated string", async (t) => {
    // A proxy or a crashed agent answers with HTML. Without this branch the
    // caller would see "HTTP 502" and nothing about the actual body.
    stubFetch(t, () => textResponse("<html><body>Bad Gateway</body></html>", 502));

    await assert.rejects(
        () => getRagStatus({}),
        (error) => error.code === "http502" && /Bad Gateway/.test(error.message)
    );
});

test("an empty error body still yields a code", async (t) => {
    stubFetch(t, () => ({ ok: false, status: 500, text: async () => "" }));

    await assert.rejects(() => getRagStatus({}), (error) => error.code === "http500");
});

test("a network failure becomes a RagClientError rather than a raw TypeError", async (t) => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    t.after(() => { globalThis.fetch = REAL_FETCH; });

    await assert.rejects(
        () => getRagStatus({}),
        (error) => error instanceof RagClientError && error.code === "network"
    );
});

test("an abort is rethrown as an AbortError, not wrapped", async (t) => {
    stubFetch(t, () => jsonResponse({ enabled: true }));
    const controller = new AbortController();
    controller.abort();

    // The chat view distinguishes cancellation from failure by error.name.
    // Wrapping it here would turn "the user pressed stop" into an error bubble.
    await assert.rejects(
        () => getRagStatus({ signal: controller.signal }),
        (error) => error.name === "AbortError"
    );
});

/* ------------------------------------------------------------------ */
/* ingestFiles                                                         */
/* ------------------------------------------------------------------ */

test("ingestFiles uploads several files at once, up to the cap", async (t) => {
    // Deterministic, not timing-based: the first three uploads are held open
    // until the test releases them. A sequential client would never have
    // started the later files while the early ones were still in flight, and
    // an uncapped client would have uploaded all five immediately.
    const gates = new Map();
    const gateFor = (name) => new Promise((resolve) => gates.set(name, resolve));
    const release = (name) => gates.get(name)?.();

    const calls = stubFetch(t, (call) => {
        const name = new URL(call.url).searchParams.get("name");
        // e.js is the only instant answer, so a released slot visibly picks up
        // exactly one held upload per release.
        if (name !== "e.js") {
            return gateFor(name).then(() => jsonResponse({ status: "indexed", path: name, chunks: 1 }));
        }
        return jsonResponse({ status: "indexed", path: name, chunks: 1 });
    });

    const pending = ingestFiles({
        collection: "kb",
        files: [
            fakeFile("a.js", "1"),
            fakeFile("b.js", "2"),
            fakeFile("c.js", "3"),
            fakeFile("d.js", "4"),
            fakeFile("e.js", "5"),
        ],
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 3, "only the capped number of uploads should be in flight");

    release("a.js");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 4, "a finished slot should pick up the next file");

    release("b.js");
    release("c.js");
    release("d.js");
    const summary = await pending;
    assert.equal(calls.length, 5);
    assert.equal(summary.indexed, 5);
});

test("ingestFiles counts indexed, unchanged and skipped separately", async (t) => {
    const byName = {
        "new.js": { status: "indexed", path: "new.js", chunks: 5 },
        "same.js": { status: "unchanged", path: "same.js", chunks: 2 },
        "pic.png": { status: "skipped", path: "pic.png", code: "imageNotIndexed", skippedReason: "images are not indexed" },
    };

    stubFetch(t, (call) => {
        const name = new URL(call.url).searchParams.get("name");
        return jsonResponse(byName[name]);
    });

    const summary = await ingestFiles({
        collection: "kb",
        files: [fakeFile("new.js", "a"), fakeFile("same.js", "b"), fakeFile("pic.png", "c")],
    });

    assert.equal(summary.indexed, 1);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.skipped, 1);
    // `unchanged` contributes its chunks too: those chunks are already in the
    // collection and are exactly as searchable as freshly written ones.
    assert.equal(summary.chunks, 7);
    assert.equal(summary.results.length, 3);
});

test("ingestFiles reports progress for every file", async (t) => {
    stubFetch(t, (call) => {
        const name = new URL(call.url).searchParams.get("name");
        return jsonResponse({ status: "indexed", path: name, chunks: 1 });
    });

    const seen = [];
    await ingestFiles({
        collection: "kb",
        files: [fakeFile("a.js", "1"), fakeFile("b.js", "2")],
        onProgress: (done, total, result) => seen.push([done, total, result.path]),
    });

    // `done`/`total` drive the "Indexing file N of M" status line, so they have
    // to be 1-based and reach the last file - an off-by-one would leave the UI
    // stuck on "2 of 3" for a batch that already finished.
    assert.deepEqual(seen, [[1, 2, "a.js"], [2, 2, "b.js"]]);
});

test("a per-file failure becomes a result, not an exception", async (t) => {
    stubFetch(t, (call) => {
        const name = new URL(call.url).searchParams.get("name");
        if (name === "bad.pdf") return textResponse(JSON.stringify({ code: "needsOcr", message: "scanned PDF" }), 422);
        return jsonResponse({ status: "indexed", path: name, chunks: 4 });
    });

    const summary = await ingestFiles({
        collection: "kb",
        files: [fakeFile("bad.pdf", "x"), fakeFile("good.js", "y")],
    });

    // The whole point: one unreadable attachment must not stop the others, and
    // must not cancel the message the user already wrote.
    assert.equal(summary.indexed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.results[0].status, "skipped");
    assert.equal(summary.results[0].code, "needsOcr");
    assert.equal(summary.results[0].skippedReason, "scanned PDF");
    assert.equal(summary.results[1].status, "indexed");
});

test("a whole-subsystem failure stops the batch instead of repeating itself", async (t) => {
    const calls = stubFetch(t, () => textResponse(JSON.stringify({ code: "noApiKey", message: "no key" }), 503));

    await assert.rejects(
        () => ingestFiles({
            collection: "kb",
            files: ["a", "b", "c", "d", "e", "f"].map((n) => fakeFile(`${n}.js`, n)),
        }),
        (error) => error.code === "noApiKey"
    );

    // Only the uploads already in flight when the first failure landed (the
    // concurrency cap) happen; no new one is claimed after it. Six identical
    // "no API key" notes would bury the one that matters.
    assert.equal(calls.length, 3);
});

test("every unavailable code is treated as fatal to the batch", async (t) => {
    for (const code of RAG_UNAVAILABLE_CODES) {
        const calls = stubFetch(t, () => textResponse(JSON.stringify({ code, message: code }), 503));

        await assert.rejects(
            () => ingestFiles({ collection: "kb", files: [fakeFile("a.js", "1"), fakeFile("b.js", "2")] }),
            (error) => error.code === code,
            `${code} should have stopped the batch`
        );
        // Both files were already in flight when the first failure landed; the
        // guarantee is that nothing NEW starts after it.
        assert.equal(calls.length, 2, `${code} did not stop the batch`);
    }
});

test("a transient failure does not stop the batch", async (t) => {
    // Contrast with the test above: 502 is worth retrying on the next message,
    // so the remaining files still get their chance.
    const calls = stubFetch(t, (call) => {
        const name = new URL(call.url).searchParams.get("name");
        if (name === "a.js") return textResponse(JSON.stringify({ code: "serverError", message: "upstream" }), 502);
        return jsonResponse({ status: "indexed", path: name, chunks: 1 });
    });

    const summary = await ingestFiles({
        collection: "kb",
        files: [fakeFile("a.js", "1"), fakeFile("b.js", "2")],
    });

    assert.equal(calls.length, 2);
    assert.equal(summary.indexed, 1);
    assert.equal(summary.skipped, 1);
});

test("ingestFiles stops at an aborted signal", async (t) => {
    const controller = new AbortController();
    const calls = stubFetch(t, () => {
        controller.abort();
        return jsonResponse({ status: "indexed", path: "a.js", chunks: 1 });
    });

    const summary = await ingestFiles({
        collection: "kb",
        files: [fakeFile("a.js", "1"), fakeFile("b.js", "2"), fakeFile("c.js", "3")],
        signal: controller.signal,
    });

    assert.equal(calls.length, 1, "the batch kept uploading after the user cancelled");
    assert.equal(summary.results.length, 1);
});

test("ingestFiles rethrows a mid-batch abort", async (t) => {
    const controller = new AbortController();
    stubFetch(t, () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
    });

    await assert.rejects(
        () => ingestFiles({ collection: "kb", files: [fakeFile("a.js", "1")], signal: controller.signal }),
        (error) => error.name === "AbortError"
    );
});

test("an empty batch resolves without any request", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({}));

    const summary = await ingestFiles({ collection: "kb", files: [] });

    assert.equal(calls.length, 0);
    assert.deepEqual(summary, { results: [], indexed: 0, unchanged: 0, skipped: 0, chunks: 0 });
});

/* ------------------------------------------------------------------ */
/* describeIngestResults                                               */
/* ------------------------------------------------------------------ */

test("ingest notes are plain text", () => {
    // ChatManager.showFileNotes() escapes its input and inserts it as text, so
    // markdown here would reach the user as literal asterisks.
    const notes = describeIngestResults({
        results: [{ status: "skipped", path: "scan.pdf", skippedReason: "the PDF has no text layer" }],
    });

    assert.deepEqual(notes, ["scan.pdf: not indexed, the PDF has no text layer"]);
    assert.ok(!notes[0].includes("*"), "markdown would render literally in a plain-text sink");
    assert.ok(!notes[0].includes("<"), "html would be escaped into visible entities");
});

test("ingest notes only cover failures", () => {
    // Successes are shown by the sources panel under the answer. Repeating them
    // inside a box headed "Part of this was not sent" would contradict it.
    const notes = describeIngestResults({
        results: [
            { status: "indexed", path: "a.js", chunks: 3 },
            { status: "unchanged", path: "b.js", chunks: 3 },
            { status: "skipped", path: "c.png", skippedReason: "images are not indexed" },
        ],
    });

    assert.deepEqual(notes, ["c.png: not indexed, images are not indexed"]);
});

test("ingest notes survive missing fields", () => {
    assert.deepEqual(describeIngestResults(), []);
    assert.deepEqual(describeIngestResults({}), []);
    assert.deepEqual(describeIngestResults({ results: [{ status: "indexed" }] }), []);

    // A failure with no path or reason still has to say something, because the
    // alternative is a file silently missing from the knowledge base.
    assert.deepEqual(
        describeIngestResults({ results: [{ status: "skipped" }] }),
        ["attachment: not indexed, unknown reason"]
    );
    assert.deepEqual(
        describeIngestResults({ results: [{ status: "skipped", name: "x.bin" }] }),
        ["x.bin: not indexed, unknown reason"]
    );
});

/* ------------------------------------------------------------------ */
/* read paths                                                          */
/* ------------------------------------------------------------------ */

test("getRagStatus returns the payload the UI needs for the privacy notice", async (t) => {
    const payload = {
        enabled: true,
        configured: true,
        model: "nvidia/nemotron-3.5-embed-1b",
        dims: 2048,
        hosted: true,
        reason: null,
        storageRoot: "/tmp/rag",
    };
    stubFetch(t, () => jsonResponse(payload));

    assert.deepEqual(await getRagStatus({}), payload);
});

test("listCollections tolerates a payload with no collections key", async (t) => {
    stubFetch(t, () => jsonResponse({}));
    assert.deepEqual(await listCollections({}), []);
});

test("collection and document ids are percent-encoded in the path and query", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ collection: { id: "kb" } }));

    await getCollection("kb/one", {});
    assert.equal(new URL(calls[0].url).pathname, "/api/rag/collections/kb%2Fone");

    await deleteCollection("kb one", {});
    assert.equal(calls[1].method, "DELETE");
    assert.equal(new URL(calls[1].url).pathname, "/api/rag/collections/kb%20one");

    await deleteDocument({ collection: "kb", path: "docs/a b.pdf" });
    assert.equal(calls[2].method, "DELETE");
    assert.equal(new URL(calls[2].url).searchParams.get("path"), "docs/a b.pdf");
});

test("queryCollection posts the search as JSON", async (t) => {
    const calls = stubFetch(t, () => jsonResponse({ hits: [] }));

    await queryCollection({ collection: "kb", query: "how does billing work?", topK: 5 });

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].body), { collection: "kb", query: "how does billing work?", topK: 5 });
});
