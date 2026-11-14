/**
 * ============================================================================
 * RAG MODULE PUBLIC SURFACE (rag/index.js)
 * ============================================================================
 * Retrieval-augmented generation for Artemis, built on NVIDIA NIM's
 * nvidia/nemotron-3.5-embed-1b.
 *
 * Callers outside rag/ should import from here. The pipeline, in order:
 *
 *   1. ingest.prepareDocument   raw bytes -> normalized text (anydoc for
 *                               office files and PDFs, plain decode for code)
 *   2. chunker.chunkDocument    text -> chunks, structure-aware, with the real
 *                               line numbers of the text they came from
 *   3. embeddings.embed         chunks -> vectors, input_type="passage"
 *   4. vector-store             vectors -> meta.json + chunks.jsonl + vectors.bin
 *   5. retriever.retrieve       question -> embed with input_type="query" ->
 *                               cosine top-k, capped per document
 *   6. context-block            top-k -> the <retrieved_context> prompt block
 *
 * RagService is the facade that wires those together; nothing else here needs
 * to be touched to add a route or change chat behaviour.
 *
 * PRIVACY NOTE: step 3 sends text to a hosted endpoint. Steps 1, 2, 4, 5 and 6
 * are entirely local. See the README before enabling this on sensitive files.
 * ============================================================================
 */

export { RAG_DEFAULTS, resolveEmbeddingModel, resolveStorageRoot, loadEmbeddingRegistry } from "./config.js";

export { CHUNK_KINDS, chunkDocument, buildContextPrefix } from "./chunker.js";

export { prepareDocument, contentHash, IngestError } from "./ingest.js";

export {
    EMBED_MODES,
    EmbeddingError,
    NvidiaEmbeddings,
    createEmbeddings,
} from "./embeddings.js";

export {
    Collection,
    VectorStore,
    VectorStoreError,
    sanitizeCollectionId,
} from "./vector-store.js";

export { Retriever, toQueryText } from "./retriever.js";

export { buildRetrievedContext, contextBudget, formatCitation } from "./context-block.js";

export { cosine, dot, l2Normalize, searchMatrix, truncateDimensions } from "./vector-math.js";

export { RagService, RagError, documentId } from "./service.js";
