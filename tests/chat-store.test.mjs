/**
 * ============================================================================
 * CHAT STORE TESTS
 * ============================================================================
 * Chat history is the one part of the app whose bugs destroy the user's data,
 * so most tests here write, throw the instance away and read the folder back
 * with a fresh one. In-memory correctness is the easy half.
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { ChatStore, ChatStoreError, CHAT_LIMITS, normalizeRecord } from "../ai-agent/chats/chat-store.js";
import { CHAT_ID_RE } from "../ai-agent/chats/chat-paths.js";
import { sanitizeCollectionId } from "../ai-agent/rag/vector-store.js";
import { withTempRoot } from "./rag-fixtures.mjs";

const ID = "chat-lx3k9a-0123456789ab";
const user = (text, extra = {}) => ({ role: "user", text, content: text, ...extra });
const assistant = (content, extra = {}) => ({ role: "assistant", content, ...extra });

async function open(root) {
    const store = new ChatStore({ root });
    await store.init();
    return store;
}

/* ------------------------------------------------------------------ */

/* ids                                                                 */
/* ------------------------------------------------------------------ */
test("chat ids survive sanitizeCollectionId unchanged, so a chat always owns its own index", () => {
    for (const id of [ID, "chat-a1b2c3-aaaaaaaaaaaa", "abcde-fghij"]) {
        assert.ok(CHAT_ID_RE.test(id), id);
        assert.equal(sanitizeCollectionId(id), id);
    }
});

test("ids that could escape the folder or be re-mapped by sanitizeCollectionId are rejected", () => {
    for (const id of ["../etc/passwd", "a/b/c/d/e/f", "-leading-dash-id", "trailing-dash-id-", "short", "has space in id", "dot.dot.dot", ""]) {
        assert.ok(!CHAT_ID_RE.test(id), `accepted ${JSON.stringify(id)}`);
    }
});

test("every method rejects a bad id before touching the disk", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await assert.rejects(store.get("../x"), { code: "badId" });
        await assert.rejects(store.create({ id: "..\\..\\x" }), { code: "badId" });
        await assert.rejects(store.delete("/"), { code: "badId" });
        await assert.rejects(store.readFile(ID, "../../meta"), { code: "notFound" });
    });
});

/* ------------------------------------------------------------------ */
/* create / append / read                                              */
/* ------------------------------------------------------------------ */
test("a chat with no messages is not listed, and create() is idempotent", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        const first = await store.create({ id: ID });
        const second = await store.create({ id: ID, title: "ignored" });

        assert.equal(first.id, second.id);
        assert.equal(second.createdAt, first.createdAt);
        assert.deepEqual(await store.list(), []);
    });
});

test("messages round-trip through a brand-new store instance", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("What is RAG?")]);
        await store.appendMessages(ID, [assistant("Retrieval-augmented generation.", { sources: { kind: "hits", hits: 2 } })]);

        const reopened = await open(root);
        const { meta, messages } = await reopened.get(ID);

        assert.equal(meta.messageCount, 2);
        assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
        assert.equal(messages[0].text, "What is RAG?");
        assert.equal(messages[1].sources.hits, 2);
        assert.equal((await reopened.list())[0].id, ID);
    });
});

test("the first user message provides an immediate title, with no model involved", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });

        const meta = await store.appendMessages(ID, [user("how do I center a div in css when the parent is flex")]);

        assert.equal(meta.titleSource, "fallback");
        assert.match(meta.title, /^How do I center a div/);
    });
});

test("an attach-only first message is titled from the file name", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        const meta = await store.appendMessages(ID, [
            { role: "user", text: "", content: "(The user attached file(s) without a message.)", files: [{ name: "Q3 report.xlsx", size: 10, type: "application/vnd.ms-excel" }] },
        ]);
        assert.equal(meta.title, "Q3 report.xlsx");
        assert.equal(meta.fileCount, 1);
    });
});

test("appends to an unknown chat fail with notFound, and nothing is created", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await assert.rejects(store.appendMessages(ID, [user("hi")]), { code: "notFound" });
        assert.deepEqual(await fs.readdir(root), ["index.json"]);
    });
});

test("two concurrent appends keep the order they were issued in", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });

        await Promise.all(Array.from({ length: 25 }, (_, i) => store.appendMessages(ID, [user(`message ${i}`)])));

        const { messages, meta } = await store.get(ID);
        assert.equal(meta.messageCount, 25);
        assert.deepEqual(messages.map((m) => m.text), Array.from({ length: 25 }, (_, i) => `message ${i}`));
    });
});

test("a torn last line (crash mid-write) is skipped and the next append is not lost", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("one"), assistant("two")]);

        // Simulate a crash mid-append. Every append starts with "\n", so a torn
        // write is that newline plus half a JSON object, with no ending.
        await fs.appendFile(path.join(root, ID, "messages.jsonl"), '\n{"id":"m-torn","role":"user","con');

        let { messages } = await open(root).then((s) => s.get(ID));
        assert.deepEqual(messages.map((m) => m.content), ["one", "two"]);

        const fresh = await open(root);
        await fresh.appendMessages(ID, [user("three")]);
        ({ messages } = await fresh.get(ID));
        assert.deepEqual(messages.map((m) => m.content), ["one", "two", "three"]);
    });
});

test("limits: too many messages per request, and empty or malformed messages", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });

        await assert.rejects(store.appendMessages(ID, []), { code: "badRequest" });
        await assert.rejects(
            store.appendMessages(ID, Array.from({ length: CHAT_LIMITS.maxMessagesPerAppend + 1 }, () => user("x"))),
            { code: "badRequest" }
        );
        await assert.rejects(store.appendMessages(ID, [{ role: "system", content: "x" }]), { code: "badRequest" });
        await assert.rejects(store.appendMessages(ID, [{ role: "user", content: "   " }]), { code: "badRequest" });
        await assert.rejects(store.appendMessages(ID, ["nope"]), { code: "badRequest" });
    });
});

test("normalizeRecord drops unknown keys and fake file ids", () => {
    const record = normalizeRecord({
        role: "user",
        text: "hi",
        content: "hi",
        isAdmin: true,
        files: [{ id: "../../etc/passwd", name: "a/b\\c.txt", size: 5, type: "text/plain" }, { id: "f-0123456789abcdef", name: "ok.png", type: "bogus" }],
    });

    assert.equal(record.isAdmin, undefined);
    assert.equal(record.files[0].id, null);
    assert.ok(!/[\\/]/.test(record.files[0].name));
    assert.equal(record.files[1].id, "f-0123456789abcdef");
    assert.equal(record.files[1].type, "application/octet-stream");
});

/* ------------------------------------------------------------------ */
/* titles                                                              */
/* ------------------------------------------------------------------ */
test("an AI title applies once, and only while the title is still automatic", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("explain closures")]);

        const first = await store.setAutoTitle(ID, "JavaScript Closures Explained");
        assert.equal(first.applied, true);
        assert.equal(first.meta.titleSource, "ai");

        const second = await store.setAutoTitle(ID, "Something else");
        assert.equal(second.applied, false);
        assert.equal(second.meta.title, "JavaScript Closures Explained");
    });
});

test("a rename by the user is never overwritten by an AI title", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("hello")]);

        await store.rename(ID, '  "My project notes"  ');
        const result = await store.setAutoTitle(ID, "Greeting");

        assert.equal(result.applied, false);
        assert.equal(result.meta.title, "My project notes");
        assert.equal(result.meta.titleSource, "user");
        await assert.rejects(store.rename(ID, "   "), { code: "badRequest" });
    });
});

/* ------------------------------------------------------------------ */

/* files                                                               */
/* ------------------------------------------------------------------ */
test("a stored file comes back byte for byte, after a restart", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });

        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
        const info = await store.saveFile(ID, { name: "shot.png", type: "image/png", bytes });
        assert.match(info.id, /^f-[a-f0-9]{16}$/);
        assert.equal(info.size, bytes.length);

        const back = await (await open(root)).readFile(ID, info.id);
        assert.deepEqual([...back.bytes], [...bytes]);
        assert.equal(back.info.type, "image/png");
        assert.equal(back.info.name, "shot.png");
    });
});

test("files: empty, oversized and unknown ids are refused", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });

        await assert.rejects(store.saveFile(ID, { name: "a", bytes: Buffer.alloc(0) }), { code: "badRequest" });
        await assert.rejects(
            store.saveFile(ID, { name: "big", bytes: Buffer.alloc(CHAT_LIMITS.maxFileBytes + 1) }),
            { code: "tooLarge" }
        );
        await assert.rejects(store.readFile(ID, "f-0000000000000000"), { code: "notFound" });
        await assert.rejects(store.saveFile("chat-nope-000000000000", { name: "a", bytes: Buffer.from("x") }), { code: "notFound" });
    });
});

/* ------------------------------------------------------------------ */
/* delete + index                                                      */
/* ------------------------------------------------------------------ */
test("delete removes the folder, the files and the list entry", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("hello")]);
        await store.saveFile(ID, { name: "a.txt", type: "text/plain", bytes: Buffer.from("x") });

        assert.equal(await store.delete(ID), true);
        assert.equal(await store.delete(ID), false);
        assert.deepEqual(await store.list(), []);
        await assert.rejects(fs.access(path.join(root, ID)));
        assert.deepEqual((await open(root).then((s) => s.list())), []);
    });
});

test("a missing or corrupt index.json is rebuilt from the chat folders", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("survive me")]);

        await fs.writeFile(path.join(root, "index.json"), "{ not json");
        let listed = await (await open(root)).list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, ID);

        await fs.rm(path.join(root, "index.json"));
        listed = await (await open(root)).list();
        assert.equal(listed[0].title, "Survive me");
    });
});

test("a stray folder that is not a chat is ignored", async () => {
    await withTempRoot(async (root) => {
        await fs.mkdir(path.join(root, "not-a-chat-folder-0000"), { recursive: true });
        await fs.mkdir(path.join(root, "random folder"), { recursive: true });
        const store = await open(root);
        assert.deepEqual(await store.list(), []);
    });
});

test("list() is newest activity first", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        const ids = ["chat-aaaaaa-000000000001", "chat-aaaaaa-000000000002", "chat-aaaaaa-000000000003"];
        for (const id of ids) {
            await store.create({ id });
            await store.appendMessages(id, [user(`chat ${id}`)]);
            await new Promise((r) => setTimeout(r, 5));
        }
        await store.appendMessages(ids[0], [assistant("bump")]);

        assert.deepEqual((await store.list()).map((m) => m.id), [ids[0], ids[2], ids[1]]);
    });
});

test("ragIndexed is sticky: once true it never flips back", async () => {
    await withTempRoot(async (root) => {
        const store = await open(root);
        await store.create({ id: ID });
        await store.appendMessages(ID, [user("a")], { ragIndexed: true });
        const meta = await store.appendMessages(ID, [assistant("b")], { ragIndexed: false });
        assert.equal(meta.ragIndexed, true);
        assert.ok(new ChatStoreError("x", "y") instanceof Error);
    });
});
