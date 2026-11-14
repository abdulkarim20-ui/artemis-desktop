/**
 * ============================================================================
 * LEXICAL SEARCH (rag/lexical.js)
 * ============================================================================
 * Small in-memory BM25 index over a collection's chunks.
 * Dense embeddings find meaning; BM25 finds exact words (names, acronyms,
 * numbers, identifiers). Production RAG fuses both.
 * ============================================================================
 */

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const STOP = new Set(
    "a an and are as at be but by for from has have he her his i in is it its of on or she that the their they this to was were what when where which who will with you your".split(" ")
);

export function tokenize(text) {
    const out = [];
    for (const match of String(text || "").toLowerCase().matchAll(TOKEN_RE)) {
        const term = match[0];
        if (term.length > 1 && !STOP.has(term)) out.push(term);
    }
    return out;
}

export class Bm25Index {
    constructor(chunks, { k1 = 1.4, b = 0.75 } = {}) {
        this.k1 = k1;
        this.b = b;
        this.n = chunks.length;
        this.tf = [];
        this.len = [];
        this.df = new Map();

        let total = 0;
        for (const chunk of chunks) {
            const terms = tokenize(`${chunk.heading || ""} ${chunk.text || ""}`);
            const tf = new Map();
            for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
            for (const term of tf.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
            this.tf.push(tf);
            this.len.push(terms.length);
            total += terms.length;
        }
        this.avgLen = total / Math.max(1, this.n);
    }

    /** @returns {Array<{ row: number, score: number }>} best first */
    search(query, { topK = 12, skip = null } = {}) {
        const terms = [...new Set(tokenize(query))];
        if (!terms.length) return [];

        const scored = [];
        for (let row = 0; row < this.n; row += 1) {
            if (skip && skip(row)) continue;
            const tf = this.tf[row];
            let score = 0;
            for (const term of terms) {
                const f = tf.get(term);
                if (!f) continue;
                const df = this.df.get(term);
                const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
                const norm = 1 - this.b + (this.b * this.len[row]) / this.avgLen;
                score += (idf * f * (this.k1 + 1)) / (f + this.k1 * norm);
            }
            if (score > 0) scored.push({ row, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }
}
