/**
 * ============================================================================
 * VECTOR STORE (rag/vector-store.js)
 * ============================================================================
 * On-disk storage and cosine search for a collection of embedded chunks.
 *
 * Layout, one directory per collection under resolveStorageRoot():
 *
 *   meta.json     id, model, dims, timestamps, and the document list
 *   chunks.jsonl  one JSON object per line, in row order
 *   vectors.bin   Float32 little-endian, `dims` values per row, same row order
 *
 * Vectors live in a binary file, not in the JSON. A 2048-dim float written as
 * JSON text costs roughly 24 KB per chunk - about three times the size of the
 * chunk it describes - so a modest corpus would turn into tens of megabytes of
 * text that has to be parsed on every load. As Float32 it is 8 KB per chunk and
 * loads straight into a typed array with no parsing at all.
 *
 * There is deliberately no database and no native dependency. Search is a
 * linear scan over a Float32Array, which for a desktop-sized corpus costs tens
 * of milliseconds and cannot corrupt an index. Swapping in sqlite/HNSW later
 * means replacing this one module.
 * ============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";

import { RAG_DEFAULTS } from "./config.js";
import { searchMatrix } from "./vector-math.js";

const META_FILE = "meta.json";
const CHUNKS_FILE = "chunks.jsonl";
const VECTORS_FILE = "vectors.bin";
const BYTES_PER_FLOAT = 4;

/** A store-level problem the caller should report rather than crash on. */
export class VectorStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "VectorStoreError";
        this.code = code;
    }
}

/**
 * Collection ids become directory names, so they must be sanitized.
 * Rejecting traversal explicitly is cheaper than reasoning about it later.
 */
export function sanitizeCollectionId(raw) {
    const id = String(raw || "").trim();
    if (!id) throw new VectorStoreError("badCollectionId", "a collection id is required");
    if (id.includes("..")) throw new VectorStoreError("badCollectionId", "a collection id may not contain '..'");

    const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    if (!cleaned) throw new VectorStoreError("badCollectionId", `"${id}" contains no usable characters`);
    return cleaned;
}

/** Write to a temp file then rename, so a crash mid-write cannot truncate a collection. */
async function atomicWrite(file, data) {
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
}

/**
 * Copy a Float32Array's bytes into a Buffer.
 * Going through Buffer.from(array.buffer) directly is wrong for any view that
 * is a subarray, because it would write the whole underlying allocation.
 */
function float32ToBuffer(vector) {
    return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

export class Collection {
    /**
     * @param {string} dir
     * @param {{ id: string, model: string, dims: number }} descriptor
     */
    constructor(dir, descriptor) {
        this.dir = dir;
        this.id = descriptor.id;
        this.model = descriptor.model;
        this.dims = descriptor.dims;

        /** @type {Array<object>} chunk records, index == vector row */
        this.chunks = [];
        /** @type {Float32Array} */
        this.vectors = new Float32Array(0);
        /** @type {Map<string, object>} */
        this.documents = new Map();

        this.createdAt = null;
        this.updatedAt = null;

        // Writes are serialized. Two concurrent ingests appending to the same
        // JSONL file would interleave partial lines and corrupt the collection.
        this.#queue = Promise.resolve();
        this.loaded = false;
    }

    #queue;

    #serialize(task) {
        const run = this.#queue.then(task, task);
        // Never let a failed task break the chain for the next caller.
        this.#queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /* ------------------------------ loading ------------------------------ */

    async load() {
        if (this.loaded) return this;
        return this.#serialize(() => this.#loadCore());
    }

    /** The real load. Callers already holding the write lock use this directly. */
    async #loadCore() {
        if (this.loaded) return this;

        await fs.mkdir(this.dir, { recursive: true });

        try {
            const raw = await fs.readFile(path.join(this.dir, META_FILE), "utf8");
            const meta = JSON.parse(raw);

            if (meta.model && meta.model !== this.model) {
                throw new VectorStoreError(
                    "modelChanged",
                    `this collection was embedded with ${meta.model} but ${this.model} is configured now. ` +
                    "Vectors from different models are not comparable, so the collection must be rebuilt."
                );
            }
            if (meta.dims && meta.dims !== this.dims) {
                throw new VectorStoreError(
                    "dimensionsChanged",
                    `this collection stores ${meta.dims}-dimensional vectors but ${this.dims} is configured now. ` +
                    "Delete the collection and index the files again."
                );
            }

            this.createdAt = meta.createdAt || null;
            this.updatedAt = meta.updatedAt || null;
            this.documents = new Map(Object.entries(meta.documents || {}));
        } catch (error) {
            if (error instanceof VectorStoreError) throw error;
            if (error.code !== "ENOENT") throw error;
            // No meta.json yet: a brand new collection.
        }

        this.chunks = await this.#readChunks();
        this.vectors = await this.#readVectors(this.chunks.length);
        this.loaded = true;

        // A previous run was interrupted mid-write (or a removal never got to
        // rewrite the files). Repair now, while memory and disk are known to
        // agree, rather than leaving a collection that limps.
        if (this.needsCompaction) await this.#compact();

        return this;
    }

    async #readChunks() {
        let raw;
        try {
            raw = await fs.readFile(path.join(this.dir, CHUNKS_FILE), "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }

        const chunks = [];
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
                chunks.push(JSON.parse(line));
            } catch {
                // A torn final line from a killed process must not make the whole
                // collection unreadable. Drop it and let compaction rewrite.
                console.warn(`[VectorStore] Skipping a corrupt chunk line in ${this.id}`);
            }
        }
        return chunks;
    }

    async #readVectors(expectedRows) {
        let buffer;
        try {
            buffer = await fs.readFile(path.join(this.dir, VECTORS_FILE));
        } catch (error) {
            if (error.code === "ENOENT") buffer = Buffer.alloc(0);
            else throw error;
        }

        const availableRows = Math.floor(buffer.length / (this.dims * BYTES_PER_FLOAT));

        if (availableRows !== expectedRows) {
            // Chunk text and vectors disagreed - the only way this happens is an
            // interrupted write. Keep the rows that are consistent and force a
            // compaction so the next save repairs the files.
            console.warn(
                `[VectorStore] ${this.id}: ${expectedRows} chunks but ${availableRows} vectors on disk; trimming to match`
            );
            const keep = Math.min(availableRows, expectedRows);
            this.chunks.length = keep;
            this.needsCompaction = true;
        }

        const bytes = buffer.subarray(0, this.chunks.length * this.dims * BYTES_PER_FLOAT);
        // Copy out of the Buffer: the returned Float32Array must not alias
        // memory we are about to replace on the next addDocument().
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return new Float32Array(copy.buffer);
    }

    /* ------------------------------ writing ------------------------------ */

    /**
     * Add one document's chunks and vectors.
     *
     * @param {object} doc
     * @param {string} doc.docId
     * @param {string} doc.path
     * @param {string} doc.hash content hash, for idempotent re-ingestion
     * @param {string} [doc.kind] markdown | code | text
     * @param {string} [doc.language]
     * @param {string} [doc.convertedFrom]
     * @param {boolean} [doc.truncated]
     * @param {Array<object>} doc.chunks chunker output
     * @param {Float32Array[]} doc.vectors one per chunk, same order
     */
    async addDocument(doc) {
        return this.#serialize(async () => {
            if (!this.loaded) await this.#loadUnlocked();

            if (!doc?.chunks?.length) {
                throw new VectorStoreError("noChunks", `${doc?.path || "the file"} produced no indexable chunks`);
            }
            if (!Array.isArray(doc.vectors) || doc.chunks.length !== doc.vectors.length) {
                throw new VectorStoreError(
                    "chunkVectorMismatch",
                    `${doc.chunks.length} chunks but ${doc.vectors?.length ?? 0} vectors for ${doc.path}`
                );
            }
            // Validate every vector width up front, before anything below mutates
            // the collection. A replacement removes the previous copy first, so
            // discovering a bad width halfway through the loop would have already
            // deleted the good version of this document.
            for (const vector of doc.vectors) {
                if (!vector || vector.length !== this.dims) {
                    throw new VectorStoreError(
                        "dimensionMismatch",
                        `expected ${this.dims}-dimensional vectors but got ${vector?.length ?? 0} for ${doc.path}`
                    );
                }
            }
            if (this.documents.size >= RAG_DEFAULTS.maxDocumentsPerCollection && !this.documents.has(doc.docId)) {
                throw new VectorStoreError(
                    "collectionFull",
                    `this knowledge base already holds ${RAG_DEFAULTS.maxDocumentsPerCollection} files`
                );
            }
            if (this.chunks.length + doc.chunks.length > RAG_DEFAULTS.maxChunksPerCollection) {
                throw new VectorStoreError(
                    "collectionFull",
                    `this knowledge base would exceed ${RAG_DEFAULTS.maxChunksPerCollection} indexed chunks`
                );
            }

            // Re-indexing the same bytes replaces the old copy instead of
            // duplicating every chunk and doubling its weight in search results.
            const replacing = this.documents.has(doc.docId);
            if (replacing) {
                await this.#removeUnlocked(doc.docId);
                // The removal only touched memory; chunks.jsonl and vectors.bin
                // still hold the old rows, and everything below APPENDS. Without
                // rewriting now, the next load reads the superseded rows straight
                // back in and the old text returns from search next to its
                // replacement - a duplicate that only appears after a restart.
                await this.#compact();
            }

            const startRow = this.chunks.length;
            const jsonLines = [];

            for (let i = 0; i < doc.chunks.length; i += 1) {
                const chunk = doc.chunks[i];

                const record = {
                    id: `${doc.docId}#${chunk.seq}`,
                    docId: doc.docId,
                    path: doc.path,
                    seq: chunk.seq,
                    kind: chunk.kind || doc.kind || "text",
                    language: chunk.language || doc.language || "text",
                    convertedFrom: chunk.convertedFrom || doc.convertedFrom || "",
                    heading: chunk.heading || "",
                    symbol: chunk.symbol || "",
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    text: chunk.text,
                };

                this.chunks.push(record);
                jsonLines.push(JSON.stringify(record));
            }

            const appended = new Float32Array((startRow + doc.chunks.length) * this.dims);
            appended.set(this.vectors.subarray(0, startRow * this.dims), 0);
            for (let i = 0; i < doc.vectors.length; i += 1) {
                appended.set(doc.vectors[i], (startRow + i) * this.dims);
            }
            this.vectors = appended;

            this.documents.set(doc.docId, {
                docId: doc.docId,
                path: doc.path,
                hash: doc.hash || "",
                kind: doc.kind || "text",
                language: doc.language || "text",
                convertedFrom: doc.convertedFrom || "",
                truncated: Boolean(doc.truncated),
                chunks: doc.chunks.length,
                chars: doc.chunks.reduce((total, chunk) => total + (chunk.text?.length || 0), 0),
                addedAt: new Date().toISOString(),
            });

            // Append rather than rewrite: adding one file to a large collection
            // must not cost a full re-serialization of everything already stored.
            const appendedVectors = new Float32Array(doc.vectors.length * this.dims);
            doc.vectors.forEach((vector, index) => {
                appendedVectors.set(vector, index * this.dims);
            });

            await fs.appendFile(path.join(this.dir, CHUNKS_FILE), `${jsonLines.join("\n")}\n`, "utf8");
            await fs.appendFile(path.join(this.dir, VECTORS_FILE), float32ToBuffer(appendedVectors));

            await this.#writeMeta();
            return { docId: doc.docId, chunks: doc.chunks.length, replaced: replacing };
        });
    }

    /** Remove every chunk belonging to one document. */
    async removeDocument(docId) {
        return this.#serialize(async () => {
            if (!this.loaded) await this.#loadUnlocked();
            const removed = await this.#removeUnlocked(docId);
            if (removed) await this.#compact();
            return removed;
        });
    }

    async #removeUnlocked(docId) {
        if (!this.documents.has(docId)) return false;

        const keepRows = [];
        const keptChunks = [];
        for (let row = 0; row < this.chunks.length; row += 1) {
            if (this.chunks[row].docId === docId) continue;
            keepRows.push(row);
            keptChunks.push(this.chunks[row]);
        }

        const next = new Float32Array(keptChunks.length * this.dims);
        keepRows.forEach((row, index) => {
            next.set(this.vectors.subarray(row * this.dims, (row + 1) * this.dims), index * this.dims);
        });

        this.chunks = keptChunks;
        this.vectors = next;
        this.documents.delete(docId);
        this.needsCompaction = true;
        return true;
    }

    /** Rewrite every file from memory. Used after removals and to repair torn writes. */
    async #compact() {
        const lines = this.chunks.map((record) => JSON.stringify(record));
        await atomicWrite(path.join(this.dir, CHUNKS_FILE), lines.length ? `${lines.join("\n")}\n` : "");
        await atomicWrite(path.join(this.dir, VECTORS_FILE), float32ToBuffer(this.vectors));
        await this.#writeMeta();
        this.needsCompaction = false;
    }

    async #writeMeta() {
        const now = new Date().toISOString();
        this.updatedAt = now;
        if (!this.createdAt) this.createdAt = now;

        const meta = {
            id: this.id,
            model: this.model,
            dims: this.dims,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            chunkCount: this.chunks.length,
            documents: Object.fromEntries(this.documents),
        };
        await atomicWrite(path.join(this.dir, META_FILE), JSON.stringify(meta, null, 2));
    }

    /** Internal: load without taking the lock (caller already holds it). */
    async #loadUnlocked() {
        await this.#loadCore();
    }

    /* ------------------------------ searching ------------------------------ */

    /**
     * @param {ArrayLike<number>} queryVector must already be L2-normalized
     * @param {{ topK?: number, minScore?: number, excludeDocIds?: string[] }} [options]
     * @returns {Array<object>} hits, best first
     */
    search(queryVector, options = {}) {
        if (queryVector.length !== this.dims) {
            throw new VectorStoreError(
                "dimensionMismatch",
                `the query vector has ${queryVector.length} dimensions but this collection stores ${this.dims}`
            );
        }
        if (this.chunks.length === 0) return [];

        const topK = options.topK || RAG_DEFAULTS.topK;
        const minScore = options.minScore ?? RAG_DEFAULTS.minScore;
        const excluded = options.excludeDocIds ? new Set(options.excludeDocIds) : null;

        // Over-fetch, then apply the per-document cap. Taking exactly topK from
        // the matrix and filtering afterwards can return far fewer results than
        // asked for when one large document owns the top of the ranking.
        const raw = searchMatrix(this.vectors, this.dims, queryVector, {
            topK: topK * RAG_DEFAULTS.maxHitsPerDocument,
            minScore,
            skip: excluded ? (row) => excluded.has(this.chunks[row].docId) : null,
        });

        const perDocument = new Map();
        const hits = [];

        for (const { row, score } of raw) {
            const record = this.chunks[row];
            const seen = perDocument.get(record.docId) || 0;
            if (seen >= RAG_DEFAULTS.maxHitsPerDocument) continue;

            perDocument.set(record.docId, seen + 1);
            hits.push({
                chunkId: record.id,
                docId: record.docId,
                path: record.path,
                seq: record.seq,
                kind: record.kind,
                language: record.language,
                convertedFrom: record.convertedFrom,
                heading: record.heading,
                symbol: record.symbol,
                startLine: record.startLine,
                endLine: record.endLine,
                text: record.text,
                score: Number(score.toFixed(4)),
            });

            if (hits.length >= topK) break;
        }

        return hits;
    }

    /** Public summary used by the API and the UI. */
    stats() {
        const documents = [...this.documents.values()].map((doc) => ({
            docId: doc.docId,
            path: doc.path,
            kind: doc.kind,
            language: doc.language,
            convertedFrom: doc.convertedFrom,
            truncated: doc.truncated,
            chunks: doc.chunks,
            chars: doc.chars,
            addedAt: doc.addedAt,
        }));

        return {
            id: this.id,
            model: this.model,
            dims: this.dims,
            chunkCount: this.chunks.length,
            documentCount: this.documents.size,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
        };
    }

    /** Delete every file on disk. */
    async destroy() {
        return this.#serialize(async () => {
            await fs.rm(this.dir, { recursive: true, force: true });
            this.chunks = [];
            this.vectors = new Float32Array(0);
            this.documents = new Map();
            this.loaded = false;
        });
    }
}

/**
 * Opens collections under a root directory.
 * The root is resolved per call rather than cached so tests can point it at a
 * temp directory without touching process.env for the whole run.
 */
export class VectorStore {
    constructor(rootDir) {
        this.rootDir = rootDir;
        /** @type {Map<string, Collection>} */
        this.cache = new Map();
    }

    collectionDir(id) {
        return path.join(this.rootDir, sanitizeCollectionId(id));
    }

    /**
     * @param {string} id
     * @param {{ model: string, dims: number }} descriptor must match what is on disk
     */
    async open(id, descriptor) {
        const cleanId = sanitizeCollectionId(id);
        const cached = this.cache.get(cleanId);

        if (cached && cached.model === descriptor.model && cached.dims === descriptor.dims) {
            if (!cached.loaded) await cached.load();
            return cached;
        }

        const collection = new Collection(this.collectionDir(cleanId), {
            id: cleanId,
            model: descriptor.model,
            dims: descriptor.dims,
        });
        await collection.load();
        this.cache.set(cleanId, collection);
        return collection;
    }

    /** Every collection directory that has a readable meta.json. */
    async list() {
        let entries;
        try {
            entries = await fs.readdir(this.rootDir, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }

        const found = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                const raw = await fs.readFile(path.join(this.rootDir, entry.name, META_FILE), "utf8");
                const meta = JSON.parse(raw);
                found.push({
                    id: meta.id || entry.name,
                    model: meta.model,
                    dims: meta.dims,
                    chunkCount: meta.chunkCount || 0,
                    documentCount: Object.keys(meta.documents || {}).length,
                    createdAt: meta.createdAt || null,
                    updatedAt: meta.updatedAt || null,
                });
            } catch {
                // A half-written directory is not a collection; skip it rather
                // than failing the whole listing.
            }
        }

        return found.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    async delete(id) {
        const cleanId = sanitizeCollectionId(id);
        const cached = this.cache.get(cleanId);
        if (cached) {
            await cached.destroy();
            this.cache.delete(cleanId);
            return true;
        }
        const dir = this.collectionDir(cleanId);
        await fs.rm(dir, { recursive: true, force: true });
        return true;
    }

    /** Drop cached handles (used after ARTEMIS_RAG_DIR changes in tests). */
    reset() {
        this.cache.clear();
    }
}
