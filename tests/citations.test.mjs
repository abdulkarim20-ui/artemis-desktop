import test from "node:test";
import assert from "node:assert/strict";

import {
    bestQuote,
    checkSupport,
    CitationStream,
    createCitationTransform,
    finalizeSources,
    SourceRegistry,
} from "../ai-agent/rag/citations.js";
import { AI_EVENT_TYPES } from "../ai-agent/runtime/events.js";

function collect(raw, chunks = [raw]) {
    const stream = new CitationStream();
    let output = "";
    for (const chunk of chunks) output += stream.push(chunk);
    output += stream.flush();
    return { output, stream };
}

function registryWithPassages(passages) {
    const registry = new SourceRegistry();
    registry.addPassages(passages.map((passage, index) => ({
        id: `S${index + 1}`,
        kind: "passage",
        path: `docs/${index + 1}.md`,
        body: passage,
        score: 0.8,
    })));
    return registry;
}

test("CitationStream removes a marker and anchors it in clean text", () => {
    const { output, stream } = collect("The pilot ran 12 weeks [S1].");

    assert.equal(output, "The pilot ran 12 weeks.");
    assert.deepEqual(stream.anchors, [{ at: output.indexOf("."), ids: ["S1"] }]);
});

test("CitationStream handles a marker split at every chunk boundary", () => {
    const raw = "The pilot ran 12 weeks [S1].";
    const expected = collect(raw);

    for (let split = 0; split <= raw.length; split += 1) {
        const actual = collect(raw, [raw.slice(0, split), raw.slice(split)]);
        assert.equal(actual.output, expected.output, `clean text differs at split ${split}`);
        assert.deepEqual(actual.stream.anchors, expected.stream.anchors, `anchor differs at split ${split}`);
    }

    const threeChunks = collect(raw, ["The pilot ran 12 weeks [S", "1", "]."]);
    assert.equal(threeChunks.output, expected.output);
    assert.deepEqual(threeChunks.stream.anchors, expected.stream.anchors);
});

test("CitationStream parses multiple marker forms", () => {
    const { stream } = collect("One [S1][S2]. Two [S1, S3]. Three [S1;S2].");

    assert.deepEqual(stream.anchors.map(({ ids }) => ids), [
        ["S1"], ["S2"], ["S1", "S3"], ["S1", "S2"],
    ]);
});

test("CitationStream leaves non-citations and fenced code untouched", () => {
    const raw = 'Read [link](x) and [Sam].\n```js\nconst arr = "arr[S1]";\n```';
    const { output, stream } = collect(raw);

    assert.equal(output, raw);
    assert.deepEqual(stream.anchors, []);
});

test("CitationStream drops an unfinished marker at flush", () => {
    const stream = new CitationStream();
    const output = stream.push("fact [S") + stream.flush();

    assert.equal(output, "fact");
    assert.deepEqual(stream.anchors, []);
});

test("CitationStream offsets refer to clean text after earlier markers", () => {
    const { output, stream } = collect("First claim [S1]. Second claim [S2].");

    assert.equal(output, "First claim. Second claim.");
    assert.equal(output.slice(0, stream.anchors[0].at), "First claim");
    assert.equal(output.slice(0, stream.anchors[1].at), "First claim. Second claim");
});

test("unknown ids are dropped and an unsupported-only response has no sources", () => {
    const registry = registryWithPassages(["The pilot ran for 12 weeks."]);
    const { output, stream } = collect("The budget was 99. [S9]");
    const result = finalizeSources({ text: output, anchors: stream.anchors, registry });

    assert.equal(result.mode, "none");
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.dropped, [{ id: "S9", reason: "unknown_id" }]);
});

test("hard-token checks re-attribute a sentence to its supporting source", () => {
    const registry = registryWithPassages([
        "The plan was reviewed and approved.",
        "Contact the team at a@b.com. The ratio is 5.2.",
    ]);
    const { output, stream } = collect("The ratio is 5.2 and contact a@b.com. [S1]");
    const result = finalizeSources({ text: output, anchors: stream.anchors, registry });

    assert.equal(result.mode, "cited");
    assert.deepEqual(result.sources.map(({ id }) => id), ["S2"]);
    assert.deepEqual(result.citations[0].ids, ["S2"]);
});

test("a hard token missing from every source invalidates the citation", () => {
    const registry = registryWithPassages(["The total is 12.", "The total is 20."]);
    const { output, stream } = collect("The total is 99. [S1]");
    const result = finalizeSources({ text: output, anchors: stream.anchors, registry });

    assert.equal(checkSupport("The total is 99.", registry.get("S1").body), false);
    assert.equal(result.mode, "none");
    assert.deepEqual(result.sources, []);
});

test("plain prose and a Hindi sentence may keep a valid citation", () => {
    const registry = registryWithPassages(["General guidance about the topic."]);

    for (const sentence of [
        "This agrees with the guidance.",
        "यह दस्तावेज़ उपयोगी जानकारी देता है",
    ]) {
        assert.equal(checkSupport(sentence, registry.get("S1").body), null);
        const { output, stream } = collect(`${sentence} [S1]`);
        assert.equal(finalizeSources({ text: output, anchors: stream.anchors, registry }).mode, "cited");
    }
});

test("unmarked refusals show no sources, but strong overlap uses the guarded inference fallback", () => {
    const registry = registryWithPassages([
        "Prompt engineering is the process of designing clear instructions for language models.",
    ]);

    const refusal = finalizeSources({
        text: "I can't find the requested budget.",
        anchors: [],
        registry,
    });
    assert.equal(refusal.mode, "none");

    const inferred = finalizeSources({
        text: "Prompt engineering is the process of designing clear instructions for language models.",
        anchors: [],
        registry,
    });
    assert.equal(inferred.mode, "inferred");
    assert.deepEqual(inferred.sources.map(({ id }) => id), ["S1"]);
});

test("source quotes use the best matching sentence and fall back to an excerpt", () => {
    const body = "Opening note. The pilot ran 12 weeks across 3 sites. Closing note.";
    assert.deepEqual(bestQuote("The pilot ran 12 weeks. [S1]", body), {
        quote: "The pilot ran 12 weeks across 3 sites.",
        quoteKind: "sentence",
    });
    assert.equal(bestQuote("A different subject.", body).quoteKind, "excerpt");
});

test("SourceRegistry IDs only readable attached files and removes line prefixes", () => {
    const registry = new SourceRegistry();
    const message = {
        content: [
            "<attached_files>",
            '<file path="notes.txt" status="complete"><content>',
            "1 | first line",
            "2 | second line",
            "</content></file>",
            '<file path="skip.txt" status="skipped"/>',
            '<file path="outline.txt"><outline>headings only</outline></file>',
            "</attached_files>",
        ].join("\n"),
    };

    registry.addAttachedFiles(message);

    assert.match(message.content, /<file id="F1" path="notes\.txt"/);
    assert.equal(registry.size, 1);
    assert.equal(registry.get("F1").body, "first line\nsecond line");
});

test("an empty registry is unchanged and produces no sources.used event", () => {
    const registry = new SourceRegistry();
    const event = { type: AI_EVENT_TYPES.RESPONSE_DELTA, text: "plain answer" };
    const transform = createCitationTransform({ registry });

    assert.equal(finalizeSources({ text: "answer", anchors: [], registry }), null);
    assert.deepEqual(transform(event), [event]);
});
