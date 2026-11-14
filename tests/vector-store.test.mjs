/**
 * ============================================================================
 * VECTOR STORE TESTS
 * ============================================================================
 * The store is the only part of the RAG pipeline whose mistakes survive a
 * restart, so most of these tests write, throw the instance away, and read the
 * directory back with a fresh one. In-memory correctness is the easy half.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { VectorStore, VectorStoreError, sanitizeCollectionId } from "../ai-agent/rag/vector-store.js";
import { RAG_DEFAULTS } from "../ai-agent/rag/config.js";
import { FAKE_DIMS, hashEmbed, withTempRoot } from "./rag-fixtures.mjs";

const MODEL = "nvidia/nemotron-3.5-embed-1b";

/** A document whose vectors come from the hashing embedder, so search is meaningful. */
function makeDoc(docId, filePath, texts, dims = FAKE_DIMS) {
    return {
        docId,
        path: filePath,
        hash: `hash-${docId}`,
        kind: "text",
        language: "text",
        chunks: texts.map((text, seq) => ({
            seq,
            kind: "text",
            path: filePath,
            language: "text",
            convertedFrom: "",
            heading: "",
            symbol: "",
            startLine: seq + 1,
            endLine: seq + 1,
            text,
        })),
        vectors: texts.map((text) => hashEmbed(text, dims)),
    };
}

async function openCollection(root, id = "test", descriptor = {}) {
    const store = new VectorStore(root);
    const collection = await store.open(id, { model: MODEL, dims: FAKE_DIMS, ...descriptor });
    return { store, collection };
}

/** Read the same directory back through a brand new store, as a restart would. */
async function reopen(root, id = "test", descriptor = {}) {
    const { collection } = await openCollection(root, id, descriptor);
    return collection;
}

const readMeta = async (root, id = "test") =>
    JSON.parse(await fs.readFile(path.join(root, sanitizeCollectionId(id), "meta.json"), "utf8"));

test("collection ids are sanitized before they become directory names", () => {
    assert.equal(sanitizeCollectionId("conv/1"), "conv-1");
    assert.equal(sanitizeCollectionId("  spaced name  "), "spaced-name");
    assert.equal(sanitizeCollectionId("---x---"), "x");
    assert.equal(sanitizeCollectionId("a".repeat(200)).length, 80);

    for (const bad of ["", "   ", "../escape", "..", "///"]) {
        assert.throws(
            () => sanitizeCollectionId(bad),
            (error) => error instanceof VectorStoreError && error.code === "badCollectionId",
            `${JSON.stringify(bad)} should be rejected`
        );
    }
});

test("a stored chunk is found again by its own wording", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "notes.txt", [
            "quarterly revenue by region for fiscal year",
            "the office coffee machine is broken again",
        ]));

        const hits = collection.search(hashEmbed("what was the quarterly revenue by region?"), { topK: 2 });

        assert.ok(hits.length >= 1, "nothing came back");
        assert.equal(hits[0].text, "quarterly revenue by region for fiscal year");
        assert.equal(hits[0].path, "notes.txt");
        assert.ok(hits[0].score > 0.3, `score ${hits[0].score} is too low to be a real match`);
    });
});

test("chunks and vectors survive a restart byte for byte", async () => {
    await withTempRoot(async (root) => {
        const texts = ["alpha content about servers", "beta content about networks", "gamma content about storage"];
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", texts));

        const before = collection.chunks.map((chunk) => chunk.text);
        const reloaded = await reopen(root);

        assert.deepEqual(reloaded.chunks.map((chunk) => chunk.text), before);
        assert.equal(reloaded.chunks.length, 3);

        // The vectors themselves, not just their count.
        for (let row = 0; row < texts.length; row += 1) {
            const stored = reloaded.vectors.subarray(row * FAKE_DIMS, (row + 1) * FAKE_DIMS);
            const expected = hashEmbed(texts[row]);
            for (let i = 0; i < FAKE_DIMS; i += 1) {
                assert.ok(Math.abs(stored[i] - expected[i]) < 1e-6, `row ${row} dim ${i} changed on disk`);
            }
        }

        // And search still works after the reload, which is the point.
        const hits = reloaded.search(hashEmbed("content about networks"), { topK: 1 });
        assert.equal(hits[0].text, "beta content about networks");
    });
});

test("vectors.bin is exactly dims Float32 values per row", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["one", "two", "three"]));

        const buffer = await fs.readFile(path.join(root, "test", "vectors.bin"));
        assert.equal(buffer.length, 3 * FAKE_DIMS * 4, "the binary file is not Float32 per row");
        assert.equal(buffer.length % (FAKE_DIMS * 4), 0, "a partial row was written");
    });
});

test("re-indexing a changed file replaces its chunks instead of duplicating them", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);

        await collection.addDocument(makeDoc("doc1", "a.txt", ["the old wording of the first paragraph"]));
        const result = await collection.addDocument(makeDoc("doc1", "a.txt", ["the new wording of the first paragraph"]));

        assert.equal(result.replaced, true);
        assert.equal(collection.chunks.length, 1, "the old chunk is still in memory");
        assert.equal(collection.chunks[0].text, "the new wording of the first paragraph");
        assert.equal(collection.vectors.length, FAKE_DIMS, "the vector matrix kept the removed row");
    });
});

test("a replaced document stays replaced after a restart", async () => {
    // addDocument() removes the old rows in memory and then APPENDS the new
    // ones. If the files are not rewritten at the removal, chunks.jsonl still
    // holds the old lines, and the next load reads them straight back in - so
    // the superseded text returns from search alongside its replacement.
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);

        await collection.addDocument(makeDoc("doc1", "a.txt", ["the superseded wording that must disappear"]));
        await collection.addDocument(makeDoc("doc1", "a.txt", ["the current wording that must remain"]));
        await collection.addDocument(makeDoc("doc2", "b.txt", ["an unrelated second document"]));

        const reloaded = await reopen(root);
        const texts = reloaded.chunks.map((chunk) => chunk.text);

        assert.equal(reloaded.chunks.length, 2, `expected 2 chunks on disk, got ${JSON.stringify(texts)}`);
        assert.ok(!texts.some((text) => text.includes("superseded")), "the replaced chunk was resurrected from disk");
        assert.ok(texts.some((text) => text.includes("current wording")));
        assert.equal(reloaded.vectors.length, 2 * FAKE_DIMS, "the vector file kept the removed row");

        const meta = await readMeta(root);
        assert.equal(meta.chunkCount, 2);
    });
});

test("a replacement that fails validation leaves the previous version untouched", async () => {
    // Replacing removes the old rows before writing the new ones, so a failure
    // discovered too late would leave the collection holding neither version.
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["the version that should survive"]));

        const bad = makeDoc("doc1", "a.txt", ["the version that should not land"]);
        bad.vectors = [new Float32Array(FAKE_DIMS - 1)];

        await assert.rejects(
            () => collection.addDocument(bad),
            (error) => error.code === "dimensionMismatch"
        );

        assert.deepEqual(collection.chunks.map((chunk) => chunk.text), ["the version that should survive"]);

        const reloaded = await reopen(root);
        assert.deepEqual(reloaded.chunks.map((chunk) => chunk.text), ["the version that should survive"]);
        assert.equal(reloaded.vectors.length, FAKE_DIMS);
    });
});

test("removing a document rewrites the files, not just memory", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["first document content"]));
        await collection.addDocument(makeDoc("doc2", "b.txt", ["second document content"]));
        await collection.addDocument(makeDoc("doc3", "c.txt", ["third document content"]));

        assert.equal(await collection.removeDocument("doc2"), true);
        assert.equal(await collection.removeDocument("doc2"), false, "removing twice should report no change");

        const reloaded = await reopen(root);
        assert.deepEqual(
            reloaded.chunks.map((chunk) => chunk.docId),
            ["doc1", "doc3"],
            "row order or membership changed after compaction"
        );

        // The surviving vectors must still be the right ones, in the right rows.
        const hits = reloaded.search(hashEmbed("third document content"), { topK: 1 });
        assert.equal(hits[0].docId, "doc3");
        assert.equal(hits[0].text, "third document content");
    });
});

test("search honours topK, the score floor and document exclusion", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", [
            "revenue figures for the northern region",
            "revenue figures for the southern region",
            "revenue figures for the eastern region",
        ]));
        await collection.addDocument(makeDoc("doc2", "b.txt", ["revenue figures for the western region"]));

        const query = hashEmbed("revenue figures for a region");

        assert.equal(collection.search(query, { topK: 1, minScore: 0 }).length, 1);
        assert.equal(collection.search(query, { topK: 4, minScore: 0 }).length, 4);

        // A floor high enough to reject everything must return nothing rather
        // than the least-bad match.
        assert.equal(collection.search(query, { topK: 4, minScore: 0.99 }).length, 0);

        const withoutDoc1 = collection.search(query, { topK: 4, minScore: 0, excludeDocIds: ["doc1"] });
        assert.deepEqual(withoutDoc1.map((hit) => hit.docId), ["doc2"]);
    });
});

test("one large document cannot own the whole result set", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);

        const many = Array.from(
            { length: RAG_DEFAULTS.maxHitsPerDocument + 4 },
            (_, i) => `deployment pipeline step ${i} for the release process`
        );
        await collection.addDocument(makeDoc("big", "big.txt", many));
        await collection.addDocument(makeDoc("small", "small.txt", ["deployment pipeline overview for the release process"]));

        const hits = collection.search(hashEmbed("deployment pipeline for the release process"), {
            topK: 6,
            minScore: 0,
        });

        const fromBig = hits.filter((hit) => hit.docId === "big").length;
        assert.ok(
            fromBig <= RAG_DEFAULTS.maxHitsPerDocument,
            `one document took ${fromBig} of ${hits.length} slots, cap is ${RAG_DEFAULTS.maxHitsPerDocument}`
        );
        assert.ok(
            hits.some((hit) => hit.docId === "small"),
            "the smaller document was crowded out entirely"
        );
    });
});

test("a query vector of the wrong width is rejected, not padded", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["content"]));

        assert.throws(
            () => collection.search(new Float32Array(FAKE_DIMS - 1)),
            (error) => error.code === "dimensionMismatch"
        );
    });
});

test("searching an empty collection returns nothing rather than throwing", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        assert.deepEqual(collection.search(hashEmbed("anything")), []);
    });
});

test("malformed documents are refused with a specific code", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);

        const expect = async (doc, code) => {
            await assert.rejects(
                () => collection.addDocument(doc),
                (error) => {
                    assert.ok(error instanceof VectorStoreError, `${code}: wrong error type`);
                    assert.equal(error.code, code);
                    return true;
                }
            );
        };

        await expect(makeDoc("d", "a.txt", []), "noChunks");
        await expect({ docId: "d", path: "a.txt", chunks: [] }, "noChunks");

        const good = makeDoc("d", "a.txt", ["one", "two"]);
        await expect({ ...good, vectors: [good.vectors[0]] }, "chunkVectorMismatch");

        const narrow = makeDoc("d", "a.txt", ["one"]);
        await expect({ ...narrow, vectors: [new Float32Array(FAKE_DIMS - 1)] }, "dimensionMismatch");

        assert.equal(collection.chunks.length, 0, "a rejected document still wrote something");
    });
});

test("opening a collection embedded with a different model refuses to mix vectors", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["content"]));

        await assert.rejects(
            () => reopen(root, "test", { model: "some/other-embedder" }),
            (error) => {
                assert.equal(error.code, "modelChanged");
                assert.match(error.message, /not comparable/);
                return true;
            }
        );
    });
});

test("opening a collection with different dimensions refuses rather than misreading rows", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["content"]));

        await assert.rejects(
            () => reopen(root, "test", { dims: FAKE_DIMS * 2 }),
            (error) => error.code === "dimensionsChanged"
        );
    });
});

test("a torn final JSONL line is dropped and the file repaired", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["first chunk", "second chunk"]));

        const chunksFile = path.join(root, "test", "chunks.jsonl");
        const vectorsFile = path.join(root, "test", "vectors.bin");
        // Simulate a process killed mid-append: a partial line plus one vector
        // row that has no chunk to go with it.
        await fs.appendFile(chunksFile, '{"id":"doc1#2","docId":"doc1","te', "utf8");
        await fs.appendFile(vectorsFile, Buffer.alloc(FAKE_DIMS * 4));

        const reloaded = await reopen(root);
        assert.deepEqual(reloaded.chunks.map((chunk) => chunk.text), ["first chunk", "second chunk"]);

        // Repair must have been written, not just applied in memory.
        const raw = await fs.readFile(chunksFile, "utf8");
        assert.equal(raw.split("\n").filter((line) => line.trim()).length, 2);
        const buffer = await fs.readFile(vectorsFile);
        assert.equal(buffer.length, 2 * FAKE_DIMS * 4);
    });
});

test("more chunk lines than vector rows trims to the consistent prefix", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["one", "two", "three"]));

        // Chop a row off the vector file only.
        const vectorsFile = path.join(root, "test", "vectors.bin");
        const buffer = await fs.readFile(vectorsFile);
        await fs.writeFile(vectorsFile, buffer.subarray(0, buffer.length - FAKE_DIMS * 4));

        const reloaded = await reopen(root);
        assert.equal(reloaded.chunks.length, 2, "chunks were not trimmed to the available vectors");
        assert.equal(reloaded.vectors.length, 2 * FAKE_DIMS);

        const afterRepair = await fs.readFile(vectorsFile);
        assert.equal(afterRepair.length, 2 * FAKE_DIMS * 4, "the mismatch was not repaired on disk");
    });
});

test("concurrent writes to one collection do not interleave", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);

        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                collection.addDocument(makeDoc(`doc${i}`, `f${i}.txt`, [`document ${i} about topic ${i}`]))
            )
        );

        assert.equal(collection.chunks.length, 8);

        const reloaded = await reopen(root);
        assert.equal(reloaded.chunks.length, 8, "interleaved appends lost or corrupted rows");
        assert.equal(reloaded.vectors.length, 8 * FAKE_DIMS);

        const meta = await readMeta(root);
        assert.equal(Object.keys(meta.documents).length, 8);
    });
});

test("list() reports collections and skips directories that are not collections", async () => {
    await withTempRoot(async (root) => {
        const store = new VectorStore(root);
        await (await store.open("alpha", { model: MODEL, dims: FAKE_DIMS }))
            .addDocument(makeDoc("d", "a.txt", ["alpha content"]));
        await (await store.open("beta", { model: MODEL, dims: FAKE_DIMS }))
            .addDocument(makeDoc("d", "b.txt", ["beta content", "beta second"]));

        // Junk that must not break the listing.
        await fs.mkdir(path.join(root, "not-a-collection"), { recursive: true });
        await fs.writeFile(path.join(root, "stray.txt"), "ignore me", "utf8");

        const found = await store.list();
        const ids = found.map((entry) => entry.id);

        assert.deepEqual(ids.sort(), ["alpha", "beta"]);
        const beta = found.find((entry) => entry.id === "beta");
        assert.equal(beta.chunkCount, 2);
        assert.equal(beta.documentCount, 1);
        assert.equal(beta.model, MODEL);
    });
});

test("list() on a missing root is an empty list, not an error", async () => {
    await withTempRoot(async (root) => {
        const store = new VectorStore(path.join(root, "never-created"));
        assert.deepEqual(await store.list(), []);
    });
});

test("delete() removes the collection from disk", async () => {
    await withTempRoot(async (root) => {
        const store = new VectorStore(root);
        const collection = await store.open("gone", { model: MODEL, dims: FAKE_DIMS });
        await collection.addDocument(makeDoc("d", "a.txt", ["content"]));

        assert.equal(await store.delete("gone"), true);
        assert.deepEqual(await store.list(), []);

        await assert.rejects(
            () => fs.stat(path.join(root, "gone")),
            (error) => error.code === "ENOENT"
        );
    });
});

test("open() reuses the cached instance for the same descriptor", async () => {
    await withTempRoot(async (root) => {
        const store = new VectorStore(root);
        const first = await store.open("same", { model: MODEL, dims: FAKE_DIMS });
        const second = await store.open("same", { model: MODEL, dims: FAKE_DIMS });
        assert.equal(first, second, "two live handles on one directory would race each other");

        store.reset();
        const third = await store.open("same", { model: MODEL, dims: FAKE_DIMS });
        assert.notEqual(first, third, "reset() should drop the cache");
    });
});

test("stats() describes the collection without exposing vectors", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument({
            ...makeDoc("doc1", "report.docx", ["first section", "second section"]),
            convertedFrom: "docx",
            truncated: true,
        });

        const stats = collection.stats();
        assert.equal(stats.chunkCount, 2);
        assert.equal(stats.documentCount, 1);
        assert.equal(stats.dims, FAKE_DIMS);
        assert.equal(stats.documents[0].convertedFrom, "docx");
        assert.equal(stats.documents[0].truncated, true);
        assert.equal(stats.documents[0].chars, "first section".length + "second section".length);
        assert.ok(!("vectors" in stats), "raw vectors must not be serialized into an API response");
    });
});

test("destroy() clears memory as well as disk", async () => {
    await withTempRoot(async (root) => {
        const { collection } = await openCollection(root);
        await collection.addDocument(makeDoc("doc1", "a.txt", ["content"]));

        await collection.destroy();
        assert.equal(collection.chunks.length, 0);
        assert.equal(collection.documents.size, 0);
        assert.equal(collection.loaded, false);
        assert.deepEqual(collection.search(hashEmbed("content")), []);
    });
});
