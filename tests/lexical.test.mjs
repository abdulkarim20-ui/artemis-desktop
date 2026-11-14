/**
 * ============================================================================
 * LEXICAL SEARCH TESTS (tests/lexical.test.mjs)
 * ============================================================================
 * BM25 is the half of retrieval that catches exact words - names, acronyms,
 * identifiers - which the dense model scores weakly. The assertions below pin
 * the two properties that make it useful: rarity wins, and an empty query is
 * an empty answer rather than a crash.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Bm25Index, tokenize } from "../ai-agent/rag/lexical.js";

const chunk = (text, heading = "") => ({ heading, text });

test("a rare term outranks a common one", () => {
    const index = new Bm25Index([
        chunk("the gateway handles uploads and the gateway retries failed uploads"),
        chunk("the gateway routes to the zzyzx backend"),
        chunk("uploads are stored in the bucket by the gateway"),
    ]);

    // Every document contains "gateway"; only one contains "zzyzx". BM25's idf
    // has to rank the rare match first or the index adds nothing over grep.
    const results = index.search("gateway zzyzx");

    assert.ok(results.length >= 1);
    assert.equal(results[0].row, 1, "the document holding the rare term did not win");
});

test("a query term that appears nowhere returns nothing", () => {
    const index = new Bm25Index([chunk("revenue by region"), chunk("costs and margins")]);

    assert.deepEqual(index.search("xyzzy"), []);
});

test("an empty or stopword-only query returns an empty list", () => {
    const index = new Bm25Index([chunk("revenue by region")]);

    assert.deepEqual(index.search(""), []);
    assert.deepEqual(index.search("   "), []);
    assert.deepEqual(index.search("the was and"), [], "stopwords are not searchable terms");
});

test("tokenize drops stopwords and single characters", () => {
    assert.deepEqual(tokenize("The cat is on the mat!"), ["cat", "mat"]);
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
});

test("topK caps the result list", () => {
    const index = new Bm25Index(
        Array.from({ length: 8 }, (_, i) => chunk(`document number ${i} mentions the gateway`))
    );

    const results = index.search("gateway", { topK: 3 });

    assert.equal(results.length, 3);
});

test("skip excludes rows from the ranking entirely", () => {
    const index = new Bm25Index([
        chunk("the gateway retries uploads"),
        chunk("the gateway routes traffic"),
        chunk("the gateway logs errors"),
    ]);

    const results = index.search("gateway", { topK: 3, skip: (row) => row === 1 });

    assert.ok(!results.some((entry) => entry.row === 1), "a skipped row still appeared");
});
