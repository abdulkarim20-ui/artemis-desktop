/**
 * ============================================================================
 * EMBEDDINGS ADAPTER TESTS
 * ============================================================================
 * The wire contract with NVIDIA's embeddings endpoint.
 *
 * The passage/query tests are the important ones. `input_type` is the single
 * parameter that, if wrong, produces a pipeline that runs cleanly, returns
 * results, and retrieves the wrong things - there is no error to catch. So it
 * is asserted at the request-body level, not inferred from behaviour.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    EMBED_MODES,
    EmbeddingError,
    NvidiaEmbeddings,
} from "../ai-agent/rag/embeddings.js";
import { FAKE_DIMS, hashEmbed, makeEmbeddingFetch } from "./rag-fixtures.mjs";

const BASE = {
    model: "nvidia/nemotron-3.5-embed-1b",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "nvapi-test-key",
};

const build = (fetchStub, overrides = {}) =>
    new NvidiaEmbeddings({
        ...BASE,
        dimensions: FAKE_DIMS,
        request: { encoding_format: "float", truncate: "NONE", modality: ["text"] },
        retries: 2,
        fetchImpl: fetchStub.impl,
        ...overrides,
    });

const norm = (vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

test("indexing sends input_type=passage", async () => {
    const stub = makeEmbeddingFetch();
    const embeddings = build(stub);

    await embeddings.embed({ texts: ["the quarterly revenue table"], mode: EMBED_MODES.PASSAGE });

    assert.deepEqual(stub.modes, ["passage"]);
});

test("searching sends input_type=query", async () => {
    const stub = makeEmbeddingFetch();
    const embeddings = build(stub);

    await embeddings.embedOne("what was the quarterly revenue?", EMBED_MODES.QUERY);

    assert.deepEqual(stub.modes, ["query"]);
});

test("a missing or wrong input_type is refused rather than defaulted", async () => {
    const stub = makeEmbeddingFetch();
    const embeddings = build(stub);

    for (const mode of [undefined, null, "", "index", "PASSAGE"]) {
        await assert.rejects(
            () => embeddings.embed({ texts: ["anything"], mode }),
            (error) => {
                assert.ok(error instanceof EmbeddingError);
                assert.equal(error.code, "badMode");
                // The message has to explain the difference, not just reject.
                assert.match(error.message, /passage is for indexing, query is for searching/);
                return true;
            },
            `mode ${JSON.stringify(mode)} should have been refused`
        );
    }

    assert.equal(stub.requestCount, 0, "no request may be sent with an invalid mode");
});

test("the request carries the NVIDIA extensions and the bearer key", async () => {
    const stub = makeEmbeddingFetch();
    await build(stub).embed({ texts: ["a chunk"], mode: EMBED_MODES.PASSAGE });

    const [call] = stub.calls;
    assert.equal(call.url, "https://integrate.api.nvidia.com/v1/embeddings");
    assert.equal(call.headers.Authorization, "Bearer nvapi-test-key");
    assert.equal(call.body.model, BASE.model);
    assert.equal(call.body.encoding_format, "float");
    assert.equal(call.body.modality, "text");
    // NONE, not END: an over-long chunk must fail loudly instead of losing its tail.
    assert.equal(call.body.truncate, "NONE");
});

test("an empty string is refused before it costs a request", async () => {
    const stub = makeEmbeddingFetch();

    await assert.rejects(
        () => build(stub).embed({ texts: ["real text", "   "], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "emptyInput");
            return true;
        }
    );
    assert.equal(stub.requestCount, 0);
});

test("texts are batched, and every text is embedded exactly once", async () => {
    const stub = makeEmbeddingFetch();
    const texts = Array.from({ length: 40 }, (_, i) => `chunk number ${i} about topic ${i % 5}`);

    const vectors = await build(stub, { batchSize: 16 }).embed({ texts, mode: EMBED_MODES.PASSAGE });

    assert.equal(vectors.length, 40);
    assert.equal(stub.requestCount, 3, "40 texts at batchSize 16 is 16+16+8");
    assert.deepEqual(stub.calls.map((call) => call.body.input.length), [16, 16, 8]);
    assert.deepEqual(stub.texts, texts, "no text duplicated or dropped across batches");
});

test("identical texts are embedded once and the cache serves the repeat", async () => {
    const stub = makeEmbeddingFetch();

    const embeddings = build(stub, { batchSize: 16 });
    const first = await embeddings.embed({ texts: ["alpha content", "beta content", "alpha content"], mode: EMBED_MODES.PASSAGE });
    const requestsAfterFirst = stub.requestCount;
    const second = await embeddings.embed({ texts: ["alpha content"], mode: EMBED_MODES.PASSAGE });

    // Only the two unique texts go out; the duplicate is served from cache.
    assert.equal(stub.texts.length, 2);
    assert.deepEqual(stub.texts, ["alpha content", "beta content"]);
    assert.equal(first.length, 3);
    assert.equal(second.length, 1);
    assert.equal(stub.requestCount, requestsAfterFirst, "a repeated text cost another request");
    assert.deepEqual(Array.from(second[0]), Array.from(first[0]), "the cached vector differs from the fresh one");
});

test("the global limiter caps concurrent HTTP requests across embed calls", async () => {
    let inFlight = 0;
    let peak = 0;

    const impl = async (url, options = {}) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const body = JSON.parse(options.body || "{}");
        const inputs = Array.isArray(body.input) ? body.input : [];
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: inputs.map((text, index) => ({ index, embedding: Array.from(hashEmbed(text, FAKE_DIMS)) })),
            }),
        };
    };

    // batchSize 1 with twelve unique texts makes twelve requests; maxInFlight
    // 2 must be the thing that stops twelve of them flying at once.
    const embeddings = new NvidiaEmbeddings({
        ...BASE,
        dimensions: FAKE_DIMS,
        batchSize: 1,
        maxInFlight: 2,
        request: { encoding_format: "float", truncate: "NONE", modality: ["text"] },
        fetchImpl: impl,
    });

    const textsA = Array.from({ length: 6 }, (_, i) => `side a text number ${i}`);
    const textsB = Array.from({ length: 6 }, (_, i) => `side b text number ${i}`);

    await Promise.all([
        embeddings.embed({ texts: textsA, mode: EMBED_MODES.PASSAGE }),
        embeddings.embed({ texts: textsB, mode: EMBED_MODES.PASSAGE }),
    ]);

    assert.ok(peak <= 2, `peak concurrent requests was ${peak}, above the global cap`);
    assert.equal(peak >= 2, true, "the limiter never actually throttled anything");
});

test("out-of-order responses are put back in input order", async () => {
    const stub = makeEmbeddingFetch({ unordered: true });
    const texts = ["alpha content", "beta content", "gamma content"];

    const vectors = await build(stub).embed({ texts, mode: EMBED_MODES.PASSAGE });

    // Compare against a directly-computed vector for the same string: if the
    // adapter had trusted the response order these would not line up.
    const reference = await build(makeEmbeddingFetch()).embed({ texts, mode: EMBED_MODES.PASSAGE });
    for (let i = 0; i < texts.length; i += 1) {
        assert.deepEqual(Array.from(vectors[i]), Array.from(reference[i]), `vector ${i} is out of place`);
    }
});

test("a response that skips an input is an error, not a silent short list", async () => {
    const stub = makeEmbeddingFetch({ dropIndex: 1 });

    await assert.rejects(
        () => build(stub).embed({ texts: ["one", "two", "three"], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "badResponse");
            assert.match(error.message, /skipped input #1/);
            return true;
        }
    );
});

test("a transient 503 is retried and the batch still succeeds", async () => {
    const stub = makeEmbeddingFetch({ failFirst: 1 });

    const vectors = await build(stub, { retries: 3 }).embed({ texts: ["content"], mode: EMBED_MODES.PASSAGE });

    assert.equal(vectors.length, 1);
    assert.equal(stub.requestCount, 2, "one failure plus one success");
});

test("an exhausted retry budget reports overloaded, not a bare HTTP status", async () => {
    const stub = makeEmbeddingFetch({ status: 503, message: "service overloaded" });

    await assert.rejects(
        () => build(stub, { retries: 2 }).embed({ texts: ["content"], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "overloaded");
            assert.equal(error.status, 503);
            assert.match(error.message, /overloaded/);
            return true;
        }
    );
});

test("a rejected key is reported as unauthorized", async () => {
    const stub = makeEmbeddingFetch({ status: 401, message: "invalid api key" });

    await assert.rejects(
        () => build(stub).embed({ texts: ["content"], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "unauthorized");
            return true;
        }
    );
});

test("an over-long input under truncate=NONE surfaces as inputTooLong", async () => {
    const stub = makeEmbeddingFetch({ status: 400, message: "input exceeds the maximum token length" });

    await assert.rejects(
        () => build(stub).embed({ texts: ["x".repeat(100)], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "inputTooLong");
            return true;
        }
    );
});

test("vectors come back unit-length and at the configured width", async () => {
    const stub = makeEmbeddingFetch({ dims: 64 });

    const vectors = await build(stub, { dimensions: 8 }).embed({
        texts: ["some content about revenue and regions"],
        mode: EMBED_MODES.PASSAGE,
    });

    assert.equal(vectors[0].length, 8, "truncated to the configured width");
    // The model card only blesses truncated embeddings if they are renormalized.
    assert.ok(Math.abs(norm(vectors[0]) - 1) < 1e-5, "renormalized after truncation");
});

test("an API that returns fewer dimensions than configured is caught immediately", async () => {
    // A collection's row width is fixed when it is created, so a narrower
    // response has to fail here rather than at query time, where it would only
    // show up as nonsense similarity scores.
    const stub = makeEmbeddingFetch({ dims: 4 });

    await assert.rejects(
        () => build(stub, { dimensions: 64 }).embed({ texts: ["content"], mode: EMBED_MODES.PASSAGE }),
        (error) => {
            assert.equal(error.code, "dimensionMismatch");
            assert.match(error.message, /expected 64-dimensional/);
            return true;
        }
    );
});

test("a missing API key is reported before any request is attempted", async () => {
    const stub = makeEmbeddingFetch();

    await assert.rejects(
        () => build(stub, { apiKey: "" }).embed({ texts: ["content"], mode: EMBED_MODES.QUERY }),
        (error) => {
            assert.equal(error.code, "noApiKey");
            assert.match(error.message, /NVIDIA_API_KEY/);
            return true;
        }
    );
    assert.equal(stub.requestCount, 0);
});

test("an aborted signal cancels instead of retrying forever", async () => {
    const stub = makeEmbeddingFetch();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => build(stub, { retries: 5 }).embed({
            texts: ["content"],
            mode: EMBED_MODES.QUERY,
            signal: controller.signal,
        }),
        (error) => {
            assert.equal(error.code, "aborted");
            return true;
        }
    );
});

test("no texts means no requests", async () => {
    const stub = makeEmbeddingFetch();

    const vectors = await build(stub).embed({ texts: [], mode: EMBED_MODES.PASSAGE });

    assert.deepEqual(vectors, []);
    assert.equal(stub.requestCount, 0);
});
