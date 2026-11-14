/**
 * Keeps a response-scoped source registry, strips citation markers from the
 * stream, and validates the sources the model claims to have used.
 */

import { AI_EVENT_TYPES } from "../runtime/events.js";
import { selectUsedSources } from "./source-inference.js";

const ID_RE = /[SF]\d{1,3}/g;
const MARKER_RE = /[ \t]*\[\s*([SF]\d{1,3}(?:\s*[,;]\s*[SF]\d{1,3})*)\s*\]/g;
const HOLD_RE = /[ \t]*(?:\[[\sSF\d,;]{0,40}|`{1,3})?$/;
const PARTIAL_TAIL_RE = /[ \t]*\[[\sSF\d,;]*$/;

const STOP = new Set((
    "a an the and or but if then than so as at by for from in into of on to with without about after again also because before being " +
    "both can could did do does doing each few had has have having here how its just more most not now only other our out over own " +
    "same should some such that their them there these they this those through under until very was were what when where which while " +
    "who whom why will would you your are be been is it"
).split(" "));

const words = (text) => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const stem = (word) => (word.length > 5 ? word.replace(/(ing|ed|es|s)$/, "") : word);
const isContent = (word) => word.length >= 4 && !STOP.has(word);
const normalize = (text) => String(text || "").toLowerCase().replace(/(?<=\d),(?=\d)/g, "");
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const baseName = (path) => String(path || "").split(/[\\/]/).pop() || "";

export class SourceRegistry {
    #items = new Map();

    get size() { return this.#items.size; }
    get(id) { return this.#items.get(id); }
    entries() { return [...this.#items.values()]; }

    /** @param {Array<object>} included from buildRetrievedContext().included */
    addPassages(included) {
        for (const item of included || []) {
            if (!item?.id) continue;
            this.#items.set(item.id, {
                id: item.id,
                kind: "passage",
                path: item.path,
                name: baseName(item.path),
                section: item.heading || item.symbol || "",
                startLine: item.startLine || 0,
                endLine: item.endLine || 0,
                convertedFrom: item.convertedFrom || "",
                score: item.score,
                body: String(item.body || ""),
            });
        }
    }

    /**
     * Assign ids to readable attached files in the newest user message.
     * Skipped and outline-only files are not citable.
     * @param {{content: string}} message the newest user message (mutated)
     */
    addAttachedFiles(message) {
        if (!message || typeof message.content !== "string" || !message.content.includes("<attached_files")) return;
        let nextId = 0;
        message.content = message.content.replace(
            /<file\s+([^>]*?)(?<!\/)>([\s\S]*?)<\/file>/g,
            (full, attrs, inner) => {
                const content = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(inner);
                if (!content || /status="skipped"/.test(attrs)) return full;

                const path = (/path="([^"]*)"/.exec(attrs)?.[1] || "").replace(/&quot;/g, '"');
                const id = `F${++nextId}`;
                this.#items.set(id, {
                    id,
                    kind: "file",
                    path,
                    name: baseName(path),
                    section: "",
                    startLine: 0,
                    endLine: 0,
                    convertedFrom: /converted-from="([^"]*)"/.exec(attrs)?.[1] || "",
                    score: null,
                    body: content[1].replace(/^\s*\d+ \| ?/gm, ""),
                });
                return `<file id="${id}" ${attrs}>${inner}</file>`;
            }
        );
    }
}

/** Removes markers from streamed text and records offsets into the clean text. */
export class CitationStream {
    pending = "";
    text = "";
    anchors = [];
    #fence = false;

    push(chunk) {
        this.pending += String(chunk || "");
        const held = HOLD_RE.exec(this.pending);
        const cut = held ? held.index : this.pending.length;
        const ready = this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut);
        return this.#consume(ready);
    }

    flush() {
        const rest = this.pending.replace(PARTIAL_TAIL_RE, "");
        this.pending = "";
        return this.#consume(rest);
    }

    #consume(ready) {
        let output = "";
        for (const piece of ready.split(/(```)/)) {
            if (piece === "```") {
                this.#fence = !this.#fence;
                output += piece;
                continue;
            }
            if (this.#fence) {
                output += piece;
                continue;
            }

            let last = 0;
            for (const marker of piece.matchAll(MARKER_RE)) {
                output += piece.slice(last, marker.index);
                last = marker.index + marker[0].length;
                this.anchors.push({
                    at: this.text.length + output.length,
                    ids: marker[1].match(ID_RE),
                });
            }
            output += piece.slice(last);
        }
        this.text += output;
        return output;
    }
}

/** Hard values must occur in the source; plain prose can be paraphrased freely. */
export function hardTokens(sentence) {
    const text = String(sentence || "");
    const tokens = new Set();
    for (const match of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) tokens.add(match[0].toLowerCase());
    for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
        tokens.add(match[0].toLowerCase().replace(/[.,;]+$/, ""));
    }
    for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        const number = match[0].replace(/,/g, "").replace(/\.$/, "");
        if (number.replace(".", "").length >= 2) tokens.add(number);
    }
    for (const match of text.matchAll(/\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b\w+\(\)/g)) {
        tokens.add(match[0].toLowerCase());
    }
    return [...tokens];
}

/**
 * true means hard tokens support the source; false means they contradict it;
 * null means this sentence has no hard tokens to verify.
 */
export function checkSupport(sentence, body) {
    const tokens = hardTokens(sentence);
    if (!tokens.length) return null;
    const haystack = normalize(body);
    return tokens.filter((token) => haystack.includes(token)).length / tokens.length >= 0.5;
}

function sentenceBefore(text, at) {
    const head = text.slice(0, at);
    const body = head.replace(/\s+$/, "").replace(/[.!?]+["')\]]*$/, "");
    let start = body.lastIndexOf("\n") + 1;
    for (const match of body.matchAll(/[.!?]["')\]]*\s+/g)) {
        start = Math.max(start, match.index + match[0].length);
    }
    return { start, text: head.slice(start).trim().replace(/^[-*•\d.)\s]+/, "") };
}

/** The best supporting sentence from a source, bounded for the renderer. */
export function bestQuote(sentence, body) {
    const queryWords = new Set(words(sentence).map(stem).filter(isContent));
    const tokens = hardTokens(sentence);
    let best = "";
    let bestScore = 0;

    for (const part of String(body || "").split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim()).filter(Boolean)) {
        let score = 0;
        for (const word of words(part).map(stem)) if (queryWords.has(word)) score += 1;
        const normalized = normalize(part);
        for (const token of tokens) if (normalized.includes(token)) score += 3;
        if (score > bestScore) {
            bestScore = score;
            best = part;
        }
    }

    if (best && bestScore >= 2) return { quote: clip(best, 300), quoteKind: "sentence" };
    const plain = String(body || "").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
    return { quote: clip(plain, 240), quoteKind: "excerpt" };
}

const publicSource = (source, sentences = "") => ({
    id: source.id,
    kind: source.kind,
    path: source.path,
    name: source.name,
    section: source.section,
    startLine: source.startLine,
    endLine: source.endLine,
    convertedFrom: source.convertedFrom,
    score: source.score,
    ...bestQuote(sentences, source.body),
});

/** Turn raw anchors into validated sources. */
export function finalizeSources({ text, anchors, registry }) {
    const none = { mode: "none", sources: [], citations: [], dropped: [] };
    if (!registry || !registry.size) return null;

    if (anchors.length) {
        const used = new Map();
        const citations = [];
        const dropped = [];

        for (const anchor of anchors) {
            const { start, text: sentence } = sentenceBefore(text, anchor.at);
            const kept = [];
            for (const id of anchor.ids) {
                const source = registry.get(id);
                if (!source) {
                    dropped.push({ id, reason: "unknown_id" });
                    continue;
                }

                let chosen = id;
                if (checkSupport(sentence, source.body) === false) {
                    const alternative = registry.entries().find(
                        (candidate) => candidate.id !== id && checkSupport(sentence, candidate.body) === true
                    );
                    if (!alternative) {
                        dropped.push({ id, reason: "unsupported_by_source" });
                        continue;
                    }
                    chosen = alternative.id;
                }
                if (!kept.includes(chosen)) kept.push(chosen);
            }

            if (!kept.length) continue;
            for (const id of kept) used.set(id, `${used.get(id) || ""} ${sentence}`.trim());
            citations.push({ start, end: anchor.at, ids: kept });
        }

        if (!used.size) return { ...none, dropped };
        return {
            mode: "cited",
            sources: [...used].map(([id, sentences]) => publicSource(registry.get(id), sentences)),
            citations,
            dropped,
        };
    }

    const inferred = selectUsedSources(text, registry.entries());
    if (!inferred.length) return none;
    return {
        mode: "inferred",
        sources: inferred.map((source) => publicSource(source, text)),
        citations: [],
        dropped: [],
    };
}

/** Create the per-response SSE event transform. */
export function createCitationTransform({ registry, searched = {} }) {
    if (!registry || !registry.size) return (event) => [event];

    const stream = new CitationStream();
    let started = false;
    let finished = false;

    const finish = () => {
        finished = true;
        const output = [];
        const tail = stream.flush();
        if (tail) output.push({ type: AI_EVENT_TYPES.RESPONSE_DELTA, text: tail });
        const result = finalizeSources({ text: stream.text, anchors: stream.anchors, registry });
        if (result) {
            if (result.dropped?.length) console.warn("[citations] dropped:", JSON.stringify(result.dropped));
            const { dropped, ...wire } = result;
            output.push({ type: AI_EVENT_TYPES.SOURCES_USED, ...wire, searched });
        }
        return output;
    };

    return (event) => {
        switch (event?.type) {
            case AI_EVENT_TYPES.RESPONSE_DELTA: {
                started = true;
                const text = stream.push(event.text);
                return text ? [{ ...event, text }] : [];
            }
            case AI_EVENT_TYPES.RESPONSE_END:
                return started && !finished ? [...finish(), event] : [event];
            case AI_EVENT_TYPES.DONE:
                return started && !finished ? [...finish(), event] : [event];
            default:
                return [event];
        }
    };
}
