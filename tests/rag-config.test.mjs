/**
 * ============================================================================
 * CONFIG, VECTOR MATH AND INGEST TESTS
 * ============================================================================
 * The three modules that decide, respectively: what the tunables are, what the
 * arithmetic means, and which files are allowed in at all.
 *
 * The registry-isolation test is the one to keep. `GET /api/models` hands the
 * whole chat registry to the model selector, so an embedding model that ends up
 * in model-registry.json appears in the chat dropdown and then dies inside
 * streamChat(). Nothing else in the system would notice.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    AGENT_DIR,
    RAG_DEFAULTS,
    clearRegistryCache,
    loadEmbeddingRegistry,
    resolveEmbeddingModel,
    resolveStorageRoot,
} from "../ai-agent/rag/config.js";
import { cosine, dot, l2Normalize, searchMatrix, truncateDimensions } from "../ai-agent/rag/vector-math.js";
import { IngestError, contentHash, prepareDocument } from "../ai-agent/rag/ingest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run `body` with process.env overridden, restoring it afterwards. */
async function withEnv(overrides, body) {
    const saved = {};
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === null) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    try {
        return await body();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/* ------------------------------------------------------------------ */
/* RAG_DEFAULTS                                                        */
/* ------------------------------------------------------------------ */

test("the chunking defaults are internally consistent", () => {
    assert.ok(RAG_DEFAULTS.chunkTargetChars < RAG_DEFAULTS.chunkMaxChars, "the target must sit below the hard maximum");
    assert.ok(RAG_DEFAULTS.chunkOverlapChars <= RAG_DEFAULTS.chunkTargetChars / 2, "overlap may not exceed half the target");
    assert.ok(RAG_DEFAULTS.minChunkChars < RAG_DEFAULTS.chunkTargetChars);

    // truncate:"NONE" is only safe while a chunk cannot reach the model's
    // 10240-token window. At the usual ~4 chars/token estimate the hard maximum
    // has to leave an order of magnitude of headroom for the context prefix.
    const estimatedTokens = RAG_DEFAULTS.chunkMaxChars / 4;
    assert.ok(
        estimatedTokens * 10 < 10240,
        `a ${RAG_DEFAULTS.chunkMaxChars}-char chunk is roughly ${estimatedTokens} tokens, too close to the window for truncate:"NONE"`
    );
});

test("the retrieval knobs are distinct from the corpus guards", () => {
    // These two keys were once declared twice in the same object literal, so
    // the per-query cap silently inherited the corpus value (4000) and a single
    // document could own the entire result set. Pin both meanings.
    assert.equal(RAG_DEFAULTS.maxHitsPerDocument, 3, "per-query, per-document cap");
    assert.equal(RAG_DEFAULTS.maxChunksPerDocument, 4000, "whole-file corpus guard");
    assert.ok(RAG_DEFAULTS.maxHitsPerDocument <= RAG_DEFAULTS.topK, "a per-document cap above topK does nothing");
    assert.ok(RAG_DEFAULTS.maxChunksPerDocument < RAG_DEFAULTS.maxChunksPerCollection);
    assert.ok(RAG_DEFAULTS.topK >= 1);
    assert.ok(RAG_DEFAULTS.minScore > 0 && RAG_DEFAULTS.minScore < 1);
});

test("the memory ceiling implied by maxChunksPerCollection is documented honestly", () => {
    // 2048 dims of Float32 is 8 KB a row. The comment in config.js quotes the
    // figure the UI would have to justify, so check the arithmetic still holds.
    const bytes = RAG_DEFAULTS.maxChunksPerCollection * 2048 * 4;
    const megabytes = bytes / (1024 * 1024);
    assert.ok(megabytes > 100 && megabytes < 300, `expected roughly 160 MB, computed ${megabytes.toFixed(0)} MB`);
});

/* ------------------------------------------------------------------ */
/* storage root                                                        */
/* ------------------------------------------------------------------ */

test("an explicit ARTEMIS_RAG_DIR wins over everything", async () => {
    await withEnv({ ARTEMIS_RAG_DIR: "D:/somewhere/else", ARTEMIS_DATA_DIR: "D:/ignored" }, () => {
        assert.equal(resolveStorageRoot(), path.resolve("D:/somewhere/else"));
    });
});

test("ARTEMIS_DATA_DIR puts collections under the Electron userData path", async () => {
    await withEnv({ ARTEMIS_RAG_DIR: null, ARTEMIS_DATA_DIR: "D:/appdata/artemis" }, () => {
        assert.equal(resolveStorageRoot(), path.join(path.resolve("D:/appdata/artemis"), "rag"));
    });
});

test("with no environment set, the fallback stays inside the agent directory", async () => {
    await withEnv({ ARTEMIS_RAG_DIR: null, ARTEMIS_DATA_DIR: null }, () => {
        const root = resolveStorageRoot();
        assert.equal(root, path.join(AGENT_DIR, ".data", "rag"));
        // A packaged Electron app cannot write to its install directory, which
        // is exactly why the two variables above exist. The fallback is a
        // developer convenience and must be git-ignored.
        assert.ok(root.startsWith(path.join(REPO_ROOT, "ai-agent")), `fallback escaped the repo: ${root}`);
    });
});

test("blank environment values are treated as unset", async () => {
    await withEnv({ ARTEMIS_RAG_DIR: "   ", ARTEMIS_DATA_DIR: "" }, () => {
        assert.equal(resolveStorageRoot(), path.join(AGENT_DIR, ".data", "rag"));
    });
});

/* ------------------------------------------------------------------ */
/* embedding registry                                                  */
/* ------------------------------------------------------------------ */

test("the registry declares the Nemotron endpoint and its real width", async () => {
    const registry = await loadEmbeddingRegistry();
    const model = await resolveEmbeddingModel();

    assert.equal(registry.defaultModel, "nvidia:nemotron-3.5-embed-1b");
    assert.equal(model.model, "nvidia/nemotron-3.5-embed-1b");
    assert.equal(model.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(model.apiKeyEnv, "NVIDIA_API_KEY");
    assert.equal(model.dimensions, 2048, "the model card specifies 2048 mean-pooled dimensions");
    assert.equal(model.request.truncate, "NONE", "END would silently drop the tail of an over-long chunk");
    assert.equal(model.request.modality, "text");
});

test("resolveEmbeddingModel refuses an unknown id instead of falling back", async () => {
    await assert.rejects(
        () => resolveEmbeddingModel("nvidia:some-other-embedder"),
        (error) => {
            assert.match(error.message, /Unknown embedding model/);
            // The message has to list what IS available, or the user cannot fix it.
            assert.match(error.message, /nemotron-3\.5-embed-1b/);
            return true;
        }
    );
});

test("every registry entry carries the fields the store cannot infer", async () => {
    const registry = await loadEmbeddingRegistry();
    const ids = new Set();

    for (const model of registry.models) {
        assert.ok(model.id, "missing id");
        assert.ok(!ids.has(model.id), `duplicate id ${model.id}`);
        ids.add(model.id);

        for (const field of ["model", "baseUrl", "apiKeyEnv", "name"]) {
            assert.ok(model[field], `${model.id} is missing ${field}`);
        }
        // The store allocates fixed-width rows before the first response ever
        // arrives, so the width has to be declared rather than discovered.
        assert.ok(Number.isInteger(model.dimensions) && model.dimensions > 0, `${model.id} needs integer dimensions`);
        assert.ok(/^https:\/\//.test(model.baseUrl), `${model.id} baseUrl is not https`);
    }
});

test("the embedding model is kept out of the chat model registry", async () => {
    // GET /api/models returns the whole chat registry to the model selector.
    // An embedding model in there shows up in the dropdown and then fails
    // inside streamChat(), because it has no chat completion endpoint.
    const chat = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, "ai-agent", "config", "model-registry.json"), "utf8")
    );
    const embeddings = await loadEmbeddingRegistry();

    const chatIds = new Set((chat.models || []).map((model) => model.id));
    const chatApiNames = new Set((chat.models || []).map((model) => model.model));

    for (const model of embeddings.models) {
        assert.ok(!chatIds.has(model.id), `${model.id} is in the chat registry and would appear in the model selector`);
        assert.ok(
            !chatApiNames.has(model.model),
            `${model.model} is offered as a chat model but only implements /embeddings`
        );
    }
});

test("clearRegistryCache forces a re-read", async () => {
    const first = await loadEmbeddingRegistry();
    const cached = await loadEmbeddingRegistry();
    assert.equal(first, cached, "the registry should be cached between calls");

    clearRegistryCache();
    const fresh = await loadEmbeddingRegistry();
    assert.notEqual(first, fresh);
    assert.deepEqual(fresh.defaultModel, first.defaultModel);
});

/* ------------------------------------------------------------------ */
/* vector math                                                         */
/* ------------------------------------------------------------------ */

const vec = (...values) => Float32Array.from(values);
const magnitude = (v) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

test("l2Normalize returns a unit-length copy without touching the input", () => {
    const input = vec(3, 4);
    const normalized = l2Normalize(input);

    assert.ok(Math.abs(magnitude(normalized) - 1) < 1e-6);
    assert.ok(Math.abs(normalized[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(normalized[1] - 0.8) < 1e-6);
    assert.deepEqual(Array.from(input), [3, 4], "the input was mutated");

    // Plain arrays are accepted too, since callers are not uniform.
    assert.ok(Math.abs(magnitude(l2Normalize([3, 4])) - 1) < 1e-6);
});

test("a zero vector normalizes to zeros rather than NaN", () => {
    // NaN would poison every comparison it took part in, and cosine similarity
    // against it is NaN rather than 0 - so one empty chunk would make an entire
    // result list unsortable instead of just irrelevant.
    const normalized = l2Normalize(vec(0, 0, 0));

    assert.deepEqual(Array.from(normalized), [0, 0, 0]);
    assert.ok(Number.isFinite(cosine(vec(0, 0, 0), vec(1, 0, 0))), "cosine against a zero vector is not finite");
    assert.equal(cosine(vec(0, 0, 0), vec(1, 0, 0)), 0);
});

test("dot throws on a dimension mismatch instead of scoring zero", () => {
    assert.equal(dot(vec(1, 2, 3), vec(1, 2, 3)), 14);
    assert.throws(() => dot(vec(1, 2), vec(1, 2, 3)), /dimension mismatch/i);
});

test("cosine is 1 for identical directions, 0 for orthogonal ones", () => {
    assert.ok(Math.abs(cosine(vec(1, 2, 3), vec(1, 2, 3)) - 1) < 1e-6);
    assert.ok(Math.abs(cosine(vec(1, 0), vec(0, 1))) < 1e-6);
    // Scaling must not change the answer, which is the point of normalizing.
    assert.ok(Math.abs(cosine(vec(1, 2, 3), vec(10, 20, 30)) - 1) < 1e-6);
    assert.ok(cosine(vec(1, 0), vec(-1, 0)) < -0.99);
});

test("truncateDimensions keeps the prefix and renormalizes", () => {
    const input = vec(3, 4, 0, 0);
    const truncated = truncateDimensions(input, 2);

    assert.equal(truncated.length, 2);
    // The model card only blesses truncated embeddings if they are renormalized;
    // without this step every similarity score shrinks and the floor rejects them.
    assert.ok(Math.abs(magnitude(truncated) - 1) < 1e-6, "not renormalized after truncation");
    assert.deepEqual(Array.from(input), [3, 4, 0, 0], "the input was mutated");
});

test("truncateDimensions leaves the vector alone when there is nothing to cut", () => {
    const input = vec(1, 2, 3);
    assert.equal(truncateDimensions(input, 0), input);
    assert.equal(truncateDimensions(input, 3), input);
    assert.equal(truncateDimensions(input, 99), input);
    assert.equal(truncateDimensions(input, undefined), input);
});

test("searchMatrix ranks descending and honours topK, minScore and skip", () => {
    const dims = 3;
    const matrix = Float32Array.from([
        ...l2Normalize(vec(1, 0, 0)), // row 0: exact match
        ...l2Normalize(vec(0.9, 0.1, 0)), // row 1: close
        ...l2Normalize(vec(0, 1, 0)), // row 2: orthogonal
        ...l2Normalize(vec(0.5, 0.5, 0)), // row 3: middling
    ]);
    const query = l2Normalize(vec(1, 0, 0));

    const all = searchMatrix(matrix, dims, query, { topK: 4 });
    assert.deepEqual(all.map((entry) => entry.row), [0, 1, 3, 2]);
    assert.ok(all[0].score > all[1].score && all[1].score > all[2].score);

    assert.deepEqual(searchMatrix(matrix, dims, query, { topK: 2 }).map((entry) => entry.row), [0, 1]);
    assert.deepEqual(searchMatrix(matrix, dims, query, { topK: 4, minScore: 0.5 }).map((entry) => entry.row), [0, 1, 3]);
    assert.deepEqual(
        searchMatrix(matrix, dims, query, { topK: 4, skip: (row) => row === 0 }).map((entry) => entry.row),
        [1, 3, 2]
    );
});

test("searchMatrix on an empty or malformed matrix returns nothing", () => {
    assert.deepEqual(searchMatrix(new Float32Array(0), 3, vec(1, 0, 0)), []);
    assert.deepEqual(searchMatrix(Float32Array.from([1, 0, 0]), 0, vec(1, 0, 0)), []);
    // topK is clamped to at least 1 rather than producing an empty result.
    assert.equal(searchMatrix(Float32Array.from([1, 0, 0]), 3, vec(1, 0, 0), { topK: 0 }).length, 1);
});

/* ------------------------------------------------------------------ */
/* ingest                                                              */
/* ------------------------------------------------------------------ */

test("source code is classified as code and chunked on declarations", async () => {
    const prepared = await prepareDocument({
        bytes: Buffer.from("export function a() {}\n"),
        name: "src/mod.js",
    });

    assert.equal(prepared.kind, "code");
    assert.equal(prepared.language, "javascript");
    assert.equal(prepared.convertedFrom, "");
    assert.equal(prepared.truncated, false);
});

test("markdown, prose and csv each get their own chunking kind", async () => {
    const cases = [
        ["notes.md", "markdown"],
        ["data.csv", "text"],
        ["readme.txt", "text"],
        ["config.env", "text"],
        ["settings.ini", "text"],
        ["module.py", "code"],
        ["styles.css", "code"],
        ["Dockerfile", "code"],
    ];

    for (const [name, expectedKind] of cases) {
        const prepared = await prepareDocument({ bytes: Buffer.from("some readable content here\n"), name });
        assert.equal(prepared.kind, expectedKind, `${name} was classified as ${prepared.kind}`);
    }
});

test("a byte-order mark is stripped and CRLF is normalized", async () => {
    const prepared = await prepareDocument({
        bytes: Buffer.from("\uFEFFline one\r\nline two\rline three\n"),
        name: "notes.txt",
    });

    assert.equal(prepared.text, "line one\nline two\nline three\n");
    assert.ok(!prepared.text.includes("\r"), "a carriage return survived");
    assert.ok(!prepared.text.startsWith("\uFEFF"), "the BOM survived");
});

test("an over-long document is indexed partially and says so", async () => {
    const text = "x".repeat(5000);
    const prepared = await prepareDocument({ bytes: Buffer.from(text), name: "big.txt", maxTextChars: 1000 });

    assert.equal(prepared.truncated, true, "the cut was not recorded");
    assert.equal(prepared.chars, 1000);
    assert.equal(prepared.text.length, 1000);
});

test("a file that decodes to garbage is rejected despite its extension", async () => {
    const binary = Buffer.concat([Buffer.from("const x = 1;"), Buffer.alloc(200, 0)]);

    await assert.rejects(
        () => prepareDocument({ bytes: binary, name: "looks-like-code.js" }),
        (error) => {
            assert.ok(error instanceof IngestError);
            assert.equal(error.code, "binary");
            return true;
        }
    );
});

test("rejections carry a stable code and a sentence a human can read", async () => {
    const cases = [
        { name: "empty.txt", bytes: Buffer.alloc(0), code: "empty" },
        { name: "blank.md", bytes: Buffer.from("  \n \n"), code: "empty" },
        { name: "photo.png", bytes: Buffer.alloc(32, 1), code: "imageNotIndexed" },
        { name: "lib.dll", bytes: Buffer.alloc(32, 2), code: "binary" },
        { name: "font.woff2", bytes: Buffer.alloc(32, 3), code: "binary" },
    ];

    for (const testCase of cases) {
        await assert.rejects(
            () => prepareDocument({ bytes: testCase.bytes, name: testCase.name }),
            (error) => {
                assert.ok(error instanceof IngestError, `${testCase.name}: wrong error type`);
                assert.equal(error.code, testCase.code, testCase.name);
                assert.ok(error.message.length > 10, `${testCase.name} has no usable message`);
                return true;
            },
            `${testCase.name} should have been rejected`
        );
    }
});

test("an office file without a converter is refused rather than decoded as text", async () => {
    // Reading a docx as UTF-8 would produce zip bytes, and looksBinary would
    // reject it with a confusing "looks binary" message. The real reason is
    // that no converter was injected.
    await assert.rejects(
        () => prepareDocument({ bytes: Buffer.from("PK\u0003\u0004 not really a docx"), name: "report.docx" }),
        (error) => {
            assert.equal(error.code, "parserUnavailable");
            assert.match(error.message, /no document converter/);
            return true;
        }
    );
});

test("a converter failure keeps its own code and page numbers", async () => {
    const parseDocument = async () => {
        throw Object.assign(new Error("page 1 of 1 is a scanned image and needs OCR"), {
            code: "needsOcr",
            pages: [1],
            pageCount: 1,
        });
    };

    await assert.rejects(
        () => prepareDocument({ bytes: Buffer.from("PK\u0003\u0004"), name: "scan.pdf", parseDocument }),
        (error) => {
            assert.ok(error instanceof IngestError);
            assert.equal(error.code, "needsOcr", "the converter's code was replaced with a generic one");
            assert.deepEqual(error.pages, [1], "which pages failed is the actionable part of the message");
            assert.equal(error.pageCount, 1);
            return true;
        }
    );
});

test("a converted document reports its origin format and is markdown", async () => {
    const parseDocument = async () => ({
        markdown: "# Title\n\nBody text that is long enough to be worth indexing here.\n",
        format: "docx",
        truncated: true,
    });

    const prepared = await prepareDocument({ bytes: Buffer.from("PK\u0003\u0004"), name: "report.docx", parseDocument });

    assert.equal(prepared.kind, "markdown");
    assert.equal(prepared.language, "markdown", "converted text is markdown whatever the file was called");
    assert.equal(prepared.convertedFrom, "docx");
    assert.equal(prepared.truncated, true, "the converter's own truncation flag was dropped");
});

test("contentHash is stable for identical bytes and differs for edited ones", async () => {
    const a = Buffer.from("the same content");
    const b = Buffer.from("the same content");
    const c = Buffer.from("the same content!");

    assert.equal(contentHash(a), contentHash(b));
    assert.notEqual(contentHash(a), contentHash(c));
    assert.equal(contentHash(a).length, 64, "expected a sha256 hex digest");

    // A Uint8Array view and a Buffer of the same bytes must hash identically,
    // because the renderer sends one and the agent may hold the other.
    assert.equal(contentHash(a), contentHash(new Uint8Array(a)));
    assert.ok(contentHash(Buffer.alloc(0)), "empty input must still produce a hash");
});
