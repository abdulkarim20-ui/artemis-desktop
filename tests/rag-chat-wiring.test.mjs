/**
 * ============================================================================
 * CHAT WIRING TESTS
 * ============================================================================
 * Retrieval is bolted onto a chat pipeline that already worked. These tests
 * cover the two ways that bolt-on can go wrong:
 *
 *   - The model is given a <retrieved_context> block with no rules explaining
 *     it, so it treats similarity-ranked fragments as whole files.
 *   - Retrieval fails and takes the chat down with it. Every failure here has
 *     to degrade to "answer from the message alone".
 *
 * Plus the invariant that makes injection safe at all: normalizeMessages must
 * hand back fresh objects, so appending a block to the newest user turn cannot
 * reach back into the renderer's own history array.
 * ============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import test from "node:test";
import assert from "node:assert/strict";

import {
    BASE_RULES,
    CITATION_RULES,
    FILE_RULES,
    GROUNDING_RULES,
    RAG_RULES,
    SMALL_TALK_RULES,
    buildSystemMessages,
} from "../ai-agent/runtime/system-prompts.js";
import { AI_EVENT_TYPES, sendEvent } from "../ai-agent/runtime/events.js";
import { AIRuntime, normalizeMessages } from "../ai-agent/runtime/ai-runtime.js";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

const ATTACHED = '<attached_files>\n<file path="a.js" status="complete">\n<content>\n1 | const x = 1;\n</content>\n</file>\n</attached_files>';
const RETRIEVED = '<retrieved_context collection="kb" query="q" hits="1">\n<source path="docs/r.docx" lines="4-9" score="0.7">\n<content>\nRevenue grew.\n</content>\n</source>\n</retrieved_context>';

/* ------------------------------------------------------------------ */
/* system prompt selection                                             */
/* ------------------------------------------------------------------ */

test("a plain message gets the base rules only", () => {
    const [system] = buildSystemMessages([user("what does this function do?")]);

    assert.equal(system.role, "system");
    assert.ok(system.content.includes(BASE_RULES));
    assert.ok(!system.content.includes(FILE_RULES), "file rules were added with no attached files");
    assert.ok(!system.content.includes(RAG_RULES), "retrieval rules were added with no retrieved block");
    assert.ok(!system.content.includes(CITATION_RULES), "citation rules were added with no source context");
});

test("an attached_files block brings in the file rules", () => {
    const [system] = buildSystemMessages([user(`explain this\n\n${ATTACHED}`)]);

    assert.ok(system.content.includes(FILE_RULES));
    assert.ok(!system.content.includes(RAG_RULES));
});

test("grounding rules ride along with any file or retrieval block, and only then", () => {
    const withFiles = buildSystemMessages([user(`q\n\n${ATTACHED}`)])[0];
    assert.ok(withFiles.content.includes(GROUNDING_RULES), "no grounding rules with files present");
    assert.ok(withFiles.content.includes(CITATION_RULES), "no citation rules with files present");

    const withRetrieved = buildSystemMessages([user(`q\n\n${RETRIEVED}`)])[0];
    assert.ok(withRetrieved.content.includes(GROUNDING_RULES), "no grounding rules with retrieved passages");
    assert.ok(withRetrieved.content.includes(CITATION_RULES), "no citation rules with retrieved passages");

    const plain = buildSystemMessages([user("plain question")])[0];
    assert.ok(!plain.content.includes(GROUNDING_RULES), "grounding rules sent with no context at all");
});

test("a small-talk turn gets the casual rules and no file rules", () => {
    const [system] = buildSystemMessages([user(`explain this\n\n${ATTACHED}`)], { smallTalk: true });

    assert.ok(system.content.includes(SMALL_TALK_RULES));
    assert.ok(!system.content.includes(FILE_RULES), "file rules sent on a small-talk turn");
    assert.ok(!system.content.includes(GROUNDING_RULES), "grounding rules sent on a small-talk turn");
    assert.ok(!system.content.includes(CITATION_RULES), "citation rules sent on a small-talk turn");
});

test("a retrieved_context block brings in the retrieval rules", () => {
    const [system] = buildSystemMessages([user(`explain this\n\n${RETRIEVED}`)]);

    assert.ok(system.content.includes(RAG_RULES));
    assert.ok(!system.content.includes(FILE_RULES));
});

test("both blocks present gets both rule sets", () => {
    const [system] = buildSystemMessages([user(`q\n\n${ATTACHED}\n\n${RETRIEVED}`)]);

    assert.ok(system.content.includes(FILE_RULES));
    assert.ok(system.content.includes(RAG_RULES));
    assert.ok(system.content.indexOf(BASE_RULES) < system.content.indexOf(RAG_RULES));
});

test("detection only looks at user turns", () => {
    // An assistant message quoting the block - or the user asking ABOUT the
    // block - must not silently change the system prompt for later turns.
    const [fromAssistant] = buildSystemMessages([
        user("hello"),
        assistant(`here is what I found: ${RETRIEVED}`),
    ]);
    assert.ok(!fromAssistant.content.includes(RAG_RULES));

    // Only the newest user turn matters in practice, but any user turn counts.
    const [fromEarlier] = buildSystemMessages([user(`${RETRIEVED}`), assistant("ok"), user("and now?")]);
    assert.ok(fromEarlier.content.includes(RAG_RULES));
});

test("a caller that injects a block can state it explicitly", () => {
    // The runtime appends the block before building the prompt, so detection
    // would work anyway - but an explicit override means a caller cannot end up
    // with a block in the message and no rules explaining it.
    const [system] = buildSystemMessages([user("plain question")], { hasRetrieved: true });
    assert.ok(system.content.includes(RAG_RULES));

    const [suppressed] = buildSystemMessages([user(`${RETRIEVED}`)], { hasRetrieved: false });
    assert.ok(!suppressed.content.includes(RAG_RULES));
});

test("exactly one system message is produced, and it goes first", () => {
    const messages = buildSystemMessages([user("a"), assistant("b"), user("c")]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "system");
});

test("non-string and missing content cannot crash detection", () => {
    assert.doesNotThrow(() => buildSystemMessages([
        { role: "user" },
        { role: "user", content: null },
        { role: "user", content: 42 },
        { role: "user", content: ["a", "b"] },
    ]));
    assert.doesNotThrow(() => buildSystemMessages([]));
});

test("the retrieval rules cover the failure modes that produce confident nonsense", () => {
    // Each of these is a way the model goes wrong on ranked fragments rather
    // than on whole files. If one is dropped, retrieval gets quietly worse in a
    // way no test elsewhere would notice.
    const required = [
        [/EXCERPTS, NOT FILES/, "must say a source is a fragment, not the whole file"],
        [/RANKING IS NOT TRUTH/, "must say a high score is not correctness"],
        [/CITE SOURCES with the S ids/, "must require stable passage ids"],
        [/EMPTY MEANS EMPTY/, "must forbid filling a zero-hit search from memory"],
        [/CONFLICTS/, "must prefer attached files over an older indexed copy"],
        [/NO INVENTION/, "must forbid inventing an answer"],
        [/Never cite a page or slide number/, "must not invent document locations"],
    ];

    for (const [pattern, reason] of required) {
        assert.match(RAG_RULES, pattern, reason);
    }
});

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

test("the retrieval lifecycle has start, hits and error events", () => {
    assert.equal(AI_EVENT_TYPES.RAG_START, "rag.start");
    assert.equal(AI_EVENT_TYPES.RAG_HITS, "rag.hits");
    assert.equal(AI_EVENT_TYPES.RAG_ERROR, "rag.error");

    const ragEvents = Object.values(AI_EVENT_TYPES).filter((type) => type.startsWith("rag."));
    assert.equal(ragEvents.length, 3, "there is no terminal rag event the renderer must wait for");

    // No collision with the chat events they sit alongside.
    assert.equal(new Set(Object.values(AI_EVENT_TYPES)).size, Object.keys(AI_EVENT_TYPES).length);
});

test("sendEvent writes an SSE frame", () => {
    const written = [];
    const res = { writableEnded: false, destroyed: false, writable: true, write: (chunk) => written.push(chunk) };

    sendEvent(res, { type: AI_EVENT_TYPES.RAG_HITS, hits: 2 });

    assert.equal(written.length, 1);
    assert.ok(written[0].startsWith("data: "), "an SSE frame must start with 'data: '");
    assert.ok(written[0].endsWith("\n\n"), "an SSE frame must end with a blank line");
    assert.deepEqual(JSON.parse(written[0].slice(6)), { type: "rag.hits", hits: 2 });
});

test("sendEvent is silent on a closed stream", () => {
    // The renderer aborts streams on view unmount. Writing to a dead socket
    // would surface as a stream error long after the user moved on.
    for (const res of [
        { writableEnded: true, destroyed: false, writable: true, write: () => assert.fail("wrote to an ended stream") },
        { writableEnded: false, destroyed: true, writable: true, write: () => assert.fail("wrote to a destroyed stream") },
        { writableEnded: false, destroyed: false, writable: false, write: () => assert.fail("wrote to a non-writable stream") },
    ]) {
        assert.doesNotThrow(() => sendEvent(res, { type: AI_EVENT_TYPES.RAG_ERROR }));
    }
});

test("sendEvent swallows a write that throws mid-frame", () => {
    const res = {
        writableEnded: false,
        destroyed: false,
        writable: true,
        write: () => { throw new Error("socket closed between the check and the write"); },
    };

    assert.doesNotThrow(() => sendEvent(res, { type: AI_EVENT_TYPES.RAG_START }));
});

/* ------------------------------------------------------------------ */
/* message normalization and injection safety                          */
/* ------------------------------------------------------------------ */

test("normalizeMessages returns fresh objects, so injection cannot leak backwards", () => {
    const history = [user("first question"), assistant("an answer"), user("second question")];

    const normalized = normalizeMessages({ messages: history });
    const lastUser = [...normalized].reverse().find((message) => message.role === "user");

    // This is exactly what #applyRetrieval does with a retrieved block.
    lastUser.content = `${lastUser.content}\n\n${RETRIEVED}`;

    assert.ok(lastUser.content.includes("<retrieved_context"));
    assert.equal(
        history[2].content,
        "second question",
        "the renderer's own history was mutated, so the block would be re-sent and re-appended every turn"
    );
    assert.notEqual(lastUser, history[2]);
});

test("normalization drops system turns and empty messages", () => {
    const normalized = normalizeMessages({
        messages: [
            { role: "system", content: "injected by the browser" },
            user("   "),
            user("real question"),
            assistant("real answer"),
        ],
    });

    assert.deepEqual(normalized, [
        { role: "user", content: "real question" },
        { role: "assistant", content: "real answer" },
    ]);
});

test("a legacy prompt string still produces a user turn", () => {
    assert.deepEqual(normalizeMessages({ prompt: "  just a question  " }), [
        { role: "user", content: "just a question" },
    ]);
});

test("no user turn at all is an error, not an empty request", () => {
    assert.throws(() => normalizeMessages({ messages: [assistant("only an answer")] }), /No prompt provided/);
    assert.throws(() => normalizeMessages({}), /No prompt provided/);
});

test("oversized attachments are refused with an actionable message", () => {
    const huge = `<attached_files>${"x".repeat(200000)}</attached_files>`;

    assert.throws(
        () => normalizeMessages({ messages: [user(huge)] }),
        (error) => {
            assert.match(error.message, /Attach fewer or smaller files/);
            return true;
        }
    );
});

test("an oversized plain message is cut rather than rejected", () => {
    const normalized = normalizeMessages({ messages: [user("y".repeat(200000))] });

    assert.equal(normalized[0].content.length, 150000);
});

async function runCitationTurn({
    chunks,
    sourceBody,
    failBeforeResponse = false,
    userMessage = "How long was the pilot?",
    ragEnabled = true,
}) {
    const runtime = new AIRuntime();
    const model = { id: "groq:test", provider: "groq", model: "test-model", name: "Test", request: {} };
    const included = {
        id: "S1",
        path: "docs/report.md",
        heading: "Pilot",
        body: sourceBody,
        score: 0.8,
    };
    runtime.registry = { resolve: async () => model };
    runtime.rag = {
        retrieveContext: async () => ({
            block: '<retrieved_context><source id="S1"><content>passage</content></source></retrieved_context>',
            included: [included],
            sources: [{ ...included }],
            hits: 1,
            dropped: 0,
            skipped: null,
        }),
    };

    let providerMessages;
    runtime.providers = {
        groq: {
            async streamChat(args, res) {
                providerMessages = args.messages;
                if (failBeforeResponse) {
                    sendEvent(res, { type: AI_EVENT_TYPES.ERROR, message: "provider failed" });
                    return;
                }
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_START });
                for (const text of chunks) {
                    sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_DELTA, text });
                }
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_END });
                sendEvent(res, { type: AI_EVENT_TYPES.DONE });
            },
        },
    };

    const written = [];
    const response = {
        writableEnded: false,
        destroyed: false,
        writable: true,
        write: (chunk) => written.push(chunk),
    };
    await runtime.executeChat({
        messages: [user(userMessage)],
        model,
        rag: ragEnabled ? { enabled: true, collection: "kb" } : null,
    }, response);

    const events = written.map((frame) => JSON.parse(frame.slice(6)));
    return { events, providerMessages };
}

test("the runtime streams clean text and emits validated sources.used before response.end", async () => {
    const { events, providerMessages } = await runCitationTurn({
        chunks: ["The pilot ran 12 weeks ", "[S", "1]."],
        sourceBody: "The pilot ran 12 weeks across 3 sites.",
    });

    const deltas = events.filter(({ type }) => type === AI_EVENT_TYPES.RESPONSE_DELTA);
    const usedIndex = events.findIndex(({ type }) => type === AI_EVENT_TYPES.SOURCES_USED);
    const endIndex = events.findIndex(({ type }) => type === AI_EVENT_TYPES.RESPONSE_END);
    const used = events[usedIndex];

    assert.equal(deltas.map(({ text }) => text).join(""), "The pilot ran 12 weeks.");
    assert.ok(usedIndex >= 0 && usedIndex < endIndex, "sources.used must precede response.end");
    assert.equal(used.mode, "cited");
    assert.deepEqual(used.sources.map(({ id }) => id), ["S1"]);
    assert.equal(used.sources[0].quote, "The pilot ran 12 weeks across 3 sites.");
    assert.deepEqual(used.searched, { passages: 1, files: 0 });
    assert.ok(providerMessages[0].content.includes("CITATIONS."));

    const retrievalEvent = events.find(({ type }) => type === AI_EVENT_TYPES.RAG_HITS);
    assert.ok(!("body" in retrievalEvent.sources[0]), "retrieval bodies must not be sent to the renderer");
    assert.ok(!("body" in used.sources[0]), "citation bodies must not be sent to the renderer");
});

test("an unmarked general-knowledge answer produces mode none", async () => {
    const { events } = await runCitationTurn({
        chunks: ["A JWT is a signed token used to authenticate requests."],
        sourceBody: "The pilot ran 12 weeks across 3 sites.",
    });

    const used = events.find(({ type }) => type === AI_EVENT_TYPES.SOURCES_USED);
    assert.equal(used.mode, "none");
    assert.deepEqual(used.sources, []);
});

test("inline attached files receive F ids and can produce validated sources", async () => {
    const { events, providerMessages } = await runCitationTurn({
        chunks: ["The pilot ran 12 weeks. [F1]"],
        sourceBody: "The pilot ran 12 weeks.",
        userMessage: [
            "How long was the pilot?",
            '<attached_files><file path="report.txt" status="complete"><content>',
            "1 | The pilot ran 12 weeks.",
            "</content></file></attached_files>",
        ].join("\n"),
        ragEnabled: false,
    });

    const used = events.find(({ type }) => type === AI_EVENT_TYPES.SOURCES_USED);
    assert.equal(used.mode, "cited");
    assert.equal(used.sources[0].id, "F1");
    assert.equal(used.sources[0].kind, "file");
    assert.deepEqual(used.searched, { passages: 0, files: 1 });
    assert.match(providerMessages.at(-1).content, /<file id="F1" path="report\.txt"/);
});

test("a provider failure before response text emits no sources.used event", async () => {
    const { events } = await runCitationTurn({
        chunks: [],
        sourceBody: "The pilot ran 12 weeks across 3 sites.",
        failBeforeResponse: true,
    });

    assert.ok(events.some(({ type }) => type === AI_EVENT_TYPES.ERROR));
    assert.ok(!events.some(({ type }) => type === AI_EVENT_TYPES.SOURCES_USED));
});

/* ------------------------------------------------------------------ */
/* chat.js send path (source assertions)                               */
/* ------------------------------------------------------------------ */

/*
 * The send path is browser code with no testable seams, so its RAG behavior
 * is pinned by reading the source. The assertions below are the three things
 * that would silently break the answer-first policy if regressed:
 * the inline-first threshold exists, large attachments still wait for the
 * index, and outline mode is disabled exactly when the answer is sent first.
 */
test("the send path answers small attachments first and still waits for large ones", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(
        path.join(here, "../renderer/js/views/chat.js"),
        "utf8"
    );

    // (a) the inline-first threshold exists (answer-first policy is wired at all)
    assert.match(source, /INLINE_FIRST_MAX_CHARS/, "no INLINE_FIRST_MAX_CHARS threshold");

    // (b) large attachments still wait: the non-answer-first branch awaits the
    // pending indexing promises before the model is called.
    assert.match(
        source,
        /await Promise\.all\(pendingIndex\)/,
        "the large-attachment path no longer waits for the index"
    );

    // (c) outline mode is suppressed on answer-first turns, so a not-yet-indexed
    // small file is sent in full rather than as a 2000-char head.
    assert.match(
        source,
        /outlineHeadChars: ragHasContent && !answerFirst \? OUTLINE_HEAD_CHARS : null/,
        "outline mode is not guarded by !answerFirst"
    );
});

test("the runtime gates retrieval off on small talk and pins temperature on file turns", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(
        path.join(here, "../ai-agent/runtime/ai-runtime.js"),
        "utf8"
    );

    // The small-talk branch must exist and skip retrieval entirely.
    assert.match(source, /isSmallTalkTurn/, "no small-talk turn detector");
    assert.match(source, /if \(smallTalk\)/, "no small-talk branch in executeChat");
    assert.match(source, /lightenForSmallTalk/, "small-talk turns are not lightened");

    // Follow-up rewriting borrows the previous real question.
    assert.match(
        source,
        /const query = buildSearchQuery\(messages, lastUser\)/,
        "retrieval does not use buildSearchQuery for follow-ups"
    );

    // Grounded turns pin a low temperature; the guide's knob is visible in source.
    assert.match(source, /temperature: 0\.2/, "grounded turns are not pinned to a low temperature");
});

test("a file sent with no message is acknowledged locally, without a model call", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(
        path.join(here, "../renderer/js/views/chat.js"),
        "utf8"
    );

    assert.match(source, /ATTACH_ONLY_NOTE/, "no attach-only sentinel message");
    assert.match(source, /buildReadyMessage/, "no local Ready acknowledgement builder");
    assert.match(
        source,
        /if \(attachOnly\) \{[\s\S]*?buildReadyMessage\(otherFiles, fileCtx, ragSummary, \{[\s\S]*?return;/,
        "the attach-only turn is not answered locally"
    );
    // The old default prompt that produced the long description is gone.
    assert.ok(!source.includes("Please review the attached file(s)"), "the old describe-the-file prompt is still there");
});

test("an attach-only message never answers first and waits for the index", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "../renderer/js/views/chat.js"), "utf8");

    assert.match(source, /answerFirst = !attachOnly && totalChars > 0/, "attach-only can answer before embedding finishes");
    assert.match(source, /await backgroundIndex/, "a follow-up turn does not wait for in-flight indexing");
});

test("the sources panel appears only after the answer completes, not during streaming", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "../renderer/js/views/chat.js"), "utf8");

    // Rendering from ensureResponse() would put the panel above a half-written
    // answer, so the deferred renderer must be the only showSources caller in
    // the send path.
    const calls = source.match(/chatManager\.showSources\(/g) || [];
    assert.equal(calls.length, 1, "showSources is called from more than one place");
    assert.match(source, /const renderSources = \(\) => \{/, "no deferred sources renderer");
    assert.doesNotMatch(source, /selectUsedSources/, "the renderer still guesses which sources were used");
    assert.match(source, /type === 'sources\.used'/, "sources.used events are not collected");
    assert.match(source, /sources: Array\.isArray\(usedEvent\.sources\)/, "the validated event does not drive the source display");
    assert.match(source, /sources: usedInfo/, "the selected source set is not what gets saved");

    // Every finalize site hands the panel over only after the text is done:
    // the stream-end event, the post-stream safety finalize, the empty-answer
    // path, and the error path.
    const afterFinalize = (source.match(/finalizeResponse\((?:msg)?[Cc]ontroller\);[\s\S]{0,60}?renderSources\(\)/g) || []).length;
    assert.equal(afterFinalize, 4, "sources are not tied to every completion point");
    assert.match(
        source,
        /if \(error\?\.name === 'AbortError'\) \{\s*renderSources\(\);[\s\S]{0,300}sources: usedInfo/,
        "an interrupted answer is not filtered before its sources are saved"
    );
});

test("source chip groups passages by file and lists them in a hover panel without ranking details", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const read = (rel) => fs.readFile(path.join(here, rel), "utf8");
    const model = await read("../renderer/ai/components/sources/sources-model.js");
    const view = await read("../renderer/ai/components/sources/sources-view.js");
    const chat = await read("../renderer/ai/components/chat/chat.js");

    assert.match(model, /const files = new Map\(\)/);
    assert.match(model, /file\.sections\.length < MAX_SECTIONS/);
    assert.match(model, /source\.quote \|\| source\.excerpt/);
    assert.match(view, /ai-sources-excerpt/);
    assert.match(view, /label = 'Sources'/);
    assert.doesNotMatch(model + view, /source\.score|source\.convertedFrom|left out to fit/);

    const start = chat.indexOf("showSources(controller, info) {");
    const end = chat.indexOf("\n    startThinking(", start);
    const renderer = chat.slice(start, end);

    assert.match(renderer, /SourcesModel\.group\(sources\)/);
    assert.match(renderer, /info\.mode === "inferred" \? "Related files"/);
    assert.match(renderer, /if \(!sources\.length\) return null;/);
    assert.doesNotMatch(renderer, /Searched your documents\. Nothing relevant was found/);
});

test("grounding rules prohibit ids for sources the answer did not use", () => {
    assert.match(GROUNDING_RULES, /NO ID WITHOUT USE/);
    assert.match(CITATION_RULES, /Cite only what you actually used/);
});
