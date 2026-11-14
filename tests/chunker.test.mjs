/**
 * ============================================================================
 * CHUNKER TESTS
 * ============================================================================
 * The central assertion here is a line-number round-trip: for every chunk,
 * slicing the source text by that chunk's own startLine/endLine must reproduce
 * the chunk's text exactly.
 *
 * That single property is worth more than any other chunker test, because a
 * chunk with the wrong line numbers still embeds fine, still retrieves fine
 * and still answers fine - it just cites the wrong place in the user's file.
 * Nothing throws. So the citation has to be checked directly.
 * ============================================================================
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CHUNK_KINDS, buildContextPrefix, chunkDocument } from "../ai-agent/rag/chunker.js";

/** Build a markdown document with `sections` headings and known filler. */
function makeMarkdown(sections = 8, linesPerSection = 6) {
    const lines = ["# Report"];
    for (let s = 1; s <= sections; s += 1) {
        lines.push("", `## Section ${s}`, "");
        for (let i = 0; i < linesPerSection; i += 1) {
            lines.push(`Line ${s}.${i} discussing topic${s} with enough words to be realistic content here.`);
        }
    }
    return lines.join("\n");
}

function makeCode(functions = 6, bodyLines = 12) {
    const lines = [];
    for (let f = 0; f < functions; f += 1) {
        lines.push(`export function handler${f}(input) {`);
        for (let i = 0; i < bodyLines; i += 1) {
            lines.push(`    const step${i} = compute(input, ${f}, ${i});`);
        }
        lines.push("}", "");
    }
    return lines.join("\n");
}

/**
 * The round-trip. A chunk that fails this has a citation pointing somewhere
 * other than its own text.
 */
function assertLineNumbersMatch(source, chunks, label) {
    const lines = source.split("\n");
    for (const chunk of chunks) {
        assert.ok(chunk.startLine >= 1, `${label}: startLine must be 1-based, got ${chunk.startLine}`);
        assert.ok(chunk.endLine >= chunk.startLine, `${label}: range inverted ${chunk.startLine}-${chunk.endLine}`);
        assert.ok(chunk.endLine <= lines.length, `${label}: endLine ${chunk.endLine} past the end (${lines.length})`);

        const slice = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
        assert.equal(
            slice,
            chunk.text,
            `${label}: chunk ${chunk.seq} claims lines ${chunk.startLine}-${chunk.endLine} but that slice is different text`
        );
    }
}

/** Every non-blank source line must appear in at least one chunk. */
function assertFullCoverage(source, chunks, label) {
    const lines = source.split("\n");
    const covered = new Array(lines.length).fill(false);

    for (const chunk of chunks) {
        for (let i = chunk.startLine - 1; i < chunk.endLine; i += 1) covered[i] = true;
    }

    const missing = [];
    lines.forEach((line, index) => {
        if (line.trim() && !covered[index]) missing.push(index + 1);
    });

    assert.deepEqual(missing, [], `${label}: these lines were silently dropped from the index`);
}

test("markdown chunks cite exactly the lines they contain", () => {
    const source = makeMarkdown(10);
    const chunks = chunkDocument({ text: source, kind: CHUNK_KINDS.MARKDOWN, path: "docs/report.md" });

    assert.ok(chunks.length >= 2, "a document this size should produce several chunks");
    assertLineNumbersMatch(source, chunks, "markdown");
    assertFullCoverage(source, chunks, "markdown");
});

test("code chunks cite exactly the lines they contain", () => {
    const source = makeCode(8);
    const chunks = chunkDocument({ text: source, kind: CHUNK_KINDS.CODE, path: "src/handlers.js", language: "javascript" });

    assertLineNumbersMatch(source, chunks, "code");
    assertFullCoverage(source, chunks, "code");
});

test("overlap pulls the previous tail in without shifting the citation", () => {
    // This is the case that exposes an off-by-one. With overlap enabled the
    // chunk body starts before its natural unit, so startLine has to move back
    // by exactly the number of lines borrowed.
    const source = makeMarkdown(14);
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/report.md",
        options: { chunkOverlapChars: 200, chunkTargetChars: 900 },
    });

    assert.ok(chunks.length >= 3, "need several chunks for overlap to apply");
    assertLineNumbersMatch(source, chunks, "overlap");

    // Confirm the overlap actually happened, otherwise the test above proves
    // nothing: chunk N must start before the line where its own new content
    // begins, i.e. chunks must share lines with their predecessor.
    const overlapping = chunks.slice(1).filter((chunk, i) => chunk.startLine <= chunks[i].endLine);
    assert.ok(overlapping.length > 0, "no overlap was produced, so the assertion is vacuous");
});

test("overlap can be turned off entirely", () => {
    const source = makeMarkdown(10);
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/report.md",
        options: { chunkOverlapChars: 0 },
    });

    assertLineNumbersMatch(source, chunks, "no-overlap");

    for (let i = 1; i < chunks.length; i += 1) {
        assert.ok(
            chunks[i].startLine > chunks[i - 1].endLine,
            `chunk ${i} overlaps its predecessor despite chunkOverlapChars: 0`
        );
    }
});

test("charStart and charEnd address the same span as the line numbers", () => {
    const source = makeCode(6);
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.CODE,
        path: "src/handlers.js",
        options: { chunkOverlapChars: 0 },
    });

    for (const chunk of chunks) {
        assert.ok(chunk.charStart < chunk.charEnd, `chunk ${chunk.seq} has an empty char range`);
        assert.equal(
            source.slice(chunk.charStart, chunk.charEnd),
            chunk.text,
            `chunk ${chunk.seq}: char range does not reproduce its text`
        );
    }
});

test("a short trailing fragment is folded into the previous chunk, endLine included", () => {
    // "Total: 4.2M" is far below minChunkChars, so it gets merged. The merged
    // chunk has to extend its endLine to cover the absorbed lines, and endLine
    // is 1-based while the packing loop works 0-based - mixing them understates
    // the citation by one line.
    const body = Array.from({ length: 30 }, (_, i) => `Revenue line ${i} with enough words to fill the chunk out properly.`);
    const source = ["# Summary", "", ...body, "", "Total: 4.2M"].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/summary.md",
        options: { minChunkChars: 80, chunkTargetChars: 1600 },
    });

    const lines = source.split("\n");
    const totalLine = lines.indexOf("Total: 4.2M") + 1;

    const last = chunks[chunks.length - 1];
    assert.ok(last.text.includes("Total: 4.2M"), "the stub was not folded in");
    assert.equal(
        last.endLine,
        totalLine,
        "the merged chunk must cite through the absorbed line, not stop one line short"
    );
    assertLineNumbersMatch(source, chunks, "stub-merge");
});

test("a merged stub never pushes a chunk past the hard maximum", () => {
    const max = 1200;
    const body = Array.from({ length: 40 }, (_, i) => `Padding line ${i} that is reasonably long to build up size quickly here.`);
    const source = [...body, "", "short tail"].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.TEXT,
        path: "notes.txt",
        options: { chunkTargetChars: 800, chunkMaxChars: max, minChunkChars: 200 },
    });

    for (const chunk of chunks) {
        assert.ok(
            chunk.text.length <= max + 200,
            `chunk ${chunk.seq} is ${chunk.text.length} chars, over the ${max} hard maximum`
        );
    }
});

test("no chunk exceeds the hard maximum", () => {
    const source = makeMarkdown(20, 10);
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/big.md",
        options: { chunkTargetChars: 1000, chunkMaxChars: 1400 },
    });

    assert.ok(chunks.length > 3);
    for (const chunk of chunks) {
        // Overlap is allowed to add up to chunkOverlapChars on top of a full
        // chunk, so the ceiling is max + overlap rather than max alone.
        assert.ok(chunk.text.length <= 1400 + 200, `chunk ${chunk.seq} is ${chunk.text.length} chars`);
    }
});

test("a single line longer than the maximum is cut instead of emitted whole", () => {
    const giant = "x".repeat(5000);
    const source = ["# Head", "", giant, "", "after"].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/oneline.md",
        options: { chunkTargetChars: 600, chunkMaxChars: 800 },
    });

    for (const chunk of chunks) {
        assert.ok(chunk.text.length <= 1000, `chunk ${chunk.seq} is ${chunk.text.length} chars`);
    }
    assert.ok(
        chunks.some((chunk) => chunk.text.startsWith("xxxx")),
        "the oversized line was dropped rather than split"
    );
});

test("the heading path reflects nesting, not just the nearest heading", () => {
    const source = [
        "# Annual Report",
        "",
        "## Financials",
        "",
        "### Revenue",
        "",
        ...Array.from({ length: 20 }, (_, i) => `Revenue detail line ${i} with some words to make the chunk viable.`),
        "",
        "### Costs",
        "",
        ...Array.from({ length: 20 }, (_, i) => `Cost detail line ${i} with some words to make the chunk viable here.`),
    ].join("\n");

    // Target has to be small enough that the Revenue block forms its own
    // chunk; at the default 1600 the whole document packs into two chunks and
    // no chunk ever starts under "### Revenue", so there is nothing to assert.
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/report.md",
        options: { chunkTargetChars: 600 },
    });

    const headings = new Set(chunks.map((chunk) => chunk.heading));
    assert.ok(
        headings.has("Annual Report > Financials > Revenue"),
        `expected a nested heading path, got ${JSON.stringify([...headings])}`
    );

    // A sibling heading must pop the previous one off the stack.
    assert.ok(
        headings.has("Annual Report > Financials > Costs"),
        `expected the Costs section to replace Revenue, got ${JSON.stringify([...headings])}`
    );
    assert.ok(
        [...headings].every((heading) => !heading.includes("Revenue > Costs")),
        "a same-level heading was appended instead of replacing its sibling"
    );
});

test("code symbols are the declared name, not the keyword", () => {
    const source = [
        "export function calculateRevenue(rows) {",
        ...Array.from({ length: 25 }, (_, i) => `    const step${i} = rows[${i}] ?? 0;`),
        "}",
        "",
        "class ReportBuilder {",
        ...Array.from({ length: 25 }, (_, i) => `    field${i} = ${i};`),
        "}",
    ].join("\n");

    const chunks = chunkDocument({ text: source, kind: CHUNK_KINDS.CODE, path: "src/revenue.js", language: "javascript" });

    const symbols = chunks.map((chunk) => chunk.symbol).filter(Boolean);
    assert.ok(symbols.length > 0, "no symbol was extracted at all");
    assert.ok(
        symbols.includes("calculateRevenue"),
        `expected the declared name, got ${JSON.stringify(symbols)}`
    );
    assert.ok(
        !symbols.some((symbol) => ["function", "class", "const", "export"].includes(symbol)),
        `a keyword was captured instead of a name: ${JSON.stringify(symbols)}`
    );
});

test("a doc comment is labelled with the declaration it introduces, not the one before it", () => {
    // Found against the live embedding endpoint: a chunk consisting entirely of
    // beta's doc comment came back labelled "alphaOne". Forward-filling the
    // symbol map gets this backwards, and the damage is twice over - the
    // citation names the wrong function, and the wrong name goes into the
    // contextPrefix that is actually embedded, so a question about beta is
    // matched against a vector tagged alpha.
    const source = [
        "export function alphaOne(a) {",           // 1
        "    const total = a * 2;",                 // 2
        "    return total + 1;",                    // 3
        "}",                                        // 4
        "",                                         // 5
        "/**",                                      // 6
        " * Beta is the function that matters. It does something completely", // 7
        " * different from alpha, so its own name is the only correct label.", // 8
        " */",                                      // 9
        "export function betaTwo(b) {",             // 10
        "    return b * 10;",                       // 11
        "}",                                        // 12
    ].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.CODE,
        path: "sample.js",
        language: "javascript",
        // Small target so the comment can become the start of its own chunk,
        // which is the case the forward fill alone gets wrong.
        options: { chunkTargetChars: 140, chunkOverlapChars: 0, minChunkChars: 20 },
    });

    assert.ok(chunks.length >= 2, `the fixture has to split for the case to exist: ${chunks.length} chunk(s)`);

    const startedInComment = chunks.find((chunk) => chunk.startLine >= 6 && chunk.startLine <= 9);
    assert.ok(
        startedInComment,
        `no chunk started inside the doc comment, so this test proves nothing: ${JSON.stringify(chunks.map((c) => [c.startLine, c.endLine]))}`
    );

    assert.equal(
        startedInComment.symbol,
        "betaTwo",
        `lines ${startedInComment.startLine}-${startedInComment.endLine} are beta's doc comment but were filed under "${startedInComment.symbol}"`
    );
    assert.match(
        startedInComment.contextPrefix,
        /Symbol: betaTwo/,
        "the embedded prefix still names the wrong function"
    );
    assert.ok(
        !startedInComment.contextPrefix.includes("alphaOne"),
        `the prefix mentions the preceding function: ${JSON.stringify(startedInComment.contextPrefix)}`
    );
});

test("a comment separated from the next declaration keeps the enclosing symbol", () => {
    // The boundary of the fix. A blank line between the comment and the
    // declaration means it is trailing prose about what came ABOVE, not a doc
    // comment for what follows. Reassigning it would be a guess, and a wrong
    // guess here is the same bug in the other direction.
    const source = [
        "export function alphaOne(a) {",                            // 1
        "    const total = a * 2;",                                 // 2
        "    const scaled = total + 1;",                            // 3
        "    const rounded = Math.round(scaled * 100) / 100;",      // 4
        "    return rounded;",                                      // 5
        "}",                                                        // 6
        "",                                                         // 7
        "// a trailing note about alpha above, separated by blanks", // 8
        "",                                                         // 9
        "export function betaTwo(b) {",                             // 10
        "    const value = b * 10;",                                // 11
        "    const adjusted = value - 3;",                          // 12
        "    return adjusted * 2;",                                 // 13
        "}",                                                        // 14
    ].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.CODE,
        path: "sample.js",
        language: "javascript",
        options: { chunkTargetChars: 120, chunkOverlapChars: 0, minChunkChars: 10 },
    });

    const note = chunks.find((chunk) => chunk.startLine === 8);
    assert.ok(
        note,
        `no chunk started on the trailing comment, so this test proves nothing: ${JSON.stringify(chunks.map((c) => [c.startLine, c.endLine]))}`
    );
    assert.equal(
        note.symbol,
        "alphaOne",
        `a trailing comment was reassigned to the declaration below it: got "${note.symbol}"`
    );
});

test("a markdown table is not torn apart between rows", () => {
    const table = [
        "| Region | Revenue |",
        "| --- | --- |",
        ...Array.from({ length: 40 }, (_, i) => `| region${i} | ${i}.2M |`),
    ];
    const source = ["# Tables", "", ...table, "", "End of table."].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/table.md",
        options: { chunkTargetChars: 500, chunkMaxChars: 700 },
    });

    // The table is larger than max, so it will be hard-split eventually; what
    // must not happen is a cut in the middle of the header/separator pair.
    for (const chunk of chunks) {
        const hasHeader = chunk.text.includes("| Region | Revenue |");
        const hasSeparator = chunk.text.includes("| --- | --- |");
        assert.equal(
            hasHeader,
            hasSeparator,
            "the header row and its separator were split across chunks, making the table unreadable"
        );
    }
});

test("context is prefixed onto the embedded string but kept out of the text", () => {
    const source = makeMarkdown(4);
    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/report.md",
        convertedFrom: "docx",
    });

    for (const chunk of chunks) {
        assert.equal(chunk.embeddingInput, chunk.contextPrefix + chunk.text);
        assert.ok(!chunk.text.startsWith("Document:"), "the prefix leaked into the quoted text");
        assert.match(chunk.contextPrefix, /report\.md/);
        assert.match(chunk.contextPrefix, /converted from docx/);
    }
});

test("the prefix names the symbol for code and the section for markdown", () => {
    const code = chunkDocument({
        text: "export function indexDocuments(files) {\n    return files.map(parse);\n}\n",
        kind: CHUNK_KINDS.CODE,
        path: "src/rag/index.js",
        language: "javascript",
    });
    assert.match(code[0].contextPrefix, /Source file: index\.js \(javascript\)/);
    assert.match(code[0].contextPrefix, /Symbol: indexDocuments/);

    // The section is the heading in force at the chunk's FIRST line. "Inner"
    // only appears in the prefix of a chunk that actually starts below it, so
    // the section has to be large enough to form one.
    const filler = (label) =>
        Array.from({ length: 14 }, (_, i) => `${label} line ${i} with enough words to fill out a realistic paragraph.`);
    const prose = chunkDocument({
        text: ["# Chapter", "", ...filler("chapter"), "", "## Inner", "", ...filler("inner")].join("\n"),
        kind: CHUNK_KINDS.MARKDOWN,
        path: "book.md",
        options: { chunkTargetChars: 700 },
    });

    assert.equal(prose[0].heading, "Chapter");
    assert.ok(
        prose.some((chunk) => chunk.contextPrefix.includes("Section: Chapter > Inner")),
        `no chunk carried the nested path: ${JSON.stringify(prose.map((chunk) => chunk.heading))}`
    );
});

test("heading and symbol describe the chunk's own content, not its borrowed overlap", () => {
    // With overlap on, a chunk's startLine reaches back into the previous
    // section. The label has to follow the content the chunk is actually
    // about, otherwise every chunk after a boundary is filed under the wrong
    // section and the embedding prefix points retrieval at the wrong topic.
    const source = [
        "# Alpha",
        "",
        ...Array.from({ length: 12 }, (_, i) => `alpha detail line ${i} padded out with enough words to be realistic.`),
        "",
        "# Beta",
        "",
        ...Array.from({ length: 12 }, (_, i) => `beta detail line ${i} padded out with enough words to be realistic.`),
    ].join("\n");

    const chunks = chunkDocument({
        text: source,
        kind: CHUNK_KINDS.MARKDOWN,
        path: "docs/two.md",
        options: { chunkTargetChars: 500, chunkOverlapChars: 200 },
    });

    const beta = chunks.find((chunk) => chunk.text.includes("beta detail line 11"));
    assert.ok(beta, "no chunk reached the end of the Beta section");
    assert.ok(beta.startLine < source.split("\n").indexOf("# Beta") + 1, "expected this chunk to overlap back past the heading");
    assert.equal(beta.heading, "Beta", "the chunk was labelled with the section it borrowed from");

    // Same mechanism for code: overlap reaching back across a function
    // boundary must not relabel the chunk with the previous function.
    const code = [
        "export function first(input) {",
        ...Array.from({ length: 14 }, (_, i) => `    const a${i} = work(input, ${i});`),
        "}",
        "",
        "export function second(input) {",
        ...Array.from({ length: 14 }, (_, i) => `    const b${i} = work(input, ${i});`),
        "}",
    ].join("\n");

    const codeChunks = chunkDocument({
        text: code,
        kind: CHUNK_KINDS.CODE,
        path: "src/two.js",
        language: "javascript",
        options: { chunkTargetChars: 400, chunkOverlapChars: 200 },
    });

    const last = codeChunks[codeChunks.length - 1];
    assert.ok(last.text.includes("b13"), "the final code chunk should reach the end of second()");
    assert.equal(last.symbol, "second", "the chunk was labelled with the function it borrowed from");
});

test("buildContextPrefix is usable standalone and never returns a bare newline", () => {
    const withContext = buildContextPrefix({ path: "a/b.md", kind: CHUNK_KINDS.MARKDOWN, heading: "H" });
    assert.equal(withContext, "Document: b.md\nSection: H\n\n");

    const empty = buildContextPrefix({ path: "", kind: CHUNK_KINDS.TEXT });
    assert.equal(empty, "Document: document\n\n");

    const nothing = buildContextPrefix({});
    assert.equal(nothing, "Document: document\n\n");
});

test("empty and whitespace-only input produces no chunks", () => {
    assert.deepEqual(chunkDocument({ text: "", kind: CHUNK_KINDS.TEXT, path: "a.txt" }), []);
    assert.deepEqual(chunkDocument({ text: "   \n\n\t\n", kind: CHUNK_KINDS.TEXT, path: "a.txt" }), []);
    assert.deepEqual(chunkDocument({ text: null, kind: CHUNK_KINDS.TEXT, path: "a.txt" }), []);
});

test("an unknown kind falls back to text rather than throwing", () => {
    const source = makeMarkdown(3);
    const chunks = chunkDocument({ text: source, kind: "spreadsheet", path: "data.csv" });

    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].kind, CHUNK_KINDS.TEXT);
    assertLineNumbersMatch(source, chunks, "fallback-kind");
});

test("seq is contiguous and chunks stay in document order", () => {
    const source = makeCode(10);
    const chunks = chunkDocument({ text: source, kind: CHUNK_KINDS.CODE, path: "src/a.js" });

    chunks.forEach((chunk, index) => {
        assert.equal(chunk.seq, index, "seq is not the position in the array");
        if (index > 0) {
            assert.ok(
                chunk.startLine >= chunks[index - 1].startLine,
                `chunk ${index} starts before its predecessor`
            );
        }
    });
});

test("CRLF input is normalized before line numbers are assigned", () => {
    const source = makeMarkdown(6).replace(/\n/g, "\r\n");
    const chunks = chunkDocument({ text: source, kind: CHUNK_KINDS.MARKDOWN, path: "docs/win.md" });

    const lfSource = source.replace(/\r\n/g, "\n");
    assertLineNumbersMatch(lfSource, chunks, "crlf");

    for (const chunk of chunks) {
        assert.ok(!chunk.text.includes("\r"), "a carriage return survived into the chunk text");
    }
});

test("path and language survive onto every chunk for citation", () => {
    const chunks = chunkDocument({
        text: makeCode(3),
        kind: CHUNK_KINDS.CODE,
        path: "renderer/js/app.js",
        language: "javascript",
        convertedFrom: "",
    });

    for (const chunk of chunks) {
        assert.equal(chunk.path, "renderer/js/app.js");
        assert.equal(chunk.language, "javascript");
        assert.equal(chunk.convertedFrom, "");
    }
});

test("markdown chunks are labelled markdown even when the source language differs", () => {
    // anydoc converts docx to Markdown, so the converted text is markdown
    // regardless of what the original file was called.
    const chunks = chunkDocument({
        text: makeMarkdown(3),
        kind: CHUNK_KINDS.MARKDOWN,
        path: "report.docx",
        language: "docx",
        convertedFrom: "docx",
    });

    assert.equal(chunks[0].language, "markdown");
});
