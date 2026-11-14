/**
 * ============================================================================
 * RAG CONFIGURATION (rag/config.js)
 * ============================================================================
 * Every tunable for the retrieval pipeline lives here, plus the loader for
 * config/embeddings.json.
 *
 * The embedding registry is deliberately a SEPARATE file from
 * config/model-registry.json. `GET /api/models` returns the whole chat registry
 * to the model selector, so an embedding model placed in `models[]` would show
 * up in the chat dropdown and then die inside streamChat(). Keeping them apart
 * makes that mistake structurally impossible rather than merely unlikely.
 * ============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(AGENT_DIR, "config", "embeddings.json");

/**
 * Retrieval defaults.
 *
 * Chunk sizes are in characters, not tokens: we do not ship a tokenizer, and a
 * character budget is predictable. ~4 chars/token is the usual estimate, so
 * chunkMaxChars 2400 is roughly 600 tokens - far under the model's 10240 token
 * context, which means `truncate: "NONE"` can stay on and an over-long input
 * becomes a loud error instead of silently dropped text.
 */
export const RAG_DEFAULTS = {
    /** Aim for chunks near this size. Fewer, bigger chunks mean fewer embedding requests. */
    chunkTargetChars: 2400,
    /** Never exceed this; the chunker hard-splits anything longer. */
    chunkMaxChars: 3600,
    /** Characters repeated from the end of one chunk at the start of the next. */
    chunkOverlapChars: 240,
    /** Below this a fragment is merged into its neighbour instead of standing alone. */
    minChunkChars: 80,

    /** Texts per embedding request. */
    batchSize: 32,
    /**
     * Embedding requests in flight at once per embed() call. Retained from the
     * pre-limiter design; embed() now sizes its worker pool with the GLOBAL
     * cap below, which is the real ceiling once several files index in
     * parallel. (Changing this value alone no longer changes concurrency.)
     */
    maxConcurrentBatches: 3,
    /**
     * GLOBAL cap on embedding HTTP requests in flight, shared by every
     * embed() call (see embeddings.js). With the renderer indexing several
     * files in parallel, per-call concurrency alone does not bound the total;
     * without this, 3 files x 3 batches would put 9 uncontrolled requests on
     * the hosted endpoint.
     */
    maxInFlightRequests: 6,
    /**
     * Store this many of the model's dimensions. The request asks the API for
     * server-side Matryoshka truncation (embeddings.js), and anything that
     * still arrives wider is cut and renormalized client-side. Halves the
     * response bytes and the store; the Nemotron card blesses truncated
     * embeddings for retrieval.
     */
    embeddingDims: 1024,
    requestTimeoutMs: 60000,
    retries: 3,

    /** Chunks handed to the model per question. */
    topK: 6,
    /** Most chunks taken from any single document per query, so one file cannot crowd out the rest. */
    maxHitsPerDocument: 3,
    /**
     * Cosine floor. Nemotron's real similarity scores sit far lower than the
     * usual 0.2+ heuristics from other models - measured around 0.04-0.09 on
     * genuine matches - so anything higher silently discards good hits.
     */
    minScore: 0.08,
    /** Hard cap on the assembled <retrieved_context> block. */
    maxContextChars: 18000,

    /** Corpus guards. */
    maxDocumentsPerCollection: 500,
    maxChunksPerDocument: 4000,
    /**
     * Whole-collection ceiling. Vectors stay resident in a Float32Array, so this
     * is a memory guard, not just a sanity check: 20000 chunks at 2048 dims is
     * about 160 MB in the agent process. Raise it only with that cost in mind.
     */
    maxChunksPerCollection: 20000,
    maxDocumentTextChars: 2000000,
};

/**
 * Where collections are written.
 *
 * A packaged Electron app cannot write inside its own install directory, so
 * main/ai-server.js passes ARTEMIS_DATA_DIR (Electron's userData path). Running
 * the agent standalone falls back to ai-agent/.data, which is git-ignored.
 */
export function resolveStorageRoot() {
    const explicit = process.env.ARTEMIS_RAG_DIR;
    if (explicit && explicit.trim()) return path.resolve(explicit.trim());

    const appData = process.env.ARTEMIS_DATA_DIR;
    if (appData && appData.trim()) return path.join(path.resolve(appData.trim()), "rag");

    return path.join(AGENT_DIR, ".data", "rag");
}

let registryCache = null;

/** @returns {Promise<object>} the parsed embedding registry (cached). */
export async function loadEmbeddingRegistry() {
    if (registryCache) return registryCache;

    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    const registry = JSON.parse(raw);

    if (!registry || !Array.isArray(registry.models) || registry.models.length === 0) {
        throw new Error("Invalid embedding registry: models[] is required");
    }

    const ids = new Set();
    for (const model of registry.models) {
        if (!model.id) throw new Error("Embedding registry entry is missing id");
        if (ids.has(model.id)) throw new Error(`Duplicate embedding model id: ${model.id}`);
        ids.add(model.id);
        if (!model.model) throw new Error(`Embedding model ${model.id} is missing API model`);
        if (!model.baseUrl) throw new Error(`Embedding model ${model.id} is missing baseUrl`);
        if (!model.apiKeyEnv) throw new Error(`Embedding model ${model.id} is missing apiKeyEnv`);
        // The store allocates fixed-width rows before the first response ever
        // arrives, so the width has to be declared rather than discovered.
        if (!Number.isInteger(model.dimensions) || model.dimensions <= 0) {
            throw new Error(`Embedding model ${model.id} needs a positive integer "dimensions"`);
        }
    }

    registryCache = registry;
    return registry;
}

/**
 * Resolve an embedding model by id, or the registry default.
 * Unknown ids throw rather than falling back: silently embedding a corpus with
 * a different model would make every stored vector incomparable to every query.
 */
export async function resolveEmbeddingModel(id) {
    const registry = await loadEmbeddingRegistry();
    const wanted = id || registry.defaultModel;
    const model = registry.models.find((entry) => entry.id === wanted);
    if (!model) {
        throw new Error(
            `Unknown embedding model: ${wanted}. Available: ${registry.models.map((m) => m.id).join(", ")}`
        );
    }
    return model;
}

/** Test/dev helper: drop the cached registry so edits to the JSON are picked up. */
export function clearRegistryCache() {
    registryCache = null;
}

export { AGENT_DIR };
