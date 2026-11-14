/**
 * ============================================================================
 * RAG SERVICE (rag/service.js)
 * ============================================================================
 * The only module the HTTP layer and the chat runtime talk to. Everything else
 * in rag/ is a single-responsibility piece that this wires together:
 *
 *   ingest.js      bytes -> normalized text
 *   chunker.js     text -> chunks with line numbers
 *   embeddings.js  chunks -> vectors (NVIDIA, hosted)
 *   vector-store   vectors -> disk + cosine search
 *   retriever.js   question -> ranked chunks
 *   context-block  ranked chunks -> <retrieved_context>
 *
 * Initialization is lazy. A missing NVIDIA_API_KEY must not stop the agent from
 * booting or break chat: RAG simply reports itself as unavailable and every
 * caller degrades to the behaviour that existed before it.
 * ============================================================================
 */

import { createHash } from "node:crypto";

import { chunkDocument } from "./chunker.js";
import { RAG_DEFAULTS, resolveEmbeddingModel, resolveStorageRoot } from "./config.js";
import { buildRetrievedContext } from "./context-block.js";
import { EMBED_MODES, EmbeddingError, NvidiaEmbeddings } from "./embeddings.js";
import { IngestError, contentHash, prepareDocument } from "./ingest.js";
import { Retriever, classifyIntent, namedDocIds, toQueryText } from "./retriever.js";
import { VectorStore, sanitizeCollectionId } from "./vector-store.js";

/** A RAG failure the caller reports; chat must survive it. */
export class RagError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "RagError";
        this.code = code;
        Object.assign(this, details);
    }
}

/** Stable id for a file inside a collection: same path always replaces itself. */
export function documentId(name) {
    return createHash("sha256").update(String(name || "")).digest("hex").slice(0, 32);
}

export class RagService {
    /**
     * @param {object} [deps]
     * @param {string} [deps.apiKey] defaults to process.env.NVIDIA_API_KEY
     * @param {string} [deps.modelId] defaults to the registry default
     * @param {string} [deps.storageRoot] defaults to resolveStorageRoot()
     * @param {number} [deps.dimensions] store fewer dimensions than the model
     *   returns. The Nemotron card states truncated embeddings stay effective
     *   for retrieval provided they are re-normalized afterwards, which
     *   truncateDimensions() does. A collection's width is fixed for life, so
     *   changing this requires re-indexing.
     * @param {Function} [deps.parseDocument] the anydoc converter
     * @param {typeof fetch} [deps.fetchImpl] injectable for tests
     * @param {object} [deps.options] overrides for RAG_DEFAULTS
     */
    constructor(deps = {}) {
        this.deps = deps;
        this.options = { ...RAG_DEFAULTS, ...(deps.options || {}) };
        this.storageRoot = deps.storageRoot || resolveStorageRoot();
        this.parseDocument = deps.parseDocument || null;

        this.#ready = null;
        this.#disabled = /^(1|true|yes)$/i.test(String(process.env.ARTEMIS_RAG_DISABLED || "").trim());
    }

    #ready;
    #disabled;

    /** True when the user (or a deployment) turned retrieval off entirely. */
    get disabled() {
        return this.#disabled;
    }

    /**
     * Resolve the model, key and store once.
     * Cached as a promise so concurrent ingests do not each rebuild it, and
     * reset on failure so a later call can succeed once the key is fixed.
     */
    async #ensureReady() {
        if (this.#disabled) {
            throw new RagError("disabled", "retrieval is disabled (ARTEMIS_RAG_DISABLED is set)");
        }
        if (this.#ready) return this.#ready;

        this.#ready = (async () => {
            const model = await resolveEmbeddingModel(this.deps.modelId);

            if (!Number.isInteger(model.dimensions) || model.dimensions <= 0) {
                throw new RagError(
                    "badRegistry",
                    `${model.id} has no usable "dimensions" value; the vector store needs a fixed width up front`
                );
            }

            const dims = this.deps.dimensions || this.options.embeddingDims || model.dimensions;
            if (!Number.isInteger(dims) || dims <= 0 || dims > model.dimensions) {
                throw new RagError(
                    "badDimensions",
                    `requested ${dims} dimensions but ${model.id} produces ${model.dimensions}`
                );
            }

            const apiKey = String(this.deps.apiKey ?? process.env[model.apiKeyEnv] ?? "").trim();
            if (!apiKey) {
                throw new RagError(
                    "noApiKey",
                    `${model.apiKeyEnv} is not set in the project-root .env, so nothing can be embedded or searched`
                );
            }

            const embeddings = new NvidiaEmbeddings({
                model: model.model,
                baseUrl: model.baseUrl,
                apiKey,
                dimensions: dims,
                request: model.request,
                batchSize: this.options.batchSize,
                maxConcurrentBatches: this.options.maxConcurrentBatches,
                maxInFlight: this.options.maxInFlightRequests,
                timeoutMs: this.options.requestTimeoutMs,
                retries: this.options.retries,
                fetchImpl: this.deps.fetchImpl,
            });

            const store = new VectorStore(this.storageRoot);
            const descriptor = { model: model.model, dims };

            return {
                model,
                embeddings,
                store,
                descriptor,
                dims,
                retriever: new Retriever({ embeddings, store, descriptor }),
            };
        })().catch((error) => {
            // Let the next call try again: a key added to .env after startup, or
            // a registry fix, should not need an app restart to take effect.
            this.#ready = null;
            throw error instanceof RagError ? error : new RagError("init", error.message || "retrieval failed to initialize");
        });

        return this.#ready;
    }

    /**
     * Honest capability report for the UI and for /api/rag/status.
     * Never throws: "unavailable, and here is why" is the whole point.
     */
    async status() {
        const base = {
            enabled: !this.#disabled,
            storageRoot: this.storageRoot,
            model: null,
            dims: null,
            configured: false,
            reason: null,
        };

        if (this.#disabled) {
            return { ...base, reason: "retrieval is disabled (ARTEMIS_RAG_DISABLED is set)" };
        }

        try {
            const ready = await this.#ensureReady();
            return {
                ...base,
                configured: true,
                model: ready.model.id,
                dims: ready.dims,
                modelDims: ready.model.dimensions,
                hosted: true,
            };
        } catch (error) {
            return { ...base, reason: error.message || String(error) };
        }
    }

    /**
     * Fire-and-forget: opens the TLS connection and loads the model path so
     * the first real question does not pay DNS + TLS + cold-endpoint latency.
     * Never throws; not configured or offline are normal states the normal
     * paths already report properly.
     */
    async warmUp() {
        if (this.#disabled) return;
        try {
            const ready = await this.#ensureReady();
            await ready.embeddings.embedOne("warm up", EMBED_MODES.QUERY);
        } catch {
            // Not configured or offline: normal paths report that properly.
        }
    }

    /**
     * Index one file into a collection.
     *
     * Idempotent by content hash: re-sending an unchanged file costs nothing,
     * which matters because the renderer attaches the same files to every
     * message in a conversation.
     *
     * Three outcomes, and the distinction is the point:
     *   'indexed'   - chunks were embedded and written.
     *   'unchanged' - the same bytes were already in the collection. Not a
     *                 failure, and still searchable.
     *   'skipped'   - the file has no indexable text (a scanned PDF, an image,
     *                 an executable). Resolved, not thrown, because in a batch
     *                 of attachments this is an expected outcome. `code` says
     *                 which and `skippedReason` is a sentence for the user.
     *
     * Anything else - a bad API key, a document that needs more chunks than the
     * per-file limit allows - throws, because those are not per-file facts.
     *
     * @returns {Promise<{
     *   status: 'indexed'|'unchanged'|'skipped', docId: string, path: string, chunks: number,
     *   kind?: string, language?: string, convertedFrom?: string, truncated?: boolean,
     *   replaced?: boolean, chars?: number,
     *   code?: string, skippedReason?: string, pages?: number[], pageCount?: number
     * }>}
     * @throws {RagError}
     */
    async ingestFile({ collection, bytes, name, signal }) {
        const ready = await this.#ensureReady();
        const collectionId = sanitizeCollectionId(collection);
        const filePath = String(name || "file");

        // Fast path: identical bytes already indexed under this name. The stored
        // hash is the hash of the raw bytes, so no conversion is needed to know
        // that nothing changed. This is what makes re-sending attachments free.
        {
            const earlyDocId = documentId(filePath);
            const earlyOpened = await ready.store.open(collectionId, ready.descriptor);
            const prior = earlyOpened.documents.get(earlyDocId);
            if (prior && prior.hash === contentHash(bytes)) {
                return {
                    status: "unchanged",
                    docId: earlyDocId,
                    path: filePath,
                    chunks: prior.chunks,
                    kind: prior.kind,
                    language: prior.language,
                    convertedFrom: prior.convertedFrom,
                    truncated: prior.truncated,
                };
            }
        }

        const t = { start: Date.now() };
        let prepared;
        try {
            prepared = await prepareDocument({
                bytes,
                name: filePath,
                parseDocument: this.parseDocument,
                maxTextChars: this.options.maxDocumentTextChars,
            });
        } catch (error) {
            if (error instanceof IngestError) {
                // Not a failure of the pipeline: this file simply cannot be
                // indexed. Report it the same way /api/parse reports a skip.
                return {
                    status: "skipped",
                    docId: documentId(filePath),
                    path: filePath,
                    chunks: 0,
                    code: error.code,
                    skippedReason: error.message,
                    ...(error.pages ? { pages: error.pages, pageCount: error.pageCount } : {}),
                };
            }
            throw error;
        }
        t.parse = Date.now();

        const docId = documentId(filePath);
        const opened = await ready.store.open(collectionId, ready.descriptor);

        const existing = opened.documents.get(docId);
        if (existing && existing.hash === prepared.hash) {
            return {
                status: "unchanged",
                docId,
                path: filePath,
                chunks: existing.chunks,
                kind: prepared.kind,
                language: prepared.language,
                convertedFrom: prepared.convertedFrom,
                truncated: prepared.truncated,
            };
        }

        const chunks = chunkDocument({
            text: prepared.text,
            kind: prepared.kind,
            path: filePath,
            language: prepared.language,
            convertedFrom: prepared.convertedFrom,
            options: this.options,
        });
        t.chunk = Date.now();

        if (chunks.length === 0) {
            return {
                status: "skipped",
                docId,
                path: filePath,
                chunks: 0,
                code: "noChunks",
                skippedReason: "the file produced no chunks worth indexing",
            };
        }

        if (chunks.length > this.options.maxChunksPerDocument) {
            throw new RagError(
                "tooManyChunks",
                `${filePath} would need ${chunks.length} chunks, above the ${this.options.maxChunksPerDocument} per-file limit`
            );
        }

        let vectors;
        try {
            // PASSAGE mode: these are corpus documents, not questions.
            vectors = await ready.embeddings.embed({
                texts: chunks.map((chunk) => chunk.embeddingInput),
                mode: EMBED_MODES.PASSAGE,
                signal,
            });
        } catch (error) {
            if (error instanceof EmbeddingError) {
                console.error("[RAG embed]", filePath, error.code, error.status, error.message);
            }
            throw error instanceof EmbeddingError
                ? new RagError(error.code, `${filePath}: ${error.message}`, { status: error.status })
                : error;
        }
        t.embed = Date.now();

        const result = await opened.addDocument({
            docId,
            path: filePath,
            hash: prepared.hash,
            kind: prepared.kind,
            language: prepared.language,
            convertedFrom: prepared.convertedFrom,
            truncated: prepared.truncated,
            chunks,
            vectors,
        });
        t.store = Date.now();

        console.log(
            `[rag] ${filePath}: parse ${t.parse - t.start}ms, chunk ${t.chunk - t.parse}ms, ` +
            `embed ${t.embed - t.chunk}ms (${chunks.length} chunks), store ${t.store - t.embed}ms`
        );

        return {
            status: "indexed",
            docId,
            path: filePath,
            chunks: result.chunks,
            replaced: result.replaced,
            kind: prepared.kind,
            language: prepared.language,
            convertedFrom: prepared.convertedFrom,
            truncated: prepared.truncated,
            chars: prepared.chars,
        };
    }

    /**
     * Search a collection and render the block that goes into the prompt.
     *
     * @returns {Promise<{ block: string, sources: Array<object>, included: Array<object>, hits: number, dropped: number, skipped: string|null, query: string }>}
     */
    async retrieveContext({ collection, query, topK, budgetChars, excludeDocIds, signal }) {
        const ready = await this.#ensureReady();
        const collectionId = sanitizeCollectionId(collection);
        const started = Date.now();

        const opened = await ready.store.open(collectionId, ready.descriptor);
        const docs = [...opened.documents.values()];
        const files = docs.map((doc) => doc.path);

        const cleaned = toQueryText(query);
        const intent = classifyIntent(cleaned);

        // A question that names a file ("in the RAG doc ...") searches only that file.
        const named = namedDocIds(docs, cleaned);
        const scopedExclude = named.length
            ? [...new Set([...(excludeDocIds || []), ...docs.filter((d) => !named.includes(d.docId)).map((d) => d.docId)])]
            : excludeDocIds;

        const run = (exclude) =>
            intent === "overview"
                ? ready.retriever.overview({
                    collection: collectionId,
                    query: cleaned,
                    budgetChars: budgetChars || this.options.maxContextChars,
                    excludeDocIds: exclude,
                })
                : ready.retriever.retrieve({
                    collection: collectionId,
                    query,
                    topK: topK || this.options.topK,
                    minScore: this.options.minScore,
                    excludeDocIds: exclude,
                    signal,
                });

        let found;
        try {
            found = await run(scopedExclude);
            // The named file may not hold the answer; never hide the rest of the corpus on a guess.
            if (named.length && found.hits.length === 0) found = await run(excludeDocIds);
        } catch (error) {
            if (error instanceof EmbeddingError) {
                throw new RagError(error.code, error.message, { status: error.status });
            }
            throw error;
        }

        const rendered = buildRetrievedContext({
            hits: found.hits,
            query: found.query,
            collection: collectionId,
            skipped: found.skipped,
            budgetChars: budgetChars || this.options.maxContextChars,
            files,
            mode: found.mode || "search",
            sampled: Boolean(found.sampled),
        });

        console.log(
            `[rag] retrieval ${Date.now() - started}ms, intent=${intent}${named.length ? ", scoped" : ""}, ` +
            `${rendered.included.length} hits`
        );

        return {
            block: rendered.block,
            sources: rendered.included,
            included: rendered.included,
            hits: rendered.included.length,
            dropped: rendered.dropped,
            skipped: found.skipped,
            query: found.query,
        };
    }

    /** Every collection on disk, newest first. */
    async listCollections() {
        const ready = await this.#ensureReady();
        const collections = await ready.store.list();
        return collections.map((entry) => ({ ...entry, matchesConfiguredModel: entry.model === ready.descriptor.model }));
    }

    async collectionStats(collection) {
        const ready = await this.#ensureReady();
        const opened = await ready.store.open(sanitizeCollectionId(collection), ready.descriptor);
        return opened.stats();
    }

    async deleteCollection(collection) {
        const ready = await this.#ensureReady();
        await ready.store.delete(sanitizeCollectionId(collection));
        return { ok: true };
    }

    /** Drop one file from a collection, addressed by the path it was indexed under. */
    async removeDocument({ collection, path }) {
        const ready = await this.#ensureReady();
        const opened = await ready.store.open(sanitizeCollectionId(collection), ready.descriptor);
        const removed = await opened.removeDocument(documentId(path));
        return { ok: removed, docId: documentId(path) };
    }

    /** Release cached collection handles (used when the storage root changes). */
    reset() {
        this.#ready = null;
    }
}
