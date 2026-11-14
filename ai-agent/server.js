import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AIRuntime } from "./runtime/ai-runtime.js";
import {
    MAX_DOCUMENT_BYTES,
    DocumentParseError,
    parseDocumentBytes,
} from "./runtime/document-parser.js";
import { RagError } from "./rag/service.js";
import { VectorStoreError } from "./rag/vector-store.js";
import { EmbeddingError } from "./rag/embeddings.js";
import { createChatServices, resolveChatsRoot } from "./chats/index.js";
import { createSpeechRouter } from "./speech/transcription.js";

import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Electron-injected keys win; .env only fills what is missing.
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const PORT = Number(process.env.PORT) || Number(process.env.ARTEMIS_PORT) || 3000;

/*
 * CORS cannot distinguish the file:// renderer ("Origin: null") from a
 * sandboxed iframe, and any web page can POST to localhost. So Electron gives
 * the agent a random per-launch token; every /api request must carry it.
 * The token file lets a later launch identify and stop the agent that owns the
 * port. A standalone `npm run agent` has no token and stays unauthenticated,
 * which keeps local development and curl usable.
 */
const API_TOKEN = process.env.ARTEMIS_API_TOKEN || "";
const TOKEN_FILE = path.join(os.tmpdir(), `artemis-agent-${PORT}.token`);

function writeTokenFile() {
    if (!API_TOKEN) return;
    try {
        // Recreate the file so the mode is 0600 even if an older file existed.
        fs.rmSync(TOKEN_FILE, { force: true });
        fs.writeFileSync(TOKEN_FILE, API_TOKEN, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
        console.warn("[Artemis AI Agent] Could not write the token file:", error.message);
    }
}

function removeTokenFile() {
    if (!API_TOKEN) return;
    try {
        fs.rmSync(TOKEN_FILE, { force: true });
    } catch {
        // Best effort: a stale file is overwritten by the next launch.
    }
}

const API_TOKEN_BUFFER = Buffer.from(API_TOKEN);
const tokenMatches = (value) => {
    if (!API_TOKEN) return true;
    if (typeof value !== "string") return false;
    // Compare byte lengths: a 64-character non-ASCII string is longer than the
    // ASCII token in bytes, and timingSafeEqual throws on unequal lengths.
    const provided = Buffer.from(value);
    if (provided.length !== API_TOKEN_BUFFER.length) return false;
    return crypto.timingSafeEqual(provided, API_TOKEN_BUFFER);
};

const keyStatus = (key) => (key ? "set" : "not set");
console.log("[Env] NVIDIA_API_KEY:", keyStatus(process.env.NVIDIA_API_KEY));
console.log("[Env] GROQ_API_KEY:", keyStatus(process.env.GROQ_API_KEY));

const app = express();

/*
 * ============================================================
 * LOCAL-ONLY API
 * ============================================================
 * The agent is bundled with the desktop app and must never expose the
 * project directory over HTTP. Only the JSON API is served.
 */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

app.use(cors({
    origin(origin, callback) {
        // `file://` pages send either no Origin header or the literal "null".
        if (!origin || origin === "null" || ALLOWED_ORIGIN.test(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin not allowed"));
    }
}));
// Images arrive as base64 (about 33% bigger than the file). The renderer caps
// them at 3 images / 3 MB total, so 12 MB leaves room for text and history.
app.use(express.json({ limit: "12mb" }));

/*
 * Every /api route except the liveness probe and the shutdown command (which
 * checks the token itself) needs the per-launch token. The check runs before
 * the routes, so a sandboxed iframe on any page cannot read chats, models or
 * documents from 127.0.0.1 just because the browser sends Origin: null.
 * OPTIONS is left to CORS: the preflight never reaches a route handler.
 */
app.use("/api", (req, res, next) => {
    if (!API_TOKEN || req.method === "OPTIONS") return next();
    if (req.path === "/health" || req.path === "/shutdown") return next();
    if (tokenMatches(req.get("x-artemis-token"))) return next();
    return res.status(401).json({ ok: false, error: "Unauthorized" });
});

const runtime = new AIRuntime();

/*
 * ============================================================
 * CHAT HISTORY
 * ============================================================
 * Saved conversations, their attachments and AI-generated titles.
 * Lives in ./chats; this is the only line server.js needs.
 */
app.use("/api/chats", createChatServices({ runtime }).router);
app.use("/api/speech", createSpeechRouter());

/*
 * ============================================================
 * HEALTH
 * ============================================================
 */
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        service: "artemis-ai-agent",
        /*
         * Which data folder this agent reads. main/ai-server.js compares it
         * against its own: an agent from a standalone dev run (no
         * ARTEMIS_DATA_DIR) reads ai-agent/.data, and reusing it silently
         * shows an empty chat history. Reported, not secret - but only to a
         * caller that already holds the token, so the health probe cannot be
         * used to map the user's disk.
         */
        ...(tokenMatches(req.get("x-artemis-token")) ? { dataRoot: resolveChatsRoot() } : {}),
    });
});

/*
 * The Electron main process replaces a foreign agent (one that reads a
 * different data folder) with its own. Rather than killing a process it does
 * not own, it asks this one to leave.
 */
app.post("/api/shutdown", (req, res) => {
    if (!tokenMatches(req.get("x-artemis-token"))) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    res.json({ ok: true });
    shutdown("Shutdown request");
});

/*
 * ============================================================
 * MODEL REGISTRY
 * ============================================================
 */
app.get("/api/models", async (req, res) => {
    try {
        const registry = await runtime.getModels();
        res.json(registry);
    } catch (error) {
        console.error("[Model Registry]", error);
        res.status(500).json({ error: "Failed to load model registry" });
    }
});

/*
 * ============================================================
 * DOCUMENT PARSING (anydoc, local only)
 * ============================================================
 * Accepts raw document bytes and returns GitHub-Flavored Markdown, so the chat
 * view can put office documents and text-based PDFs in front of the model.
 * Everything runs on this machine: no API key, no OCR, no outbound calls.
 * A scanned PDF answers 422 with `needsOcr` and the affected page numbers.
 */
const PARSE_STATUS = {
    tooLarge: 413,
    unsupported: 415,
    encrypted: 415,
    parserUnavailable: 503,
};

app.post(
    "/api/parse",
    express.raw({ type: "application/octet-stream", limit: `${Math.ceil(MAX_DOCUMENT_BYTES / 1024 / 1024) + 1}mb` }),
    async (req, res) => {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const name = String(req.query.name || "").slice(0, 200);

        try {
            const result = await parseDocumentBytes(bytes, name);
            res.json({ ok: true, ...result });
        } catch (error) {
            const code = error instanceof DocumentParseError ? error.code : "malformed";
            if (code !== "needsOcr") console.error(`[Parse ${code}]`, name || "(unnamed)", error.message);

            res.status(PARSE_STATUS[code] || 422).json({
                ok: false,
                code,
                message: error.message || "the document could not be converted",
                ...(error.pages ? { pages: error.pages, pageCount: error.pageCount } : {}),
            });
        }
    }
);

/*
 * ============================================================
 * RETRIEVAL (RAG)
 * ============================================================
 * Indexes files into named collections and searches them.
 *
 * Conversion and chunking happen here, on this machine. Embedding does not:
 * chunk text is sent to NVIDIA's hosted endpoint, which is the one part of this
 * pipeline that leaves the box. GET /api/rag/status reports that plainly so the
 * UI can tell the user before they index anything sensitive.
 *
 * A file that cannot be indexed (a scanned PDF, an image, a binary) answers 200
 * with status "skipped" and a reason, not an error code: in a batch of ten
 * attachments that is an expected outcome for one file, and failing the whole
 * request would hide the nine that worked.
 */
const RAG_STATUS = {
    noApiKey: 503,
    disabled: 503,
    parserUnavailable: 503,
    badRegistry: 500,
    init: 500,
    modelChanged: 409,
    dimensionsChanged: 409,
    dimensionMismatch: 409,
    badCollectionId: 400,
    collectionFull: 413,
    tooManyChunks: 413,
    noChunks: 422,
    empty: 422,
    // Everything below is an upstream or transport failure, not a bad request.
    unauthorized: 502,
    notFound: 502,
    rateLimited: 502,
    overloaded: 502,
    serverError: 502,
    timeout: 504,
    network: 502,
};

const ragStatusOf = (error) => {
    const code = error instanceof RagError || error instanceof VectorStoreError || error instanceof EmbeddingError
        ? error.code
        : null;
    return RAG_STATUS[code] || 500;
};

const sendRagError = (res, error, label) => {
    const code = error?.code || "error";
    console.error(`[RAG ${code}]`, label || "", error?.message || error);
    res.status(ragStatusOf(error)).json({
        ok: false,
        code,
        message: error?.message || "the knowledge base request failed",
    });
};

app.get("/api/rag/status", async (req, res) => {
    res.json({ ok: true, ...(await runtime.getRagStatus()) });
});

app.get("/api/rag/collections", async (req, res) => {
    try {
        res.json({ ok: true, collections: await runtime.rag.listCollections() });
    } catch (error) {
        sendRagError(res, error, "list");
    }
});

app.get("/api/rag/collections/:id", async (req, res) => {
    try {
        res.json({ ok: true, collection: await runtime.rag.collectionStats(req.params.id) });
    } catch (error) {
        sendRagError(res, error, req.params.id);
    }
});

app.delete("/api/rag/collections/:id", async (req, res) => {
    try {
        await runtime.rag.deleteCollection(req.params.id);
        res.json({ ok: true, deleted: req.params.id });
    } catch (error) {
        sendRagError(res, error, req.params.id);
    }
});

app.delete("/api/rag/documents", async (req, res) => {
    const { collection, path: docPath } = req.query;
    if (!collection || !docPath) {
        return res.status(400).json({ ok: false, code: "badRequest", message: "collection and path are required" });
    }
    try {
        res.json({ ok: true, ...(await runtime.rag.removeDocument({ collection, path: String(docPath) })) });
    } catch (error) {
        sendRagError(res, error, docPath);
    }
});

/** Index one file. Raw bytes in the body, file name and collection in the query. */
app.post(
    "/api/rag/documents",
    express.raw({ type: "application/octet-stream", limit: `${Math.ceil(MAX_DOCUMENT_BYTES / 1024 / 1024) + 1}mb` }),
    async (req, res) => {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const name = String(req.query.name || "").slice(0, 400);
        const collection = String(req.query.collection || "default").slice(0, 120);

        if (!name) {
            return res.status(400).json({ ok: false, code: "badRequest", message: "a file name is required (?name=)" });
        }

        try {
            const result = await runtime.rag.ingestFile({ collection, bytes, name });
            res.json({ ok: result.status !== "error", collection, ...result });
        } catch (error) {
            sendRagError(res, error, name);
        }
    }
);

/** Search a collection without chatting. Used by the UI to preview what retrieval finds. */
app.post("/api/rag/query", async (req, res) => {
    const { collection, query, topK } = req.body || {};

    if (!collection || typeof query !== "string" || !query.trim()) {
        return res.status(400).json({ ok: false, code: "badRequest", message: "collection and query are required" });
    }

    try {
        const result = await runtime.rag.retrieveContext({
            collection: String(collection),
            query,
            topK: Number.isFinite(topK) ? Math.max(1, Math.min(50, Number(topK))) : undefined,
        });
        const { included, sources, ...metadata } = result;
        res.json({
            ok: true,
            ...metadata,
            sources: sources.map(({ body, ...source }) => source),
        });
    } catch (error) {
        sendRagError(res, error, String(collection));
    }
});

/*
 * ============================================================
 * CHAT (Server-Sent Events)
 * ============================================================
 */
app.post("/api/chat", async (req, res) => {
    const { prompt, messages, model, rag } = req.body || {};

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    // Keep an eye on abandoned requests so providers stop paying for tokens.
    let aborted = false;
    res.on("close", () => {
        aborted = true;
    });

    try {
        await runtime.executeChat({ prompt, messages, model, rag, isAborted: () => aborted }, res);
    } catch (error) {
        console.error("AI Runtime Server Error:", error);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "error", message: error.message || "Server Error" })}\n\n`);
        }
    } finally {
        if (!res.writableEnded) {
            res.end();
        }
    }
});

/*
 * ============================================================
 * STARTUP / SHUTDOWN
 * ============================================================
 */
const server = app.listen(PORT, "127.0.0.1", () => {
    // Only after the port is ours: an EADDRINUSE loser must not overwrite the
    // token file of the agent that is actually running.
    writeTokenFile();
    console.log(`[Artemis AI Agent] Listening on http://127.0.0.1:${PORT} (ready ${process.uptime().toFixed(1)}s after process start)`);
    // The first embedding request of a session pays DNS + TLS + a cold
    // endpoint. Pay that at startup, not on the user's first question.
    runtime.rag?.warmUp?.().catch(() => {});
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(`[Artemis AI Agent] Port ${PORT} is already in use. Another agent instance is probably running.`);
        process.exit(0);
    }
    console.error("[Artemis AI Agent] Server error:", error);
    process.exit(1);
});

const shutdown = (signal) => {
    console.log(`[Artemis AI Agent] ${signal} received. Shutting down.`);
    removeTokenFile();
    server.close(() => process.exit(0));
    // Do not hang forever on open SSE connections.
    setTimeout(() => process.exit(0), 1500).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
