/**
 * ============================================================================
 * CONTEXT BLOCK (rag/context-block.js)
 * ============================================================================
 * Renders retrieved chunks into the <retrieved_context> block that is injected
 * into the user message before it reaches the model.
 *
 * This mirrors the existing <attached_files> contract on purpose: the model
 * already has strict rules about citing sources and about never describing
 * content it was not given, and retrieval should inherit that discipline rather
 * than inventing a second, looser one.
 *
 * Every included source carries a response-scoped id alongside its path, line
 * range, section and similarity score so the model can cite the exact passage.
 * ============================================================================
 */

import { RAG_DEFAULTS } from "./config.js";

/** Our own wrapper tags, escaped so file content cannot close them early. */
const WRAPPER_TAG_RE = /<(\/?)(retrieved_context|source|content)\b/gi;

const escapeTags = (text) => String(text).replace(WRAPPER_TAG_RE, "<\\$1$2");

const escapeAttr = (value) =>
    String(value ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Human-readable path and location metadata for code-oriented consumers. */
export function formatCitation(hit) {
    const lines = hit.startLine
        ? hit.startLine === hit.endLine
            ? ` L${hit.startLine}`
            : ` L${hit.startLine}-${hit.endLine}`
        : "";
    return `${hit.path}${lines}`;
}

/** A short, plain-text preview of a passage for the sources card. */
function excerptOf(text) {
    const clean = String(text || "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/[*_`>|]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return clean.length > 240 ? `${clean.slice(0, 237).trimEnd()}…` : clean;
}

function renderSource(hit, text, id) {
    const attrs = [
        `id="${id}"`,
        `path="${escapeAttr(hit.path)}"`,
        hit.convertedFrom ? `converted-from="${escapeAttr(hit.convertedFrom)}"` : null,
        hit.language ? `language="${escapeAttr(hit.language)}"` : null,
        hit.heading ? `section="${escapeAttr(hit.heading)}"` : null,
        hit.symbol ? `symbol="${escapeAttr(hit.symbol)}"` : null,
        hit.startLine ? `lines="${hit.startLine}-${hit.endLine}"` : null,
        hit.weak ? `match="weak"` : null,
        `score="${hit.score}"`,
    ].filter(Boolean).join(" ");

    return `<source ${attrs}>\n<content>\n${escapeTags(text)}\n</content>\n</source>`;
}

/**
 * @param {object} params
 * @param {Array<object>} params.hits retriever output, best first
 * @param {string} [params.query] the cleaned question, echoed back for provenance
 * @param {string} [params.collection]
 * @param {string} [params.skipped] reason when nothing was found
 * @param {number} [params.budgetChars] hard cap on the whole block
 * @param {string[]} [params.files] file names held by the knowledge base, so the
 *   model can say what it searched instead of guessing what exists
 * @param {"search"|"overview"} [params.mode] overview blocks cover whole documents
 * @param {boolean} [params.sampled] overview mode had to sample sections to fit
 * @returns {{ block: string, included: Array<object>, dropped: number, chars: number }}
 */
export function buildRetrievedContext({
    hits,
    query = "",
    collection = "",
    skipped = null,
    budgetChars,
    files = [],
    mode = "search",
    sampled = false,
}) {
    const budget = Math.max(2000, budgetChars || RAG_DEFAULTS.maxContextChars);
    const ranked = Array.isArray(hits) ? [...hits] : [];

    const header = (count, extra = "") =>
        `<retrieved_context collection="${escapeAttr(collection)}" query="${escapeAttr(query)}" hits="${count}"` +
        `${mode === "overview" ? ` mode="overview" sampled="${sampled ? "true" : "false"}"` : ""}` +
        ` files="${files.length}"${extra}>`;
    const filesLine = files.length
        ? `<kb_files>${files.map((f) => escapeTags(String(f))).join(" | ")}</kb_files>\n`
        : "";
    const footer = "</retrieved_context>";

    if (ranked.length === 0) {
        // Still emit a block. A search that ran and found nothing is information
        // the model needs: without it, "I found nothing" and "I never looked"
        // are indistinguishable, and the second one invites invention.
        const reason = skipped || "no matching passages were found";
        const block = `${header(0, ` status="empty"`)}\n${filesLine}${escapeTags(reason)}\n${footer}`;
        return { block, included: [], dropped: 0, chars: block.length };
    }

    // A single chunk may not consume the whole budget, or one long hit would
    // push out every other source and the model would see a single document.
    const perSourceCap = Math.max(600, Math.floor(budget / 2));

    const included = [];
    let dropped = 0;
    // The final header carries included.length and possibly an omitted="N"
    // attribute, so reserve slack for it rather than accounting for a header
    // that is not the one we will emit.
    let used = header(ranked.length).length + footer.length + filesLine.length + 64;

    for (const hit of ranked) {
        let text = String(hit.text || "");
        let clipped = false;

        if (text.length > perSourceCap) {
            text = text.slice(0, perSourceCap);
            clipped = true;
        }

        const id = `S${included.length + 1}`;
        const rendered = renderSource(hit, clipped ? `${text}\n[... this passage was clipped to fit ...]` : text, id);

        if (used + rendered.length > budget) {
            // Hits are ordered best-first, so everything from here down is a
            // worse match. Skip it and keep looking: a later, shorter hit may
            // still fit in the space this one would have taken.
            continue;
        }

        used += rendered.length;
        included.push({ hit, rendered, id });
    }

    if (included.length === 0) {
        // Every hit was individually too large for the budget we were given.
        const reason = "the matching passages were too large to include";
        const block = `${header(0, ` status="omitted"`)}\n${filesLine}${escapeTags(reason)}\n${footer}`;
        return { block, included: [], dropped: ranked.length, chars: block.length };
    }

    // Single source of truth for the count: whatever was ranked but did not end
    // up in `included`, whether it was skipped for size or never reached.
    dropped = ranked.length - included.length;
    const note = dropped > 0 ? ` omitted="${dropped}"` : "";

    const block =
        `${header(included.length, note)}\n${filesLine}` +
        included.map((entry) => entry.rendered).join("\n") +
        `\n${footer}`;

    return {
        block,
        included: included.map((entry) => ({
            id: entry.id,
            path: entry.hit.path,
            citation: formatCitation(entry.hit),
            heading: entry.hit.heading || "",
            symbol: entry.hit.symbol || "",
            score: entry.hit.score,
            startLine: entry.hit.startLine,
            endLine: entry.hit.endLine,
            convertedFrom: entry.hit.convertedFrom || "",
            excerpt: excerptOf(entry.hit.text),
            body: entry.hit.text,
        })),
        dropped,
        chars: block.length,
    };
}

/**
 * How much room the retrieval block may take inside a chat message.
 *
 * The agent caps a single message at 150000 characters and already reserves
 * most of that for <attached_files>. Asking for the configured budget when only
 * 3000 characters are left would push the message over the limit and turn a
 * working request into an error, so the caller passes what is actually free.
 */
export function contextBudget(messageChars, maxMessageChars, reserve = 2000) {
    const free = maxMessageChars - messageChars - reserve;
    return Math.min(RAG_DEFAULTS.maxContextChars, Math.max(0, free));
}
