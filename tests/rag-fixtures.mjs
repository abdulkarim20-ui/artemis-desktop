/**
 * ============================================================================
 * RAG TEST FIXTURES (tests/rag-fixtures.mjs)
 * ============================================================================
 * Helpers shared by the retrieval tests. No network, no native modules beyond
 * the ones the app already ships, nothing to download.
 *
 * The fake embedding function is a hashing embedder (unigram plus bigram
 * buckets), not a random vector generator. That distinction matters: random
 * vectors would let every test pass while proving nothing, because retrieval
 * results would be meaningless. Hashing tokens into buckets gives genuinely
 * content-sensitive vectors, so "the query about revenue returns the chunk
 * containing revenue" is a real assertion about the pipeline rather than a
 * tautology.
 * ============================================================================
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { l2Normalize } from "../ai-agent/rag/vector-math.js";

/** Small enough for fast tests, large enough that collisions stay rare. */
export const FAKE_DIMS = 64;

const tokenize = (text) =>
    String(text || "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((token) => token.length > 1);

function fnv1a(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * Deterministic, content-sensitive embedding.
 * Identical wording gives identical vectors; shared wording gives high cosine.
 */
export function hashEmbed(text, dims = FAKE_DIMS) {
    const vector = new Float32Array(dims);
    const tokens = tokenize(text);

    for (const token of tokens) {
        vector[fnv1a(token) % dims] += 1;
    }

    // Unigrams alone make "revenue by region" and "region revenue" identical,
    // which is fine, but they also make "not good" and "good" identical.
    // Bigram buckets give the fake a little sensitivity to word order.
    for (let i = 0; i + 1 < tokens.length; i += 1) {
        vector[fnv1a(`${tokens[i]}_${tokens[i + 1]}`) % dims] += 0.5;
    }

    return l2Normalize(vector);
}

/**
 * A stand-in for the NVIDIA embeddings endpoint.
 *
 * Records every request so tests can assert on the wire format - above all on
 * `input_type`, which is the one parameter that silently destroys retrieval
 * accuracy when it is wrong.
 *
 * @param {object} [config]
 * @param {number} [config.dims]
 * @param {number} [config.failFirst] return 503 this many times, to exercise retry
 * @param {number} [config.status] force a specific non-200 status
 * @param {string} [config.message] error body detail
 * @param {boolean} [config.unordered] answer with data[] out of order
 * @param {number} [config.dropIndex] omit one input from the response
 * @param {boolean} [config.ignoreAbort] do not reject on an aborted signal
 */
export function makeEmbeddingFetch(config = {}) {
    const dims = config.dims || FAKE_DIMS;
    const calls = [];
    let failuresLeft = config.failFirst || 0;

    const impl = async (url, options = {}) => {
        const body = JSON.parse(options.body || "{}");
        calls.push({ url: String(url), body, headers: options.headers || {} });

        if (options.signal?.aborted && !config.ignoreAbort) {
            throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }

        const forced = config.status || (failuresLeft > 0 ? 503 : 0);
        if (forced) {
            if (failuresLeft > 0) failuresLeft -= 1;
            return {
                ok: false,
                status: forced,
                json: async () => ({ detail: config.message || "forced failure" }),
            };
        }

        const inputs = Array.isArray(body.input) ? body.input : [];
        let data = inputs.map((text, index) => ({
            index,
            object: "embedding",
            embedding: Array.from(hashEmbed(text, dims)),
        }));

        if (config.dropIndex !== undefined) {
            data = data.filter((entry) => entry.index !== config.dropIndex);
        }
        if (config.unordered) {
            data = data.reverse();
        }

        return {
            ok: true,
            status: 200,
            json: async () => ({
                object: "list",
                model: body.model,
                data,
                usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
            }),
        };
    };

    return {
        impl,
        calls,
        get requestCount() {
            return calls.length;
        },
        /** input_type values actually sent, in call order. */
        get modes() {
            return calls.map((call) => call.body.input_type);
        },
        /** Every string that was embedded, across all calls, in order. */
        get texts() {
            return calls.flatMap((call) => call.body.input);
        },
    };
}

/** A throwaway storage root, removed by withTempRoot(). */
export async function makeTempRoot(prefix = "artemis-rag-") {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Run `body` against a temp storage root and guarantee cleanup. */
export async function withTempRoot(body) {
    const root = await makeTempRoot();
    try {
        return await body(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

/**
 * Build a RagService wired to the fake endpoint.
 * `dimensions` is overridden down to FAKE_DIMS so tests stay fast; the real
 * registry value (2048) is exercised by the embeddings tests instead.
 */
export async function makeRagService({ root, fetchImpl, dimensions = FAKE_DIMS, options = {}, parseDocument = null }) {
    const { RagService } = await import("../ai-agent/rag/service.js");

    return new RagService({
        apiKey: "nvapi-test-key-for-unit-tests-only",
        storageRoot: root,
        dimensions,
        fetchImpl,
        parseDocument,
        options,
    });
}
