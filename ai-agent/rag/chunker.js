/**
 * ============================================================================
 * CHUNKER (rag/chunker.js)
 * ============================================================================
 * Splits normalized text into retrieval units.
 *
 * Structure-aware on purpose. Cutting a corpus into fixed 1500-char windows is
 * the single easiest way to build a RAG system that returns half a function or
 * the middle of a table. Instead we find *allowed break points* for the kind of
 * content (markdown headings and blank lines, code declaration boundaries,
 * prose paragraphs), pack them into chunks near a target size, and only force a
 * mid-unit cut when a single unit is larger than the hard maximum.
 *
 * Every chunk carries:
 *   - startLine/endLine  1-based line numbers in the *converted* text, so the
 *     model can cite "report.docx L40-63" exactly like it cites code.
 *   - heading / symbol   nearest enclosing section or declaration, used both for
 *     citation and as an embedding prefix.
 *   - embeddingInput     contextPrefix + text. Prefixing the file and section
 *     onto the embedded string is what lets a short chunk ("Total: 4.2M")
 *     still be found by a question about budgets.
 * ============================================================================
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * A line at column 0 that starts a new top-level construct in most languages.
 * Written as one literal: JavaScript regex has no `x` (extended) flag, so
 * whitespace inside the pattern would be matched literally.
 */
const TOP_LEVEL_DECL_RE =
    /^(?:export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|default\s+|abstract\s+|final\s+|sealed\s+)*(?:function|class|const|let|var|interface|type|enum|struct|trait|impl|fn|def|func|package|namespace|module|record|protocol|extension)\b/;

/** A column-0 closing brace usually ends a top-level block. */
const TOP_LEVEL_CLOSE_RE = /^[})\]]\s*[;,]?\s*$/;

/**
 * Captures the declared NAME, not the keyword. Taking the first identifier on
 * the line instead yields "function" for every JS declaration, which is worse
 * than no symbol at all.
 */
const DECL_NAME_RE =
    /(?:function|class|const|let|var|interface|type|enum|struct|trait|impl|fn|def|func|record|protocol|extension)\s*\*?\s*([A-Za-z0-9_$]+)/;

export const CHUNK_KINDS = Object.freeze({
    MARKDOWN: "markdown",
    CODE: "code",
    TEXT: "text",
});

/* ------------------------------------------------------------------ */
/* line indexing                                                       */
/* ------------------------------------------------------------------ */

/** Offsets at which each line begins. Line N (1-based) starts at index N-1. */
function buildLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "\n") starts.push(i + 1);
    }
    return starts;
}

function lineEndOffset(text, lineStarts, index) {
    const next = lineStarts[index + 1];
    // Strip the newline itself so charEnd points at real content.
    return next === undefined ? text.length : next - 1;
}

const sliceLines = (lines, from, to) => lines.slice(from, to + 1).join("\n");

/* ------------------------------------------------------------------ */
/* per-kind structure maps                                             */
/* ------------------------------------------------------------------ */

/**
 * Markdown: the heading path in force at each line ("Chapter > Section").
 * Converted documents arrive as Markdown, so this is what makes a chunk from a
 * 90-page PDF citable by section name instead of by page guess.
 */
function buildHeadingMap(lines) {
    const stack = [];
    const map = new Array(lines.length).fill("");

    for (let i = 0; i < lines.length; i += 1) {
        const match = HEADING_RE.exec(lines[i]);
        if (match) {
            const level = match[1].length;
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            stack.push({ level, title: match[2].trim() });
        }
        map[i] = stack.map((entry) => entry.title).join(" > ");
    }
    return map;
}

/** True when a line opens a top-level construct, using the same predicate the
 *  forward fill does so the two passes cannot disagree about what counts. */
function isDeclLine(line) {
    return TOP_LEVEL_DECL_RE.test(line) || /^\s*(?:func|def|fn)\s/.test(line);
}

/**
 * A line that is part of a block or line comment.
 *
 * Deliberately limited to the // and C-style forms. Adding '#' would sweep in
 * the C preprocessor, so a chunk starting on `#include` would be labelled with
 * whatever function follows it.
 */
function isCommentLine(line) {
    return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

/**
 * Code: the declaration each line belongs to.
 *
 * Inside a body that is the nearest preceding top-level declaration. On a doc
 * comment it is the declaration the comment introduces - see the backward pass
 * below, which is what makes that true.
 */
function buildSymbolMap(lines) {
    const map = new Array(lines.length).fill("");
    let current = "";

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isDeclLine(line)) {
            const name = DECL_NAME_RE.exec(line);
            if (name) current = name[1];
        }
        map[i] = current;
    }

    /*
     * A doc comment belongs to the declaration BELOW it, not to the one above.
     *
     * Forward-filling alone gets this backwards: in
     *
     *     export function alpha() { ... }
     *
     *     /** everything about beta *\/
     *     export function beta() { ... }
     *
     * the comment lines are filled with "alpha", so a chunk that happens to
     * start on the comment is filed under the wrong function - wrong in the
     * citation the user sees and wrong in the contextPrefix that gets embedded,
     * which actively hurts retrieval for the function the comment describes.
     *
     * Only reassign a comment block that sits IMMEDIATELY above a declaration.
     * A blank line in between means the comment is trailing prose rather than a
     * doc comment, and the forward-filled name is the better guess.
     */
    for (let i = 0; i < lines.length; i += 1) {
        if (!isDeclLine(lines[i]) || !map[i]) continue;

        let start = i - 1;
        while (start >= 0 && isCommentLine(lines[start])) start -= 1;
        for (let j = start + 1; j < i; j += 1) map[j] = map[i];
    }

    return map;
}

/** True when a unit may end at line `i` for this kind of content. */
function makeBreakPredicate(kind, lines) {
    return (i) => {
        const line = lines[i];
        if (line === undefined) return false;

        // A blank line separates paragraphs, functions and list blocks in
        // every format we handle, so it is always a safe place to cut.
        if (line.trim() === "") return true;

        const next = lines[i + 1];
        if (next === undefined) return true;

        if (kind === CHUNK_KINDS.MARKDOWN && HEADING_RE.test(next)) return true;
        if (kind === CHUNK_KINDS.CODE && (TOP_LEVEL_DECL_RE.test(next) || TOP_LEVEL_CLOSE_RE.test(line))) return true;

        // Markdown lists and tables should not be torn apart mid-row.
        if (kind === CHUNK_KINDS.MARKDOWN) {
            const inTable = /^\s*\|/.test(line) && /^\s*\|/.test(next);
            const inList = /^\s*(?:[-*+]|\d+[.)])\s/.test(line) && /^\s*(?:[-*+]|\d+[.)])\s/.test(next);
            if (inTable || inList) return false;
        }

        return false;
    };
}

/* ------------------------------------------------------------------ */
/* packing                                                             */
/* ------------------------------------------------------------------ */

/** Group lines into atomic units that should not be split. Inclusive ranges. */
function splitIntoUnits(lines, canBreakAfter) {
    const units = [];
    let start = 0;

    for (let i = 0; i < lines.length; i += 1) {
        if (canBreakAfter(i)) {
            units.push([start, i]);
            start = i + 1;
        }
    }
    if (start < lines.length) units.push([start, lines.length - 1]);

    return units;
}

const unitChars = (lines, unit) => {
    let total = 0;
    for (let i = unit[0]; i <= unit[1]; i += 1) total += lines[i].length + 1;
    return total;
};

/**
 * Pack units into chunks near `target`, hard-splitting any unit above `max`.
 * Returns inclusive line ranges.
 */
function packUnits(lines, units, { target, max }) {
    const ranges = [];
    let current = null;
    let size = 0;

    const flush = () => {
        if (current) ranges.push(current);
        current = null;
        size = 0;
    };

    const pushHardSplit = (unit) => {
        let pieceStart = unit[0];
        let pieceChars = 0;

        for (let i = unit[0]; i <= unit[1]; i += 1) {
            const lineChars = lines[i].length + 1;

            // One line longer than max: cut inside it rather than emit an
            // oversized chunk, which the embedding API would reject outright.
            if (lineChars > max) {
                if (i > pieceStart) ranges.push([pieceStart, i - 1]);
                let remaining = lineChars;
                let offset = 0;
                while (remaining > max) {
                    ranges.push({ single: i, from: offset, to: offset + max });
                    offset += max;
                    remaining -= max;
                }
                ranges.push({ single: i, from: offset, to: lineChars });
                pieceStart = i + 1;
                pieceChars = 0;
                continue;
            }

            if (pieceChars + lineChars > max && i > pieceStart) {
                ranges.push([pieceStart, i - 1]);
                pieceStart = i;
                pieceChars = 0;
            }
            pieceChars += lineChars;
        }
        if (pieceStart <= unit[1]) ranges.push([pieceStart, unit[1]]);
    };

    for (const unit of units) {
        const chars = unitChars(lines, unit);

        if (chars > max) {
            flush();
            pushHardSplit(unit);
            continue;
        }

        // Cutting at `target` rather than filling to `max` keeps chunks in a
        // narrow size band, which matters: a 2400-char chunk and a 200-char
        // chunk do not compete fairly on cosine similarity.
        if (current && size + chars > target) flush();

        if (!current) current = [unit[0], unit[1]];
        else current[1] = unit[1];
        size += chars;
    }

    flush();
    return ranges;
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} params
 * @param {string} params.text     normalized text (LF newlines, no BOM)
 * @param {'markdown'|'code'|'text'} params.kind
 * @param {string} params.path     file path, used for provenance and prefixes
 * @param {string} [params.language]
 * @param {string} [params.convertedFrom] original format when anydoc converted it
 * @param {object} [params.options] overrides for target/max/overlap/min chars
 * @returns {Array<object>} chunks in document order, `seq` starting at 0
 */
export function chunkDocument({ text, kind, path, language = "text", convertedFrom = "", options = {} }) {
    const target = Math.max(200, options.chunkTargetChars || 1600);
    const max = Math.max(target, options.chunkMaxChars || 2400);
    const overlap = Math.max(0, Math.min(options.chunkOverlapChars ?? 200, Math.floor(target / 2)));
    const minChars = Math.max(1, options.minChunkChars || 80);

    const normalized = String(text || "").replace(/\r\n?/g, "\n");
    if (!normalized.trim()) return [];

    const lines = normalized.split("\n");
    const lineStarts = buildLineStarts(normalized);
    const chunkKind = Object.values(CHUNK_KINDS).includes(kind) ? kind : CHUNK_KINDS.TEXT;

    const headingMap = chunkKind === CHUNK_KINDS.MARKDOWN ? buildHeadingMap(lines) : null;
    const symbolMap = chunkKind === CHUNK_KINDS.CODE ? buildSymbolMap(lines) : null;

    const units = splitIntoUnits(lines, makeBreakPredicate(chunkKind, lines));
    const ranges = packUnits(lines, units, { target, max });

    const chunks = [];

    for (const range of ranges) {
        // Oversized single lines come back as { single, from, to } descriptors.
        const isSlice = typeof range === "object" && !Array.isArray(range);

        let startLine = isSlice ? range.single : range[0];
        let endLine = isSlice ? range.single : range[1];
        // Where this chunk's OWN content begins, before any overlap is borrowed
        // from the previous chunk. heading/symbol are looked up here rather
        // than at startLine: overlap routinely reaches back across a heading or
        // a function boundary, and labelling a chunk with the section of its
        // borrowed prefix mislabels both the citation and the embedding.
        const naturalStart = startLine;
        let body = isSlice
            ? lines[range.single].slice(range.from, range.to)
            : sliceLines(lines, startLine, endLine);

        if (!body.trim()) continue;

        // Overlap: pull the tail of the previous chunk back in so a fact that
        // straddles a boundary is fully present in at least one chunk.
        if (overlap > 0 && chunks.length > 0) {
            const previous = chunks[chunks.length - 1];
            const previousLines = previous.text.split("\n");
            const kept = [];
            let taken = 0;

            for (let i = previousLines.length - 1; i >= 0 && taken < overlap; i -= 1) {
                kept.unshift(previousLines[i]);
                taken += previousLines[i].length + 1;
            }

            if (kept.length) {
                const overlapText = kept.join("\n");
                // previous.endLine is 1-based, so this is too.
                const overlapStartLine = previous.endLine - kept.length + 1;
                // Never let the overlap swallow the chunk or invert the range.
                if (overlapStartLine >= 1 && overlapText.length < body.length) {
                    body = `${overlapText}\n${body}`;
                    // startLine is 0-based everywhere else in this function; the
                    // record below adds 1. Mixing the two here would shift every
                    // overlapped chunk's citation by one line, which is exactly
                    // the kind of error that makes a source reference wrong
                    // without looking wrong.
                    startLine = overlapStartLine - 1;
                }
            }
        }

        if (body.trim().length < minChars && chunks.length > 0) {
            // Fold a stub into the previous chunk instead of indexing noise -
            // but only while the result stays under the hard maximum, or the
            // merge itself would produce a chunk the embedding API rejects.
            const previous = chunks[chunks.length - 1];
            const merged = `${previous.text}\n${body}`.trim();

            if (merged.length <= max) {
                previous.text = merged;
                // endLine is 0-based in this loop; previous.endLine is 1-based
                // on the record. Comparing them without converting understates
                // the citation by one line, which would make the merged chunk
                // claim a range that stops short of the text it now contains.
                previous.endLine = Math.max(previous.endLine, endLine + 1);
                previous.charEnd = lineEndOffset(normalized, lineStarts, previous.endLine - 1);
                previous.embeddingInput = previous.contextPrefix + previous.text;
                continue;
            }
        }

        const heading = headingMap ? headingMap[naturalStart] || "" : "";
        const symbol = symbolMap ? symbolMap[naturalStart] || "" : "";

        const chunk = {
            seq: chunks.length,
            kind: chunkKind,
            path,
            language: chunkKind === CHUNK_KINDS.MARKDOWN ? "markdown" : language,
            convertedFrom,
            heading,
            symbol,
            startLine: startLine + 1,
            endLine: endLine + 1,
            charStart: lineStarts[startLine],
            charEnd: lineEndOffset(normalized, lineStarts, endLine),
            text: body,
            contextPrefix: "",
            embeddingInput: "",
        };

        chunk.contextPrefix = buildContextPrefix(chunk);
        chunk.embeddingInput = chunk.contextPrefix + chunk.text;

        chunks.push(chunk);
    }

    return chunks;
}

/**
 * The string glued in front of a chunk before embedding.
 * Retrieval is far better when a chunk knows where it came from: without this,
 * a table row reading "EMEA | 4.2M" has nothing to match a question about
 * regional revenue against.
 */
export function buildContextPrefix(chunk) {
    const parts = [];
    const name = String(chunk.path || "document").split("/").pop();

    if (chunk.convertedFrom) {
        parts.push(`Document: ${name} (converted from ${chunk.convertedFrom})`);
    } else if (chunk.kind === CHUNK_KINDS.CODE) {
        parts.push(`Source file: ${name} (${chunk.language})`);
    } else {
        parts.push(`Document: ${name}`);
    }

    if (chunk.heading) parts.push(`Section: ${chunk.heading}`);
    if (chunk.symbol) parts.push(`Symbol: ${chunk.symbol}`);

    return parts.length ? `${parts.join("\n")}\n\n` : "";
}
