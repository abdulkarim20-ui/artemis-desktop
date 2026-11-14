/**
 * ============================================================================
 * RETRIEVER (rag/retriever.js)
 * ============================================================================
 * Turns a user question into ranked chunks from a collection.
 *
 * The one non-obvious thing here is query cleaning. The renderer appends an
 * <attached_files> block to the user message, which can be tens of thousands of
 * characters of file content. Embedding that whole string would produce a
 * vector dominated by the attachment and barely influenced by the actual
 * question, so retrieval would return whatever looks like the file rather than
 * whatever answers it. The block is stripped before embedding.
 * ============================================================================
 */

import { EMBED_MODES } from "./embeddings.js";
import { RAG_DEFAULTS } from "./config.js";
import { sanitizeCollectionId } from "./vector-store.js";
import { Bm25Index } from "./lexical.js";
import { isSmallTalk } from "../../shared/small-talk.js";

/** Blocks that carry file content rather than the user's question. */
const CONTEXT_BLOCK_RE =
    /<(attached_files|retrieved_context)\b[\s\S]*?<\/\1>/gi;

/** Longest question we will embed. Anything longer is noise for retrieval. */
const MAX_QUERY_CHARS = 4000;

/**
 * Reduce a user message to the question itself.
 *
 * @param {string} raw
 * @returns {string} cleaned text, possibly empty
 */
export function toQueryText(raw) {
    const text = String(raw || "")
        .replace(CONTEXT_BLOCK_RE, " ")
        // Self-closing leftovers, if a block was truncated mid-way.
        .replace(/<\/?(attached_files|retrieved_context)\b[^>]*>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    return text.slice(0, MAX_QUERY_CHARS);
}

const ANAPHORA_RE =
    /\b(he|she|it|they|them|his|her|its|their|this|that|these|those|him|the (same|first|second|third|last|above|other)( one)?)\b/i;

const OVERVIEW_RE =
    /\b(summar(y|ize|ise|ies)|overview|tl;?dr|key points|main points|main ideas|outline|brief me|what is (this|the|that) (file|doc|document|pdf|paper|resume|cv|report|text) about|(tell|explain|describe|walk) (me )?(about |through )?(this|the|that|each|every|all)( (file|files|doc|docs|document|documents|pdf|resume|cv|paper|report))?|what (do|does) (this|these|the) (file|files|doc|docs|documents?) (say|contain|cover|include)|about (this|the) (candidate|file|document|resume|paper))\b/i;

/** "overview" needs the whole document; "specific" needs the best few passages. */
export function classifyIntent(queryText) {
    const text = String(queryText || "");
    return OVERVIEW_RE.test(text) && text.split(/\s+/).length <= 18 ? "overview" : "specific";
}

/**
 * The text to embed for this turn. Short or pronoun-heavy follow-ups
 * ("name", "what about his diploma?") borrow the previous REAL question;
 * casual turns in between are skipped so "cool" can never become the context.
 */
export function buildSearchQuery(messages, lastUser) {
    const current = toQueryText(lastUser.content);
    const words = current.split(/\s+/).filter(Boolean).length;
    const needsContext = words < 4 || (words < 9 && ANAPHORA_RE.test(current));
    if (!needsContext) return lastUser.content;

    const earlier = [...messages].reverse().filter((m) => m.role === "user" && m !== lastUser);
    for (const message of earlier) {
        const text = toQueryText(message.content);
        if (!text || isSmallTalk(text)) continue;
        if (text.split(/\s+/).length < 3) continue;
        return `${text}\n${lastUser.content}`;
    }
    return lastUser.content;
}

const normalizeName = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Documents the question names explicitly ("in the RAG doc", "04 RAG.docx").
 * Requires the file's name AND a file word or its extension, so "what is RAG?"
 * does NOT narrow the search to the file called RAG.docx.
 */
export function namedDocIds(documents, queryText) {
    const q = ` ${normalizeName(queryText)} `;
    const fileWord = /\b(file|files|doc|docs|document|documents|pdf|docx|attachment|sheet|slide|slides|deck|resume|cv)\b/;
    const ids = [];
    for (const doc of documents) {
        const fileName = String(doc.path || "").split(/[\\/]/).pop();
        const base = normalizeName(fileName.replace(/\.[^.]+$/, "")).replace(/^\d+\s+/, "");
        const ext = (fileName.split(".").pop() || "").toLowerCase();
        if (base.length < 3) continue;
        if (q.includes(` ${base} `) && (fileWord.test(q) || q.includes(` ${ext} `))) ids.push(doc.docId);
    }
    return ids;
}

const hitFromRecord = (r, score = 0) => ({
    chunkId: r.id, docId: r.docId, path: r.path, seq: r.seq, kind: r.kind, language: r.language,
    convertedFrom: r.convertedFrom, heading: r.heading, symbol: r.symbol,
    startLine: r.startLine, endLine: r.endLine, text: r.text, score,
});

export class Retriever {
    /**
     * @param {object} deps
     * @param {{ embedOne: (text: string, mode: string, signal?: AbortSignal) => Promise<Float32Array> }} deps.embeddings
     * @param {import('./vector-store.js').VectorStore} deps.store
     * @param {{ model: string, dims: number }} deps.descriptor
     */
    constructor({ embeddings, store, descriptor }) {
        this.embeddings = embeddings;
        this.store = store;
        this.descriptor = descriptor;
    }

    /**
     * Coverage retrieval for "summarize / tell me about this file".
     * Takes chunks in document order. When a document is bigger than its share
     * of the budget, takes evenly spaced chunks so the WHOLE document is
     * represented, not just its opening.
     */
    async overview({ collection, query, budgetChars, excludeDocIds }) {
        const collectionId = sanitizeCollectionId(collection);
        const opened = await this.store.open(collectionId, this.descriptor);
        if (opened.chunks.length === 0) {
            return { hits: [], query, skipped: "this knowledge base has no indexed files yet", mode: "overview", sampled: false };
        }

        const excluded = new Set(excludeDocIds || []);
        const byDoc = new Map();
        for (const record of opened.chunks) {
            if (excluded.has(record.docId)) continue;
            if (!byDoc.has(record.docId)) byDoc.set(record.docId, []);
            byDoc.get(record.docId).push(record);
        }

        const budget = budgetChars || RAG_DEFAULTS.maxContextChars;
        const share = Math.floor(budget / Math.max(1, byDoc.size));
        const hits = [];
        let sampled = false;

        for (const records of byDoc.values()) {
            records.sort((a, b) => a.seq - b.seq);
            const total = records.reduce((sum, r) => sum + String(r.text || "").length, 0);
            let chosen = records;

            if (total > share) {
                sampled = true;
                const average = Math.max(1, Math.round(total / records.length));
                const take = Math.max(1, Math.min(records.length, Math.floor(share / average)));
                const step = records.length / take;
                const picked = new Set();
                for (let i = 0; i < take; i += 1) picked.add(Math.min(records.length - 1, Math.floor(i * step)));
                chosen = [...picked].sort((a, b) => a - b).map((index) => records[index]);
            }
            for (const record of chosen) hits.push(hitFromRecord(record, 0));
        }

        return { hits, query, skipped: null, mode: "overview", sampled };
    }

    /**
     * @param {object} params
     * @param {string} params.collection
     * @param {string} params.query the raw user message; cleaned here
     * @param {number} [params.topK]
     * @param {number} [params.minScore]
     * @param {string[]} [params.excludeDocIds]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ hits: Array<object>, query: string, skipped: string|null }>}
     *   `skipped` carries a human-readable reason when nothing was searched.
     */
    async retrieve({ collection, query, topK, minScore, excludeDocIds, signal }) {
        const queryText = toQueryText(query);

        if (!queryText) {
            return { hits: [], query: "", skipped: "there was no question text to search for" };
        }

        // The store keys collections by their sanitized id, so the lookup has to
        // use the same form - comparing against the raw id would report "no
        // indexed files" for every collection whose id contained a slash.
        const collectionId = sanitizeCollectionId(collection);

        const existing = await this.store.list();
        if (!existing.some((entry) => entry.id === collectionId)) {
            return { hits: [], query: queryText, skipped: "this knowledge base has no indexed files yet" };
        }

        const opened = await this.store.open(collectionId, this.descriptor);
        if (opened.chunks.length === 0) {
            return { hits: [], query: queryText, skipped: "this knowledge base has no indexed files yet" };
        }

        // QUERY mode, not passage. The two are different projections of the same
        // model; using passage here would still return results, just worse ones.
        const vector = await this.embeddings.embedOne(queryText, EMBED_MODES.QUERY, signal);

        const wantK = topK || RAG_DEFAULTS.topK;
        const floor = minScore ?? RAG_DEFAULTS.minScore;
        const t0 = Date.now();

        // 1) dense candidates (no floor yet; the floor is applied after fusion)
        const dense = opened.search(vector, { topK: Math.max(12, wantK * 2), minScore: 0, excludeDocIds });

        // 2) lexical candidates (exact words). Failure here must never break retrieval.
        let lexical = [];
        try {
            const stamp = `${opened.updatedAt}:${opened.chunks.length}`;
            if (!opened._bm25 || opened._bm25Stamp !== stamp) {
                opened._bm25 = new Bm25Index(opened.chunks);
                opened._bm25Stamp = stamp;
            }
            const excluded = excludeDocIds?.length ? new Set(excludeDocIds) : null;
            lexical = opened._bm25.search(queryText, {
                topK: Math.max(12, wantK * 2),
                skip: excluded ? (row) => excluded.has(opened.chunks[row].docId) : null,
            });
        } catch (error) {
            console.warn("[RAG] lexical search skipped:", error?.message || error);
        }

        // 3) reciprocal rank fusion
        const RRF_K = 60;
        const fused = new Map(); // chunkId -> { hit, rrf, lexicalRank }
        dense.forEach((hit, rank) => {
            fused.set(hit.chunkId, { hit, rrf: 1 / (RRF_K + rank + 1), lexicalRank: null });
        });

        const cosineFor = (row) => {
            let sum = 0;
            const offset = row * opened.dims;
            for (let i = 0; i < opened.dims; i += 1) sum += opened.vectors[offset + i] * vector[i];
            return Number(sum.toFixed(4));
        };

        lexical.forEach(({ row }, rank) => {
            const record = opened.chunks[row];
            const entry = fused.get(record.id);
            if (entry) {
                entry.rrf += 1 / (RRF_K + rank + 1);
                entry.lexicalRank = rank;
            } else {
                fused.set(record.id, {
                    hit: {
                        chunkId: record.id, docId: record.docId, path: record.path, seq: record.seq,
                        kind: record.kind, language: record.language, convertedFrom: record.convertedFrom,
                        heading: record.heading, symbol: record.symbol,
                        startLine: record.startLine, endLine: record.endLine, text: record.text,
                        score: cosineFor(row),
                    },
                    rrf: 1 / (RRF_K + rank + 1),
                    lexicalRank: rank,
                });
            }
        });

        // 4) keep a hit if it clears the cosine floor OR is a top-3 exact-word
        //    match; then cap hits per document and take the top K.
        const perDoc = new Map();
        let hits = [...fused.values()]
            .filter((e) => e.hit.score >= floor || (e.lexicalRank !== null && e.lexicalRank < 3))
            .sort((a, b) => b.rrf - a.rrf)
            .map((e) => e.hit)
            .filter((hit) => {
                const seen = perDoc.get(hit.docId) || 0;
                if (seen >= RAG_DEFAULTS.maxHitsPerDocument) return false;
                perDoc.set(hit.docId, seen + 1);
                return true;
            })
            .slice(0, wantK);

        if (process.env.ARTEMIS_RAG_DEBUG) {
            console.log(
                "[RAG] query chars:", queryText.length,
                "dense top:", dense.slice(0, 3).map((h) => h.score),
                "lexical:", lexical.length, "kept:", hits.length, `${Date.now() - t0}ms`
            );
        }

        // A tiny knowledge base should never report "nothing". With only a few
        // chunks the cosine floor is easy to miss even for a question the corpus
        // does answer, so fall back to the best hit regardless of score. The
        // model is instructed to say so when it is off-topic, so this trades a
        // false "nothing found" for a checkable near-miss.
        if (hits.length === 0 && opened.chunks.length <= 40) {
            hits = opened.search(vector, { topK: 1, minScore: 0, excludeDocIds })
                .map((hit) => ({ ...hit, weak: true }));
        }

        return {
            hits,
            query: queryText,
            skipped: hits.length ? null : "nothing in the knowledge base was similar enough to this question",
        };
    }
}
