/**
 * ============================================================================
 * VECTOR MATH (rag/vector-math.js)
 * ============================================================================
 * Pure, dependency-free vector helpers shared by the embedding adapter and the
 * store. Kept in its own module so neither depends on the other, and so the
 * arithmetic can be unit-tested without a network or a disk.
 *
 * Nemotron returns L2-normalized vectors, which makes cosine similarity equal
 * to the plain dot product. We still normalize defensively: a caller that
 * truncates dimensions, or a future model that does not normalize, would
 * otherwise produce scores that quietly stop meaning anything.
 * ============================================================================
 */

/**
 * @param {ArrayLike<number>} vector
 * @returns {Float32Array} a unit-length copy, or zeros when the norm is 0.
 */
export function l2Normalize(vector) {
    const out = vector instanceof Float32Array ? vector.slice() : Float32Array.from(vector || []);

    let sum = 0;
    for (let i = 0; i < out.length; i += 1) sum += out[i] * out[i];
    const norm = Math.sqrt(sum);

    // A zero vector has no direction. Returning zeros keeps the caller's
    // invariant ("stored vectors are unit length") instead of producing NaN,
    // which would poison every comparison it took part in.
    if (!Number.isFinite(norm) || norm === 0) return out;

    for (let i = 0; i < out.length; i += 1) out[i] /= norm;
    return out;
}

/**
 * Dot product of two equal-length vectors. Mismatched lengths are a bug, not a
 * tolerance question, so they throw rather than silently scoring 0.
 */
export function dot(a, b) {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
    return sum;
}

/** Cosine similarity in [-1, 1]. */
export function cosine(a, b) {
    return dot(l2Normalize(a), l2Normalize(b));
}

/**
 * Keep the first `dimensions` entries and re-normalize.
 *
 * The Nemotron model card states truncated embeddings stay effective for
 * retrieval *provided they are L2-normalized after truncation* - dropping the
 * renormalization is the easy way to make this silently worse.
 *
 * @returns {Float32Array} the original when no truncation is requested.
 */
export function truncateDimensions(vector, dimensions) {
    if (!dimensions || dimensions >= vector.length) return vector;
    return l2Normalize(vector.subarray(0, dimensions));
}

/**
 * Brute-force search over a contiguous Float32Array matrix.
 *
 * Deliberately not indexed: for a desktop corpus (thousands of chunks) a linear
 * scan of 2048-dim vectors costs tens of milliseconds, and it has no native
 * dependency, no index to corrupt, and no recall approximation to explain.
 * Swap this module for sqlite/HNSW later without touching the callers.
 *
 * @param {Float32Array} matrix rows * dims, row-major
 * @param {number} dims
 * @param {ArrayLike<number>} query assumed already normalized
 * @param {{ topK?: number, minScore?: number, skip?: (row: number) => boolean }} [options]
 * @returns {Array<{ row: number, score: number }>} descending by score
 */
export function searchMatrix(matrix, dims, query, options = {}) {
    const topK = Math.max(1, options.topK || 10);
    const minScore = options.minScore ?? -Infinity;
    const skip = options.skip;
    const rows = dims > 0 ? Math.floor(matrix.length / dims) : 0;

    // A min-heap would matter at a million rows. At this scale a sorted insert
    // into a small array is faster than the bookkeeping and much easier to read.
    const best = [];

    for (let row = 0; row < rows; row += 1) {
        if (skip && skip(row)) continue;

        const offset = row * dims;
        let score = 0;
        for (let i = 0; i < dims; i += 1) score += matrix[offset + i] * query[i];

        if (score < minScore) continue;

        if (best.length < topK) {
            best.push({ row, score });
            best.sort((a, b) => b.score - a.score);
        } else if (score > best[best.length - 1].score) {
            best[best.length - 1] = { row, score };
            best.sort((a, b) => b.score - a.score);
        }
    }

    return best;
}
