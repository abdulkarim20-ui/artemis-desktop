/**
 * ============================================================================
 * CHAT ROUTES TESTS
 * ============================================================================
 * Runs the real Express router on an ephemeral port with a scripted title
 * model. Covers the contract the renderer depends on: status codes, the
 * create-then-append-then-title sequence, file round trips, and that deleting
 * a chat also deletes its RAG collection.
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createChatServices } from "../ai-agent/chats/chat-routes.js";
import { TitleGenerator } from "../ai-agent/chats/title-generator.js";
import { AI_EVENT_TYPES, sendEvent } from "../ai-agent/runtime/events.js";
import { withTempRoot } from "./rag-fixtures.mjs";

const express = createRequire(new URL("../package.json", import.meta.url))("express");

const ID = "chat-lx3k9a-0123456789ab";

const model = { id: "groq:openai/gpt-oss-20b", provider: "groq", model: "x", name: "X", request: {} };

function makeRuntime({ title = "Cheese Fondue Recipe", fail = false } = {}) {
    const deleted = [];
    const providers = {
        groq: {
            client: {},
            async streamChat(_args, res) {
                if (fail) return sendEvent(res, { type: AI_EVENT_TYPES.ERROR, message: "down" });
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_DELTA, text: title });
            },
        },
    };
    const registry = { getById: async () => model, getDefault: async () => model };
    return { registry, providers, rag: { deleteCollection: async (id) => { deleted.push(id); } }, deleted };
}

async function withServer(runtime, body) {
    await withTempRoot(async (root) => {
        const { router } = createChatServices({
            runtime,
            root,
            titles: new TitleGenerator({ registry: runtime.registry, providers: runtime.providers, timeoutMs: 500 }),
        });
        const app = express();
        app.use("/api/chats", router);

        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/chats`;
        const call = async (path, init = {}) => {
            const { json, ...rest } = init;
            const response = await fetch(`${base}${path}`, {
                ...rest,
                headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...(rest.headers || {}) },
                body: json ? JSON.stringify(json) : rest.body,
            });
            const type = response.headers.get("content-type") || "";
            return { status: response.status, headers: response.headers, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
        };
        try {
            await body(call, root);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
}

test("create, append, list and reopen: the full life of a chat", async () => {
    await withServer(makeRuntime(), async (call) => {
        assert.deepEqual((await call("/")).body, { ok: true, chats: [] });

        assert.equal((await call("/", { method: "POST", json: { id: ID } })).status, 200);
        assert.equal((await call("/", { method: "POST", json: { id: ID } })).status, 200, "create is idempotent");
        assert.equal((await call("/")).body.chats.length, 0, "an empty chat must not show in the sidebar");

        const appended = await call(`/${ID}/messages`, {
            method: "POST",
            json: { messages: [{ role: "user", text: "fondue recipe?", content: "fondue recipe?" }, { role: "assistant", content: "Melt the cheese." }] },
        });
        assert.equal(appended.status, 200);
        assert.equal(appended.body.chat.messageCount, 2);

        const listed = (await call("/")).body.chats;
        assert.equal(listed.length, 1);
        assert.equal(listed[0].title, "Fondue recipe?");

        const opened = (await call(`/${ID}`)).body.chat;
        assert.deepEqual(opened.messages.map((m) => m.role), ["user", "assistant"]);
    });
});

test("POST /:id/title applies the AI title once and returns the updated chat", async () => {
    await withServer(makeRuntime(), async (call) => {
        await call("/", { method: "POST", json: { id: ID } });
        await call(`/${ID}/messages`, { method: "POST", json: { messages: [{ role: "user", text: "fondue", content: "fondue" }] } });

        const first = await call(`/${ID}/title`, { method: "POST", json: { query: "fondue", fileNames: [] } });
        assert.equal(first.status, 200);
        assert.equal(first.body.title, "Cheese Fondue Recipe");
        assert.equal(first.body.source, "ai");
        assert.equal(first.body.applied, true);

        const second = await call(`/${ID}/title`, { method: "POST", json: { query: "fondue" } });
        assert.equal(second.body.applied, false);
    });
});

test("a title failure still answers 200 with the fallback title", async () => {
    await withServer(makeRuntime({ fail: true }), async (call) => {
        await call("/", { method: "POST", json: { id: ID } });
        await call(`/${ID}/messages`, { method: "POST", json: { messages: [{ role: "user", text: "plan my week", content: "plan my week" }] } });

        const res = await call(`/${ID}/title`, { method: "POST", json: { query: "plan my week" } });
        assert.equal(res.status, 200);
        assert.equal(res.body.source, "fallback");
        assert.equal(res.body.title, "Plan my week");
    });
});

test("renaming wins over a later AI title", async () => {
    await withServer(makeRuntime(), async (call) => {
        await call("/", { method: "POST", json: { id: ID } });
        await call(`/${ID}/messages`, { method: "POST", json: { messages: [{ role: "user", text: "hi", content: "hi" }] } });

        assert.equal((await call(`/${ID}`, { method: "PATCH", json: { title: "My title" } })).body.chat.title, "My title");
        const res = await call(`/${ID}/title`, { method: "POST", json: { query: "hi" } });
        assert.equal(res.body.applied, false);
        assert.equal(res.body.title, "My title");

        assert.equal((await call(`/${ID}`, { method: "PATCH", json: {} })).status, 400);
    });
});

test("error statuses: bad id 400, unknown chat 404, bad body 400", async () => {
    await withServer(makeRuntime(), async (call) => {
        assert.equal((await call("/not%20valid")).status, 400);
        assert.equal((await call(`/${ID}`)).status, 404);
        assert.equal((await call(`/${ID}/messages`, { method: "POST", json: { messages: [{ role: "user", content: "x" }] } })).status, 404);
        assert.equal((await call(`/${ID}/title`, { method: "POST", json: {} })).status, 404);

        await call("/", { method: "POST", json: { id: ID } });
        assert.equal((await call(`/${ID}/messages`, { method: "POST", json: { messages: "nope" } })).status, 400);
        assert.equal((await call("/", { method: "POST", json: { id: "../x" } })).status, 400);
    });
});

test("files: upload, restore and the headers that keep them inert", async () => {
    await withServer(makeRuntime(), async (call) => {
        await call("/", { method: "POST", json: { id: ID } });

        const bytes = Buffer.from("<script>alert(1)</script>");
        const up = await call(`/${ID}/files?name=${encodeURIComponent("évil file.html")}&type=text%2Fhtml`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: bytes,
        });
        assert.equal(up.status, 200);
        assert.equal(up.body.file.size, bytes.length);

        const down = await call(`/${ID}/files/${up.body.file.id}`);
        assert.equal(down.status, 200);

        assert.deepEqual(down.body, bytes);
        assert.equal(down.headers.get("content-security-policy"), "sandbox");
        assert.equal(down.headers.get("x-content-type-options"), "nosniff");
        assert.match(down.headers.get("content-disposition"), /filename\*=UTF-8''%C3%A9vil%20file\.html/);

        assert.equal((await call(`/${ID}/files/f-0000000000000000`)).status, 404);
        assert.equal((await call(`/${ID}/files/..%2Fmeta.json`)).status, 400);

        const empty = await call(`/${ID}/files?name=a.txt`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.alloc(0) });
        assert.equal(empty.status, 400);
    });
});

test("DELETE removes the chat and its RAG collection, and survives retrieval being off", async () => {
    const runtime = makeRuntime();
    await withServer(runtime, async (call, root) => {
        await call("/", { method: "POST", json: { id: ID } });
        await call(`/${ID}/messages`, { method: "POST", json: { messages: [{ role: "user", text: "x", content: "x" }] } });

        const res = await call(`/${ID}`, { method: "DELETE" });
        assert.equal(res.status, 200);
        assert.equal(res.body.deleted, true);
        assert.deepEqual(runtime.deleted, [ID], "the chat's own index was not deleted");
        assert.equal((await call(`/${ID}`)).status, 404);
        assert.deepEqual((await call("/")).body.chats, []);

        runtime.rag.deleteCollection = async () => { throw new Error("no api key"); };
        assert.equal((await call(`/${ID}`, { method: "DELETE" })).status, 200);
        assert.ok(root);
    });
});
