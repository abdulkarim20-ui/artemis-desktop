/**
 * ============================================================================
 * RAG SERVICE END-TO-END TESTS
 * ============================================================================
 * These run the whole pipeline - bytes in, <retrieved_context> out - against
 * the fake embedding endpoint. Two things only a full-pipeline test can catch:
 *
 *   1. input_type has to be "passage" while indexing and "query" while
 *      searching. Each half passes its own unit test and the pipeline can still
 *      wire them the wrong way round.
 *   2. A real document has to survive conversion, chunking, embedding, storage
 *      and retrieval with its line numbers still pointing at the right text.
 *
 * Office conversion uses the same parseDocumentBytes the /api/parse route uses,
 * so a file that attaches successfully indexes successfully - or reports the
 * same honest reason why it cannot.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RagService, documentId } from "../ai-agent/rag/service.js";
import { parseDocumentBytes } from "../ai-agent/runtime/document-parser.js";
import { buildDocx, buildScannedPdf, buildTextPdf } from "./office-fixtures.mjs";
import { FAKE_DIMS, makeEmbeddingFetch, withTempRoot } from "./rag-fixtures.mjs";

const bytes = (buffer) => new Uint8Array(buffer);

const CODE_FILE = `export function calculateRevenue(rows) {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    return total.toFixed(2);
}

export function buildInvoice(customer, rows) {
    const subtotal = calculateRevenue(rows);
    const tax = Number(subtotal) * 0.19;
    return { customer, subtotal, tax, total: Number(subtotal) + tax };
}

/**
 * Reconciles a bank statement against issued invoices and reports the
 * differences it finds, keyed by invoice number.
 */
export function reconcileStatement(statement, invoices) {
    const unmatched = [];
    for (const entry of statement) {
        const invoice = invoices.find((item) => item.number === entry.reference);
        if (!invoice) unmatched.push(entry);
    }
    return unmatched;
}
`;

async function makeService(root, overrides = {}) {
    const stub = overrides.stub || makeEmbeddingFetch();
    const service = new RagService({
        apiKey: "nvapi-test-key-for-unit-tests-only",
        storageRoot: root,
        dimensions: FAKE_DIMS,
        fetchImpl: overrides.fetchImpl || stub.impl,
        parseDocument: parseDocumentBytes,
        options: overrides.options,
    });
    return { service, stub };
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

test("status() reports a configured model and its dimensions", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        const status = await service.status();

        assert.equal(status.enabled, true);
        assert.equal(status.configured, true);
        assert.equal(status.model, "nvidia:nemotron-3.5-embed-1b");
        assert.equal(status.dims, FAKE_DIMS);
        assert.equal(status.modelDims, 2048, "the model's real width should be visible next to the stored one");
        // The UI has to be able to tell the user their text leaves the machine.
        assert.equal(status.hosted, true);
        assert.equal(status.reason, null);
    });
});

test("status() explains a missing key instead of throwing", async () => {
    await withTempRoot(async (root) => {
        const saved = process.env.NVIDIA_API_KEY;
        delete process.env.NVIDIA_API_KEY;
        try {
            const stub = makeEmbeddingFetch();
            const service = new RagService({
                storageRoot: root,
                dimensions: FAKE_DIMS,
                fetchImpl: stub.impl,
                parseDocument: parseDocumentBytes,
            });

            const status = await service.status();
            assert.equal(status.configured, false);
            assert.equal(status.model, null);
            assert.match(status.reason, /NVIDIA_API_KEY/);
            assert.equal(stub.requestCount, 0);
        } finally {
            if (saved !== undefined) process.env.NVIDIA_API_KEY = saved;
        }
    });
});

test("ARTEMIS_RAG_DISABLED turns the whole subsystem off", async () => {
    await withTempRoot(async (root) => {
        process.env.ARTEMIS_RAG_DISABLED = "1";
        try {
            const { service, stub } = await makeService(root);

            assert.equal(service.disabled, true);
            const status = await service.status();
            assert.equal(status.enabled, false);
            assert.match(status.reason, /disabled/);

            await assert.rejects(
                () => service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" }),
                (error) => error.code === "disabled"
            );
            assert.equal(stub.requestCount, 0, "a disabled service must not embed anything");
        } finally {
            delete process.env.ARTEMIS_RAG_DISABLED;
        }
    });
});

test("a key added after startup works without a restart", async () => {
    await withTempRoot(async (root) => {
        const saved = process.env.NVIDIA_API_KEY;
        delete process.env.NVIDIA_API_KEY;
        try {
            const stub = makeEmbeddingFetch();
            const service = new RagService({
                storageRoot: root,
                dimensions: FAKE_DIMS,
                fetchImpl: stub.impl,
                parseDocument: parseDocumentBytes,
            });

            await assert.rejects(
                () => service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" }),
                (error) => error.code === "noApiKey"
            );

            // Initialization is cached as a promise and reset on failure, so
            // fixing the key is enough - no new service, no app restart.
            process.env.NVIDIA_API_KEY = "nvapi-added-later";
            const result = await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" });
            assert.equal(result.status, "indexed");
        } finally {
            if (saved !== undefined) process.env.NVIDIA_API_KEY = saved;
            else delete process.env.NVIDIA_API_KEY;
        }
    });
});

test("asking for more dimensions than the model produces is refused", async () => {
    await withTempRoot(async (root) => {
        const service = new RagService({
            apiKey: "nvapi-test-key",
            storageRoot: root,
            dimensions: 4096,
            fetchImpl: makeEmbeddingFetch().impl,
        });

        await assert.rejects(
            () => service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" }),
            (error) => {
                assert.equal(error.code, "badDimensions");
                assert.match(error.message, /produces 2048/);
                return true;
            }
        );
    });
});

/* ------------------------------------------------------------------ */
/* ingest + retrieve, end to end                                       */
/* ------------------------------------------------------------------ */

test("a code file is indexed with passage mode and found with query mode", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);

        const indexed = await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from(CODE_FILE),
            name: "src/billing.js",
        });

        assert.equal(indexed.status, "indexed");
        assert.equal(indexed.path, "src/billing.js");
        assert.equal(indexed.kind, "code");
        assert.equal(indexed.language, "javascript");
        assert.ok(indexed.chunks >= 1);
        assert.deepEqual(stub.modes, ["passage"], "indexing must use input_type=passage");

        const found = await service.retrieveContext({
            collection: "kb",
            query: "how does the bank statement reconciliation find unmatched entries?",
        });

        assert.deepEqual(stub.modes, ["passage", "query"], "searching must use input_type=query");
        assert.equal(found.skipped, null);
        assert.ok(found.hits >= 1, "the reconciliation function was not retrieved");
        assert.match(found.block, /^<retrieved_context /);
        assert.match(found.block, /reconcileStatement/);
        assert.match(found.block, /path="src\/billing\.js"/);
        assert.equal(found.sources[0].path, "src/billing.js");
        assert.equal(found.included[0].id, "S1");
        assert.equal(found.included[0].body, found.sources[0].body);
    });
});

test("retrieved line numbers point at the text they quote", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" });

        const found = await service.retrieveContext({
            collection: "kb",
            query: "how is the invoice tax total computed?",
        });

        assert.ok(found.sources.length > 0);
        const lines = CODE_FILE.split("\n");

        for (const source of found.sources) {
            assert.ok(source.startLine >= 1, "line numbers must be 1-based for citation");
            assert.ok(source.endLine <= lines.length, `endLine ${source.endLine} is past the end of the file`);
            assert.match(
                found.block,
                new RegExp(`lines="${source.startLine}-${source.endLine}"`),
                "the block cites a different range than the source list"
            );
        }
    });
});

test("a real .docx is converted, indexed and searchable by its contents", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);

        const indexed = await service.ingestFile({
            collection: "reports",
            bytes: bytes(buildDocx()),
            name: "quarterly.docx",
        });

        assert.equal(indexed.status, "indexed", JSON.stringify(indexed));
        assert.equal(indexed.kind, "markdown");
        assert.equal(indexed.language, "markdown", "converted text is markdown whatever the file was called");
        assert.equal(indexed.convertedFrom, "docx");
        assert.equal(indexed.truncated, false);

        const found = await service.retrieveContext({
            collection: "reports",
            query: "how much did revenue grow versus last year?",
        });

        assert.equal(found.skipped, null);
        assert.ok(found.hits >= 1);
        assert.match(found.block, /14 percent/);
        assert.match(found.block, /converted-from="docx"/);
        assert.equal(found.sources[0].convertedFrom, "docx");
        assert.deepEqual(stub.modes, ["passage", "query"]);
    });
});

test("a text PDF is indexed the same way", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        const indexed = await service.ingestFile({
            collection: "kb",
            bytes: bytes(buildTextPdf()),
            name: "invoice.pdf",
        });

        assert.equal(indexed.status, "indexed");
        assert.equal(indexed.convertedFrom, "pdf");

        const found = await service.retrieveContext({ collection: "kb", query: "what is the total due on the invoice?" });
        assert.match(found.block, /4200\.00 EUR/);
    });
});

/* ------------------------------------------------------------------ */
/* honest skips                                                        */
/* ------------------------------------------------------------------ */

test("a scanned PDF is reported as skipped, with the pages that need OCR", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);

        const result = await service.ingestFile({
            collection: "kb",
            bytes: bytes(buildScannedPdf()),
            name: "scan.pdf",
        });

        assert.equal(result.status, "skipped");
        assert.equal(result.code, "needsOcr");
        assert.deepEqual(result.pages, [1], "which pages failed is the only actionable part of this message");
        assert.equal(result.pageCount, 1);
        assert.match(result.skippedReason, /scanned image and needs OCR/);
        assert.equal(result.chunks, 0);
        assert.equal(stub.requestCount, 0, "nothing may be embedded for a file that produced no text");
    });
});

test("an image is reported as not indexed rather than silently accepted", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);

        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(64, 7),
        ]);
        const result = await service.ingestFile({ collection: "kb", bytes: png, name: "diagram.png" });

        assert.equal(result.status, "skipped");
        assert.equal(result.code, "imageNotIndexed");
        assert.match(result.skippedReason, /images are not indexed yet/);
        assert.equal(stub.requestCount, 0);
    });
});

test("binary, empty and whitespace-only files are each skipped with their own reason", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        const cases = [
            { name: "app.exe", bytes: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(500, 3)]), code: "binary" },
            { name: "empty.txt", bytes: Buffer.alloc(0), code: "empty" },
            { name: "blank.txt", bytes: Buffer.from("   \n\n\t\n"), code: "empty" },
            { name: "archive.zip", bytes: Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(300, 9)]), code: "binary" },
        ];

        for (const testCase of cases) {
            const result = await service.ingestFile({ collection: "kb", bytes: testCase.bytes, name: testCase.name });
            assert.equal(result.status, "skipped", `${testCase.name} should not be indexed`);
            assert.equal(result.code, testCase.code, `${testCase.name}: ${result.skippedReason}`);
            assert.ok(result.skippedReason, `${testCase.name} was skipped with no explanation`);
        }

        const stats = await service.collectionStats("kb");
        assert.equal(stats.documentCount, 0, "a skipped file must not appear in the collection");
    });
});

test("a document converter that is unavailable is reported, not worked around", async () => {
    await withTempRoot(async (root) => {
        const stub = makeEmbeddingFetch();
        const service = new RagService({
            apiKey: "nvapi-test-key",
            storageRoot: root,
            dimensions: FAKE_DIMS,
            fetchImpl: stub.impl,
            parseDocument: null,
        });

        const result = await service.ingestFile({ collection: "kb", bytes: bytes(buildDocx()), name: "quarterly.docx" });

        assert.equal(result.status, "skipped");
        assert.equal(result.code, "parserUnavailable");
        assert.match(result.skippedReason, /no document converter/);
    });
});

/* ------------------------------------------------------------------ */
/* idempotence                                                         */
/* ------------------------------------------------------------------ */

test("re-sending an unchanged file costs nothing", async () => {
    // The renderer attaches the same files to every message in a conversation,
    // so a repeat ingest must not re-embed and re-pay for the whole corpus.
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);
        const payload = { collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" };

        const first = await service.ingestFile(payload);
        const requestsAfterFirst = stub.requestCount;

        const second = await service.ingestFile(payload);
        assert.equal(second.status, "unchanged");
        assert.equal(second.docId, first.docId);
        assert.equal(second.chunks, first.chunks);
        assert.equal(stub.requestCount, requestsAfterFirst, "an unchanged file was embedded again");

        const stats = await service.collectionStats("kb");
        assert.equal(stats.documentCount, 1);
        assert.equal(stats.chunkCount, first.chunks, "the unchanged file was indexed twice");
    });
});

test("re-sending identical document bytes does not parse or embed again", async () => {
    // The stored hash is the hash of the raw bytes, so "unchanged" can be
    // decided before the converter runs - which is what makes a repeat attach
    // free even for a .docx, where conversion is the expensive part.
    await withTempRoot(async (root) => {
        let parseCalls = 0;
        const spyParser = async (buffer, name) => {
            parseCalls += 1;
            return parseDocumentBytes(buffer, name);
        };
        const stub = makeEmbeddingFetch();
        const service = new RagService({
            apiKey: "nvapi-test-key-for-unit-tests-only",
            storageRoot: root,
            dimensions: FAKE_DIMS,
            fetchImpl: stub.impl,
            parseDocument: spyParser,
        });

        const payload = { collection: "kb", bytes: bytes(buildDocx()), name: "quarterly.docx" };

        const first = await service.ingestFile(payload);
        assert.equal(first.status, "indexed");
        const requestsAfterFirst = stub.requestCount;

        const second = await service.ingestFile(payload);
        assert.equal(second.status, "unchanged");
        assert.equal(second.chunks, first.chunks);
        assert.equal(parseCalls, 1, "the document was converted again");
        assert.equal(stub.requestCount, requestsAfterFirst, "an unchanged file was embedded again");
    });
});

test("editing a file replaces its chunks instead of duplicating them", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        const first = await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from(CODE_FILE),
            name: "src/billing.js",
        });

        const edited = await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from(`${CODE_FILE}\nexport function auditTrail(entries) {\n    return entries.filter(Boolean);\n}\n`),
            name: "src/billing.js",
        });

        assert.equal(edited.status, "indexed");
        assert.equal(edited.replaced, true);
        assert.equal(edited.docId, first.docId, "the same path must map to the same document id");

        const stats = await service.collectionStats("kb");
        assert.equal(stats.documentCount, 1);
        assert.equal(stats.chunkCount, edited.chunks, "the previous version is still in the index");
    });
});

test("the same path in two collections does not collide", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        await service.ingestFile({ collection: "alpha", bytes: Buffer.from(CODE_FILE), name: "shared.js" });
        await service.ingestFile({ collection: "beta", bytes: Buffer.from("// beta only content about widgets\n"), name: "shared.js" });

        const fromAlpha = await service.retrieveContext({ collection: "alpha", query: "how is revenue calculated from rows?" });
        assert.match(fromAlpha.block, /calculateRevenue/);

        const fromBeta = await service.retrieveContext({ collection: "beta", query: "how is revenue calculated from rows?" });
        assert.ok(!fromBeta.block.includes("calculateRevenue"), "collections are leaking into each other");

        assert.equal(documentId("shared.js"), documentId("shared.js"), "the id must be stable for the same path");
    });
});

test("a conversation-scoped collection id with a slash works end to end", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        const indexed = await service.ingestFile({
            collection: "conversations/42",
            bytes: Buffer.from(CODE_FILE),
            name: "src/billing.js",
        });
        assert.equal(indexed.status, "indexed");

        const found = await service.retrieveContext({
            collection: "conversations/42",
            query: "how does the reconciliation match statement entries to invoices?",
        });

        assert.equal(found.skipped, null, `slash collection was not searched: ${found.skipped}`);
        assert.ok(found.hits >= 1);
        assert.match(found.block, /collection="conversations-42"/, "the block should name the sanitized collection");
    });
});

/* ------------------------------------------------------------------ */
/* retrieval honesty                                                   */
/* ------------------------------------------------------------------ */

test("searching an empty knowledge base returns an explanatory block, not an error", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);

        const found = await service.retrieveContext({ collection: "nothing-here", query: "any question at all" });

        assert.equal(found.hits, 0);
        assert.match(found.block, /status="empty"/);
        assert.match(found.block, /no indexed files yet/);
        assert.match(found.skipped, /no indexed files yet/);
        assert.equal(stub.requestCount, 0);
    });
});

test("the block respects the budget the caller has left", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);

        // A corpus large enough that retrieval has choices to make.
        for (let i = 0; i < 6; i += 1) {
            const body = Array.from({ length: 60 }, (_, n) => `Topic ${i} line ${n} discussing deployment release pipeline behaviour.`);
            await service.ingestFile({
                collection: "kb",
                bytes: Buffer.from(body.join("\n")),
                name: `docs/topic${i}.md`,
            });
        }

        const tight = await service.retrieveContext({
            collection: "kb",
            query: "what does the deployment release pipeline do?",
            budgetChars: 2500,
        });

        assert.ok(tight.block.length <= 2500, `block is ${tight.block.length} chars over a 2500 budget`);
        assert.ok(tight.hits >= 1);
    });
});

test("the block lists which files the knowledge base holds", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from("# Networking\n\nThe gateway retries failed uploads three times before giving up.\n"),
            name: "docs/network.md",
        });
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" });

        const found = await service.retrieveContext({
            collection: "kb",
            query: "how many times does the gateway retry uploads?",
        });

        // The model needs to know what was searched so it can say so when a
        // fact is not found, instead of guessing that a file exists.
        assert.match(found.block, /<kb_files>/);
        assert.ok(found.block.includes("docs/network.md"));
        assert.ok(found.block.includes("src/billing.js"));
    });
});

test("an overview query returns whole-document coverage without an embedding call", async () => {
    await withTempRoot(async (root) => {
        const { service, stub } = await makeService(root);
        await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from("# Networking\n\nThe gateway retries failed uploads three times before giving up.\n"),
            name: "docs/network.md",
        });
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" });

        const requestsBefore = stub.requestCount;
        const found = await service.retrieveContext({ collection: "kb", query: "summarize the document" });

        assert.match(found.block, /mode="overview"/);
        assert.match(found.block, /sampled="false"/, "two small files must not be marked as sampled");
        assert.ok(found.hits >= 1);
        assert.equal(stub.requestCount, requestsBefore, "the overview pass made an embedding request");
    });
});

test("a scoped query that finds nothing falls back to the whole collection", async () => {
    await withTempRoot(async (root) => {
        // A floor no real cosine can clear: the scoped search must come back
        // empty through scoring, not through luck with the fake embeddings.
        // The corpus has to exceed 40 chunks, because a smaller knowledge base
        // always returns its best hit (tiny-corpus fallback) and could never
        // demonstrate the service-level fallback.
        const { service } = await makeService(root, { options: { minScore: 0.9 } });
        await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from("# Networking\n\nThe gateway retries failed uploads three times before giving up.\n"),
            name: "docs/network.md",
        });
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" });
        for (let i = 0; i < 5; i += 1) {
            const filler = Array.from({ length: 40 }, (_, n) => `Topic ${i} filler ${n} ${"x".repeat(900)}`);
            await service.ingestFile({ collection: "kb", bytes: Buffer.from(filler.join("\n")), name: `docs/filler${i}.md` });
        }

        const found = await service.retrieveContext({
            collection: "kb",
            query: "in the billing doc, how many times does the gateway retry uploads?",
        });

        // "billing" scopes the search to billing.js, which cannot answer it.
        // Hiding the rest of the corpus on a guess would turn this into a
        // false "not found", so the service must search everything instead.
        assert.ok(found.hits >= 1, "the fallback search found nothing at all");
        assert.match(found.block, /gateway retries/);
        assert.ok(!found.block.includes("calculateRevenue"), "the named-but-irrelevant file answered instead");
    });
});

/* ------------------------------------------------------------------ */
/* collection management                                               */
/* ------------------------------------------------------------------ */

test("listCollections flags a collection embedded with a different model", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" });

        const collections = await service.listCollections();
        assert.equal(collections.length, 1);
        assert.equal(collections[0].id, "kb");
        assert.equal(collections[0].matchesConfiguredModel, true);
        assert.equal(collections[0].dims, FAKE_DIMS);
    });
});

test("removeDocument drops one file and leaves the rest searchable", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "src/billing.js" });
        await service.ingestFile({
            collection: "kb",
            bytes: Buffer.from("# Networking\n\nThe gateway retries failed uploads three times before giving up.\n"),
            name: "docs/network.md",
        });

        const removed = await service.removeDocument({ collection: "kb", path: "src/billing.js" });
        assert.equal(removed.ok, true);
        assert.equal(removed.docId, documentId("src/billing.js"));

        const stats = await service.collectionStats("kb");
        assert.equal(stats.documentCount, 1);
        assert.deepEqual(stats.documents.map((doc) => doc.path), ["docs/network.md"]);

        const found = await service.retrieveContext({ collection: "kb", query: "how many times does the gateway retry uploads?" });
        assert.match(found.block, /gateway retries/);
        assert.ok(!found.block.includes("calculateRevenue"), "the removed file is still being retrieved");

        assert.equal((await service.removeDocument({ collection: "kb", path: "never-indexed.js" })).ok, false);
    });
});

test("deleteCollection removes it entirely", async () => {
    await withTempRoot(async (root) => {
        const { service } = await makeService(root);
        await service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" });

        assert.deepEqual(await service.deleteCollection("kb"), { ok: true });
        assert.deepEqual(await service.listCollections(), []);

        const found = await service.retrieveContext({ collection: "kb", query: "how is revenue calculated?" });
        assert.match(found.block, /status="empty"/);
    });
});

test("an embedding failure is reported as a RagError and leaves the collection intact", async () => {
    await withTempRoot(async (root) => {
        const failing = makeEmbeddingFetch({ status: 401, message: "invalid api key" });
        const { service } = await makeService(root, { stub: failing });

        await assert.rejects(
            () => service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" }),
            (error) => {
                assert.equal(error.name, "RagError");
                assert.equal(error.code, "unauthorized");
                assert.match(error.message, /a\.js/, "the file that failed should be named");
                return true;
            }
        );

        const stats = await service.collectionStats("kb");
        assert.equal(stats.chunkCount, 0, "a failed ingest wrote a partial document");
        assert.equal(stats.documentCount, 0);
    });
});

test("a rate-limited endpoint is reported as such, not as a generic failure", async () => {
    await withTempRoot(async (root) => {
        const limited = makeEmbeddingFetch({ status: 429, message: "rate limit exceeded" });
        const { service } = await makeService(root, { stub: limited });

        await assert.rejects(
            () => service.ingestFile({ collection: "kb", bytes: Buffer.from(CODE_FILE), name: "a.js" }),
            (error) => {
                assert.equal(error.code, "rateLimited");
                assert.equal(error.status, 429);
                return true;
            }
        );
    });
});
