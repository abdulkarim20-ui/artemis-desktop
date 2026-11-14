/**
 * ============================================================================
 * CHAT ROUTES (chats/chat-routes.js)
 * ============================================================================
 * HTTP surface of the history feature, mounted at /api/chats by server.js.
 *
 *   GET    /                       list chats (newest activity first)
 *   POST   /                       create a chat   { id, title? }      (idempotent)
 *   GET    /:id                    one chat with all its messages
 *   POST   /:id/messages           append messages { messages[], ragIndexed? }
 *   PATCH  /:id                    rename          { title }  and/or  { ragIndexed }
 *   DELETE /:id                    delete the chat, its files AND its RAG index
 *   POST   /:id/title              generate a title from the first message
 *   POST   /:id/files?name=&type=  store one attachment (raw bytes)
 *   GET    /:id/files/:fileId      read an attachment back
 * ============================================================================
 */
import express from "express";

import { ChatStore, ChatStoreError, CHAT_LIMITS } from "./chat-store.js";
import { resolveChatsRoot } from "./chat-paths.js";
import { knownChatFolders, importForeignChats } from "./chat-import.js";
import { TitleGenerator } from "./title-generator.js";

const STATUS = {
    badId: 400,
    badRequest: 400,
    notFound: 404,
    tooLarge: 413,
    tooMany: 413,
};

function sendError(res, error) {
    const known = error instanceof ChatStoreError;
    const status = known ? STATUS[error.code] || 400 : 500;
    if (!known) console.error("[Chats]", error);

    if (res.headersSent) return;
    res.status(status).json({
        ok: false,
        code: known ? error.code : "error",
        message: known ? error.message : "the chat history request failed",
    });
}

/** Express 4 does not catch rejected promises from async handlers. */
const handle = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((error) => sendError(res, error));
};

/**
 * @param {object} options
 * @param {{ registry: object, providers: object, rag?: { deleteCollection(id: string): Promise<unknown> } }} options.runtime
 *   the AIRuntime (only registry, providers and rag are used)
 * @param {string} [options.root] override the storage folder (tests)
 * @returns {{ router: import("express").Router, store: ChatStore, titles: TitleGenerator }}
 */
export function createChatServices({ runtime, root, titles } = {}) {
    const chatsRoot = root || resolveChatsRoot();

    /*
     * Which folder is being read - once, at startup, so an empty sidebar can
     * be checked against the log ("is it reading the folder I think it is?").
     * Callers that pin their own folder (tests) own their storage entirely:
     * no log, and no import of the machine's real chat folders into them.
     */
    const sources = root ? [] : knownChatFolders({ root: chatsRoot });
    if (!root) {
        console.log(`[Chats] reading chats from ${chatsRoot}`);
        if (sources.length > 0) {
            console.log(`[Chats] one-time import will also look in: ${sources.map((source) => source.path).join(", ")}`);
        }
    }

    const store = new ChatStore({ root: chatsRoot });
    const titleGenerator = titles || new TitleGenerator({
        registry: runtime.registry,
        providers: runtime.providers,
    });

    const router = express.Router();
    router.use(express.json({ limit: "6mb" }));

    /*
     * One-time import of chats saved under one of the other known data
     * folders. It runs once at mount, and the first request waits for it:
     * copying folders before the store builds its index means the imported
     * chats are simply there for the first list() - no second launch needed.
     */
    const imported = importForeignChats({ root: chatsRoot, sources }).catch((error) => {
        console.warn("[Chats] older chats could not be imported:", error?.message || error);
        return null; // the history that is already there still loads
    });

    // Create the storage folder lazily so a read-only disk fails one request, not startup.
    router.use((req, res, next) => {
        imported.then(() => store.init()).then(() => next(), (error) => sendError(res, error));
    });

    router.get("/", handle(async (req, res) => {
        res.json({ ok: true, chats: await store.list() });
    }));

    router.post("/", handle(async (req, res) => {
        const { id, title } = req.body || {};
        res.json({ ok: true, chat: await store.create({ id, title }) });
    }));

    router.get("/:id", handle(async (req, res) => {
        res.json({ ok: true, chat: await store.get(req.params.id) });
    }));

    router.post("/:id/messages", handle(async (req, res) => {
        const { messages, ragIndexed } = req.body || {};
        const meta = await store.appendMessages(req.params.id, messages, { ragIndexed });
        res.json({ ok: true, chat: meta });
    }));

    router.patch("/:id", handle(async (req, res) => {
        const { title, ragIndexed } = req.body || {};
        let meta = null;

        if (title !== undefined) meta = await store.rename(req.params.id, title);
        if (ragIndexed !== undefined) meta = await store.patchMeta(req.params.id, { ragIndexed });
        if (!meta) throw new ChatStoreError("badRequest", "nothing to update");

        res.json({ ok: true, chat: meta });
    }));

    router.delete("/:id", handle(async (req, res) => {
        const id = req.params.id;
        const deleted = await store.delete(id);

        // The chat owns its knowledge base. Best effort: retrieval may be off
        // (no API key) or the chat may never have indexed anything.
        try {
            await runtime?.rag?.deleteCollection?.(id);
        } catch {
            /* no collection, or retrieval unavailable */
        }

        res.json({ ok: true, deleted, id });
    }));

    router.post("/:id/title", handle(async (req, res) => {
        const { query, fileNames, modelId } = req.body || {};
        await store.get(req.params.id); // 404 early, before spending a model call

        const result = await titleGenerator.generate({
            query: typeof query === "string" ? query : "",
            fileNames: Array.isArray(fileNames) ? fileNames.map(String).slice(0, 10) : [],
            modelId: typeof modelId === "string" ? modelId : null,
        });

        const { meta, applied } = await store.setAutoTitle(req.params.id, result.title);
        res.json({ ok: true, title: meta.title, source: result.source, applied, chat: meta });
    }));

    router.post(
        "/:id/files",
        express.raw({ type: "application/octet-stream", limit: CHAT_LIMITS.maxFileBytes + 1024 }),
        handle(async (req, res) => {
            const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const file = await store.saveFile(req.params.id, {
                name: String(req.query.name || "file"),
                type: String(req.query.type || ""),
                bytes,
            });
            res.json({ ok: true, file });
        })
    );

    router.get("/:id/files/:fileId", handle(async (req, res) => {
        const { bytes, info } = await store.readFile(req.params.id, req.params.fileId);

        res.setHeader("Content-Type", info.type);
        res.setHeader("Content-Length", bytes.length);
        res.setHeader("X-Content-Type-Options", "nosniff");
        // Stored files are user content: never let one run as a page.
        res.setHeader("Content-Security-Policy", "sandbox");
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(info.name)}`);
        res.end(bytes);
    }));

    return { router, store, titles: titleGenerator };
}

