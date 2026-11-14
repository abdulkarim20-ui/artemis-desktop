/**
 * ============================================================================
 * EMBEDDINGS ADAPTER (rag/embeddings.js)
 * ============================================================================
 * Talks to NVIDIA NIM's OpenAI-compatible embeddings endpoint:
 *
 *   POST https://integrate.api.nvidia.com/v1/embeddings
 *
 * Uses plain fetch rather than the OpenAI SDK on purpose. The request needs
 * NVIDIA-specific fields (`input_type`, `truncate`, `modality`) that are not
 * part of the OpenAI schema, and fetch keeps those explicit, dependency-free
 * and stubbable in tests.
 *
 * PRIVACY: this is a hosted endpoint. Every string passed to embed() leaves the
 * machine. That is inherent to any remote embedding model and is the reason the
 * caller has to opt in per collection - see rag/service.js.
 * ============================================================================
 */

import { l2Normalize, truncateDimensions } from "./vector-math.js";
import { createHash } from "node:crypto";

/** Asymmetric bi-encoder modes. Getting these backwards silently wrecks recall. */
export const EMBED_MODES = Object.freeze({
    /** Indexing: embed corpus chunks. */
    PASSAGE: "passage",
    /** Searching: embed the user's question. */
    QUERY: "query",
});

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** An embedding failure the caller is expected to report, not crash on. */
export class EmbeddingError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "EmbeddingError";
        this.code = code;
        this.status = details.status ?? null;
        if (details.attempt) this.attempt = details.attempt;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull a message out of whichever error shape NIM/OpenAI returned. */
function extractErrorMessage(payload, status) {
    if (!payload || typeof payload !== "object") return `HTTP ${status}`;
    const candidates = [
        payload.error?.message,
        payload.detail,
        payload.message,
        typeof payload.error === "string" ? payload.error : null,
    ];
    return candidates.find((value) => typeof value === "string" && value.trim()) || `HTTP ${status}`;
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Order of results matches order of inputs, which the caller relies on to line
 * embeddings up with the chunks they came from.
 */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;

    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}

export class NvidiaEmbeddings {
    /**
     * @param {object} options
     * @param {string} options.model      API model id, e.g. nvidia/nemotron-3.5-embed-1b
     * @param {string} options.baseUrl    e.g. https://integrate.api.nvidia.com/v1
     * @param {string} options.apiKey
     * @param {number} [options.dimensions] keep the first N dims (renormalized); default: whatever the model returns
     * @param {object} [options.request]   extra body fields from config/embeddings.json
     * @param {number} [options.batchSize]
     * @param {number} [options.maxConcurrentBatches]
     * @param {number} [options.maxInFlight] global cap on HTTP requests in flight across all embed() calls
     * @param {number} [options.timeoutMs]
     * @param {number} [options.retries]
     * @param {typeof fetch} [options.fetchImpl] injectable for tests
     */
    constructor(options) {
        this.model = options.model;
        this.baseUrl = String(options.baseUrl || "").replace(/\/+$/, "");
        this.apiKey = options.apiKey;
        this.request = options.request || {};
        this.batchSize = Math.max(1, options.batchSize || 16);
        this.maxConcurrentBatches = Math.max(1, options.maxConcurrentBatches || 2);
        this.timeoutMs = options.timeoutMs || 60000;
        this.retries = Math.max(1, options.retries || 3);
        this.fetchImpl = options.fetchImpl || globalThis.fetch;

        /** Global ceiling on simultaneous HTTP requests, shared by every embed() call. */
        this.maxInFlight = Math.max(1, options.maxInFlight || 6);
        this.#inFlight = 0;
        this.#queue = [];
        this.#cache = new Map();

        /** Set once the first response arrives; every later vector must match. */
        this.dimensions = options.dimensions || null;
    }

    #inFlight;
    #queue;
    #cache;

    /**
     * Take one of maxInFlight slots, waiting for a release when none is free.
     * A released slot is handed straight to the next queued waiter, so the
     * counter is untouched on that path.
     */
    async #acquire() {
        if (this.#inFlight < this.maxInFlight) {
            this.#inFlight += 1;
            return;
        }
        await new Promise((resolve) => this.#queue.push(resolve));
    }

    #release() {
        const next = this.#queue.shift();
        if (next) next();
        else this.#inFlight -= 1;
    }

    /** Same text, model, dims and mode is the same vector, always. */
    #cacheKey(text, mode) {
        return createHash("sha1")
            .update(`${this.model}|${this.dimensions}|${mode}|${text}`)
            .digest("hex");
    }

    #cacheSet(key, vector) {
        this.#cache.set(key, vector);
        // ~4 KB per 1024-dim vector: 4000 entries is about 16 MB.
        while (this.#cache.size > 4000) this.#cache.delete(this.#cache.keys().next().value);
    }

    get isConfigured() {
        return Boolean(this.apiKey && this.baseUrl && this.model);
    }

    /**
     * Embed a list of strings.
     *
     * @param {object} params
     * @param {string[]} params.texts
     * @param {'passage'|'query'} params.mode REQUIRED. There is no default:
     *   NVIDIA's docs warn that mixing up passage and query causes "large drops
     *   in retrieval accuracy", and a silent default is how that happens.
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<Float32Array[]>} one normalized vector per input, in order
     * @throws {EmbeddingError}
     */
    async embed({ texts, mode, signal }) {
        if (!this.isConfigured) {
            throw new EmbeddingError("noApiKey", "NVIDIA_API_KEY is not configured in the project-root .env, so nothing can be embedded.");
        }

        const modes = Object.values(EMBED_MODES);
        if (!modes.includes(mode)) {
            throw new EmbeddingError(
                "badMode",
                `embed() needs an explicit input_type of "${modes.join('" or "')}" (got ${JSON.stringify(mode)}). ` +
                "passage is for indexing, query is for searching; they are not interchangeable."
            );
        }

        const list = Array.isArray(texts) ? texts : [];
        const cleaned = list.map((text) => String(text ?? ""));

        if (cleaned.length === 0) return [];
        if (cleaned.some((text) => !text.trim())) {
            // An empty string still costs a request and yields a meaningless
            // vector that can rank above real content. Fail loudly instead.
            throw new EmbeddingError("emptyInput", "refusing to embed an empty string; filter empty chunks before calling embed()");
        }

        // Identical text (same model, dims, mode) is never embedded twice. This
        // also makes re-indexing an edited file cheap: only the changed chunks
        // go out.
        const keys = cleaned.map((text) => this.#cacheKey(text, mode));
        const out = new Array(cleaned.length);
        const missing = [];
        keys.forEach((key, i) => {
            const cached = this.#cache.get(key);
            if (cached) out[i] = cached;
            else missing.push(i);
        });

        if (missing.length) {
            // Dedupe within the call as well: the cache is written after the
            // requests finish, so without this, two copies of the same text in
            // one embed() would each cost a request.
            const uniqueTexts = [];
            const slotOf = new Map(); // cacheKey -> position in uniqueTexts
            const slotFor = missing.map((originalIndex) => {
                const key = keys[originalIndex];
                let slot = slotOf.get(key);
                if (slot === undefined) {
                    slot = uniqueTexts.length;
                    slotOf.set(key, slot);
                    uniqueTexts.push(cleaned[originalIndex]);
                }
                return slot;
            });

            const batches = [];
            for (let i = 0; i < uniqueTexts.length; i += this.batchSize) {
                batches.push(uniqueTexts.slice(i, i + this.batchSize));
            }

            // The limiter (#acquire) is the real concurrency control; let every
            // batch queue.
            const perBatch = await mapWithConcurrency(
                batches,
                Math.min(batches.length, this.maxInFlight),
                (batch) => this.#embedBatchSafe(batch, mode, signal)
            );

            // mapWithConcurrency preserves input order, so the flattened
            // vectors line up with uniqueTexts.
            const vectors = perBatch.flat();
            if (vectors.length !== uniqueTexts.length) {
                throw new EmbeddingError(
                    "badResponse",
                    `the embedding API returned ${vectors.length} vectors for ${uniqueTexts.length} inputs`
                );
            }

            missing.forEach((originalIndex, position) => {
                out[originalIndex] = vectors[slotFor[position]];
                this.#cacheSet(keys[originalIndex], vectors[slotFor[position]]);
            });
        }

        return out;
    }

    /** Embed one string. Convenience wrapper around embed(). */
    async embedOne(text, mode, signal) {
        const [vector] = await this.embed({ texts: [text], mode, signal });
        return vector;
    }

    /**
     * One bad chunk must not sink a whole document. On a server-side failure
     * (NVIDIA answers a bad batch with a 500), split the batch in half and
     * recurse so the offending chunk is isolated instead of retried as part of
     * an otherwise-valid batch. Any other error, or a single-item batch that
     * still fails, propagates unchanged.
     */
    async #embedBatchSafe(batch, mode, signal) {
        try {
            // The limiter is the real concurrency control: every HTTP request
            // this adapter ever sends holds one of maxInFlight slots, no
            // matter how many embed() calls are running at once.
            await this.#acquire();
            try {
                return await this.#embedBatch(batch, mode, signal);
            } finally {
                this.#release();
            }
        } catch (error) {
            if (error?.code === "serverError" && batch.length > 1) {
                const mid = Math.ceil(batch.length / 2);
                const left = await this.#embedBatchSafe(batch.slice(0, mid), mode, signal);
                const right = await this.#embedBatchSafe(batch.slice(mid), mode, signal);
                return [...left, ...right];
            }
            throw error;
        }
    }

    async #embedBatch(batch, mode, signal) {
        // NVIDIA's schema wants `modality` as either one value for the whole
        // batch or one value per item. A 1-element array against a multi-item
        // batch is ambiguous and the inference layer can 500 on it, so collapse
        // a single-element array to its scalar before sending.
        const rawModality = this.request.modality ?? "text";
        const modality =
            Array.isArray(rawModality) && rawModality.length === 1 ? rawModality[0] : rawModality;

        const body = {
            model: this.model,
            input: batch,
            // input_type is the passage/query switch. It is a NVIDIA extension to
            // the OpenAI schema, which is exactly why this file uses fetch.
            input_type: mode,
            encoding_format: this.request.encoding_format || "float",
            modality,
            // Server-side Matryoshka truncation (valid range 128..2048). Smaller
            // JSON responses, smaller store, faster cosine. Vectors are still
            // re-normalised below.
            ...(this.dimensions ? { dimensions: this.dimensions } : {}),
            // "NONE" makes an over-limit input an error instead of quietly
            // dropping its tail. The chunker keeps us under the limit, so if
            // this ever fires it is a bug worth seeing.
            truncate: this.request.truncate || "NONE",
        };

        let lastError = null;

        for (let attempt = 1; attempt <= this.retries; attempt += 1) {
            if (signal?.aborted) throw new EmbeddingError("aborted", "embedding request was cancelled");

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            const onAbort = () => controller.abort();
            signal?.addEventListener("abort", onAbort, { once: true });

            try {
                const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    const message = extractErrorMessage(payload, response.status);
                    lastError = new EmbeddingError(
                        this.#codeForStatus(response.status, message),
                        message,
                        { status: response.status, attempt }
                    );

                    if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
                        await sleep(attempt * 800);
                        continue;
                    }
                    throw lastError;
                }

                return this.#readVectors(payload, batch.length, attempt);
            } catch (error) {
                if (error instanceof EmbeddingError) throw error;

                const aborted = error?.name === "AbortError";
                lastError = new EmbeddingError(
                    aborted ? (signal?.aborted ? "aborted" : "timeout") : "network",
                    aborted
                        ? (signal?.aborted ? "embedding request was cancelled" : `the embedding API did not respond within ${this.timeoutMs}ms`)
                        : `could not reach the embedding API (${error?.message || "network error"})`,
                    { attempt }
                );

                if (lastError.code === "aborted") throw lastError;
                if (attempt < this.retries) {
                    await sleep(attempt * 800);
                    continue;
                }
                throw lastError;
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            }
        }

        throw lastError || new EmbeddingError("network", "the embedding request failed");
    }

    #codeForStatus(status, message) {
        if (status === 401 || status === 403) return "unauthorized";
        if (status === 404) return "notFound";
        if (status === 429) return "rateLimited";
        if (status === 503) return "overloaded";
        // truncate:"NONE" surfaces as a 400 naming the over-limit input.
        if (status === 400 && /exceed|too long|length|token/i.test(message)) return "inputTooLong";
        if (status >= 500) return "serverError";
        return "badRequest";
    }

    #readVectors(payload, expected, attempt) {
        const data = payload?.data;
        if (!Array.isArray(data)) {
            throw new EmbeddingError("badResponse", "the embedding API returned no data array", { attempt });
        }

        // The API may answer out of order; `index` is the contract that puts it back.
        const ordered = new Array(expected);
        for (const entry of data) {
            const index = Number(entry?.index);
            if (!Number.isInteger(index) || index < 0 || index >= expected) continue;
            if (!Array.isArray(entry.embedding)) continue;
            ordered[index] = entry.embedding;
        }

        const missing = ordered.findIndex((vector) => vector === undefined);
        if (missing !== -1) {
            throw new EmbeddingError(
                "badResponse",
                `the embedding API skipped input #${missing} (${data.length} of ${expected} returned)`,
                { attempt }
            );
        }

        const vectors = ordered.map((raw) => {
            let vector = raw instanceof Float32Array ? raw : Float32Array.from(raw);
            vector = truncateDimensions(vector, this.dimensions);
            return l2Normalize(vector);
        });

        // Lock in the width on first success. A collection whose vectors differ
        // in dimension cannot be searched, so catch it here rather than at query
        // time when the store would only see garbage scores.
        const width = vectors[0].length;
        if (this.dimensions && this.dimensions !== width) {
            throw new EmbeddingError(
                "dimensionMismatch",
                `expected ${this.dimensions}-dimensional embeddings but the API returned ${width}`
            );
        }
        if (!this.dimensions) this.dimensions = width;

        const mismatched = vectors.find((vector) => vector.length !== width);
        if (mismatched) {
            throw new EmbeddingError("dimensionMismatch", "the embedding API returned vectors of differing lengths in one batch");
        }

        return vectors;
    }
}

/**
 * Build an adapter from a config/embeddings.json entry.
 * Separated from the constructor so tests can build one without a registry.
 */
export async function createEmbeddings({ model, apiKey, overrides = {} }) {
    return new NvidiaEmbeddings({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKey,
        dimensions: overrides.dimensions || model.dimensions || null,
        request: { ...(model.request || {}), ...(overrides.request || {}) },
        batchSize: overrides.batchSize,
        maxConcurrentBatches: overrides.maxConcurrentBatches,
        maxInFlight: overrides.maxInFlight,
        timeoutMs: overrides.timeoutMs,
        retries: overrides.retries,
        fetchImpl: overrides.fetchImpl,
    });
}
