/**
 * ============================================================================
 * CHAT STORE (chats/chat-store.js)
 * ============================================================================
 * The persistence layer for chat history. Plain files, no database.
 *
 *   <root>/
 *     index.json                      list of every chat's metadata (a cache)
 *     <chatId>/
 *       meta.json                     title, counts, timestamps (atomic writes)
 *       messages.jsonl                one JSON message per line, append-only
 *       files/
 *         <fileId>.bin                the attachment's bytes
 *         <fileId>.json               its name, type and size
 *
 * Design rules, each one is covered by a test:
 *
 *   - messages.jsonl is append-only. Every append starts with "\n", so a crash
 *     in the middle of a write leaves one torn line that is skipped on read and
 *     never corrupts the next message.
 *   - meta.json is the truth, index.json is a cache. A missing or corrupt index
 *     is rebuilt from the chat folders.
 *   - Writes to one chat run strictly one after another (a per-chat queue), so
 *     concurrent appends keep the order they were issued in.
 *   - The index has its own queue and never waits on a chat queue, so the two
 *     can not deadlock.
 *   - Every id is validated before it is used in a path.
 * ============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { CHAT_ID_RE, FILE_ID_RE } from "./chat-paths.js";
import { DEFAULT_TITLE, cleanTitle, fallbackTitle, isUsableTitle } from "./title-utils.js";

export const CHAT_LIMITS = Object.freeze({
    maxMessagesPerAppend: 20,
    maxContentChars: 1_000_000,
    maxFilesPerMessage: 50,
    maxNotesPerMessage: 20,
    maxFileBytes: 25 * 1024 * 1024,
    maxUserTitleChars: 80,
});

const INDEX_VERSION = 1;
const META_VERSION = 1;
const ROLES = new Set(["user", "assistant"]);
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export class ChatStoreError extends Error {
    /**
     * @param {"badId"|"badRequest"|"notFound"|"tooLarge"|"tooMany"|string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = "ChatStoreError";
        this.code = code;
    }
}

/* ------------------------------------------------------------------ */
/* validation + normalisation (pure)                                   */
/* ------------------------------------------------------------------ */

function assertChatId(id) {
    // typeof first: CHAT_ID_RE.test(undefined) would test the string "undefined".
    if (typeof id !== "string" || !CHAT_ID_RE.test(id)) {
        throw new ChatStoreError("badId", "invalid chat id");
    }
    return id;
}

const stripControl = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "");

/** A file name with no directory part. Keeps accents and spaces. */
function safeName(value) {
    const name = stripControl(value).replace(/[\\/]+/g, "_").trim().slice(0, 200);
    return name || "file";
}

/** A relative path shown in the UI. Never used on disk. */
function safePath(value, fallback) {
    const parts = stripControl(value)
        .replace(/\\/g, "/")
        .split("/")
        .filter((part) => part && part !== "." && part !== "..");
    return parts.join("/").slice(0, 300) || fallback;
}

function normalizeFileRef(raw) {
    const ref = raw && typeof raw === "object" ? raw : {};
    const name = safeName(ref.name);
    const size = Number(ref.size);
    const type = typeof ref.type === "string" && MIME_RE.test(ref.type) ? ref.type : "application/octet-stream";

    return {
        id: typeof ref.id === "string" && FILE_ID_RE.test(ref.id) ? ref.id : null,
        name,
        path: safePath(ref.path, name),
        size: Number.isFinite(size) && size >= 0 ? size : 0,
        type,
    };
}

/**
 * Turn a message from the network into a record safe to store.
 * Unknown keys are dropped, so a client can not smuggle fields into the file.
 *
 * @throws {ChatStoreError} badRequest
 */
export function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ChatStoreError("badRequest", "each message must be an object");
    }
    if (!ROLES.has(raw.role)) {
        throw new ChatStoreError("badRequest", 'message role must be "user" or "assistant"');
    }

    const content = typeof raw.content === "string" ? raw.content : "";
    if (!content.trim()) {
        throw new ChatStoreError("badRequest", "message content is empty");
    }
    if (content.length > CHAT_LIMITS.maxContentChars) {
        throw new ChatStoreError("tooLarge", "message is too long to store");
    }

    const created = Number(raw.createdAt);
    const record = {
        id: `m-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
        role: raw.role,
        text: typeof raw.text === "string" ? raw.text.slice(0, CHAT_LIMITS.maxContentChars) : "",
        content,
        createdAt: Number.isFinite(created) && created > 0 ? Math.floor(created) : Date.now(),
    };

    if (raw.role === "user") {
        record.files = (Array.isArray(raw.files) ? raw.files : [])
            .slice(0, CHAT_LIMITS.maxFilesPerMessage)
            .map(normalizeFileRef);

        const notes = (Array.isArray(raw.notes) ? raw.notes : [])
            .filter((note) => typeof note === "string" && note.trim())
            .slice(0, CHAT_LIMITS.maxNotesPerMessage)
            .map((note) => note.slice(0, 500));
        if (notes.length) record.notes = notes;
    } else {
        if (raw.sources && typeof raw.sources === "object" && !Array.isArray(raw.sources)) {
            // Retrieval info shown under an answer. Small by nature; refuse anything huge.
            if (JSON.stringify(raw.sources).length <= 100_000) record.sources = raw.sources;
        }
        if (raw.interrupted === true) record.interrupted = true;
    }

    if (typeof raw.modelId === "string" && raw.modelId.trim()) {
        record.modelId = raw.modelId.trim().slice(0, 200);
    }

    return record;
}

/* ------------------------------------------------------------------ */
/* disk helpers                                                        */
/* ------------------------------------------------------------------ */

const isMissing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
        if (isMissing(error) || error instanceof SyntaxError) return null;
        throw error;
    }
}

/** Write to a temp file, then rename over the target: readers never see half a file. */
async function writeAtomic(file, data) {
    const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(temp, data);

    // Windows can refuse a rename for a moment while antivirus or an indexer holds the file.
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.rename(temp, file);
            return;
        } catch (error) {
            const retryable = ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
            if (!retryable || attempt >= 4) {
                await fs.rm(temp, { force: true }).catch(() => {});
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
    }
}

function parseMessages(raw) {
    const messages = [];
    for (const line of String(raw).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const record = JSON.parse(trimmed);
            if (record && typeof record === "object" && ROLES.has(record.role)) messages.push(record);
        } catch {
            // A torn line from a crash. Skipped; the next append starts on a fresh line.
        }
    }
    return messages;
}

/**
 * A meta record that is safe to sort, group and show, whatever state the file
 * on disk is in. The sidebar sorts by updatedAt and searches by title, so a
 * missing or wrongly typed field must not be able to break the whole list.
 * Key order is preserved, so a healthy record serialises exactly as before.
 */
function normalizeMeta(meta) {
    const count = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const createdAt = count(meta.createdAt, count(meta.updatedAt, Date.now()));

    return {
        ...meta,
        title: typeof meta.title === "string" && meta.title.trim() ? meta.title : DEFAULT_TITLE,
        createdAt,
        updatedAt: count(meta.updatedAt, createdAt),
        messageCount: Math.floor(count(meta.messageCount, 0)),
        fileCount: Math.floor(count(meta.fileCount, 0)),
        ragIndexed: meta.ragIndexed === true,
    };
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

export class ChatStore {
    #root;
    #index = new Map();
    #queues = new Map();
    #indexTail = Promise.resolve();
    #ready = null;

    /** @param {{ root: string }} options */
    constructor({ root }) {
        if (!root) throw new Error("ChatStore needs a root folder");
        this.#root = path.resolve(root);
    }

    get root() {
        return this.#root;
    }

    /** Create the folder and load (or rebuild) the index. Safe to call many times. */
    init() {
        this.#ready ||= this.#load().catch((error) => {
            this.#ready = null; // let the next request try again
            throw error;
        });
        return this.#ready;
    }

    /* ---------------- paths ---------------- */

    #dir(id) {
        return path.join(this.#root, assertChatId(id));
    }

    #metaFile(id) {
        return path.join(this.#dir(id), "meta.json");
    }

    #messagesFile(id) {
        return path.join(this.#dir(id), "messages.jsonl");
    }

    #filePaths(id, fileId) {
        const base = path.join(this.#dir(id), "files", fileId);
        return { bin: `${base}.bin`, info: `${base}.json` };
    }

    /* ---------------- queues ---------------- */

    /** Run `task` after every earlier task for the same chat. */
    #serial(id, task) {
        const previous = this.#queues.get(id) || Promise.resolve();
        const run = previous.then(task);
        const tail = run.then(() => undefined, () => undefined);
        this.#queues.set(id, tail);
        tail.then(() => {
            if (this.#queues.get(id) === tail) this.#queues.delete(id);
        });
        return run;
    }

    /** Index writes have their own queue. They never wait on a chat queue. */
    #updateIndex(mutate) {
        const run = this.#indexTail.then(async () => {
            mutate(this.#index);
            await writeAtomic(
                path.join(this.#root, "index.json"),
                JSON.stringify({ version: INDEX_VERSION, chats: [...this.#index.values()] })
            );
        });
        this.#indexTail = run.then(() => undefined, () => undefined);
        return run;
    }

    /* ---------------- meta ---------------- */

    async #readMeta(id) {
        const meta = await readJson(this.#metaFile(id));
        if (!meta || typeof meta !== "object" || meta.id !== id) {
            throw new ChatStoreError("notFound", "chat not found");
        }
        return meta;
    }

    async #writeMeta(meta) {
        await writeAtomic(this.#metaFile(meta.id), JSON.stringify(meta));
        await this.#updateIndex((index) => index.set(meta.id, meta));
        return { ...meta };
    }

    #newMeta(id, title) {
        const now = Date.now();
        const given = title === undefined || title === null ? "" : cleanTitle(title, { maxChars: CHAT_LIMITS.maxUserTitleChars });
        return {
            version: META_VERSION,
            id,
            title: given || DEFAULT_TITLE,
            titleSource: given ? "user" : "default",
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
            fileCount: 0,
            ragIndexed: false,
        };
    }

    /* ---------------- startup ---------------- */

    async #load() {
        await fs.mkdir(this.#root, { recursive: true });

        // index.json is only a cache. A file that cannot be read (locked by an
        // antivirus scan, half written) is treated like a missing one: the
        // chat folders below are the truth and rebuild it.
        let saved = null;
        try {
            saved = await readJson(path.join(this.#root, "index.json"));
        } catch (error) {
            console.warn("[Chats] index.json could not be read, rebuilding it:", error?.message || error);
        }

        const known = new Map();
        if (saved && saved.version === INDEX_VERSION && Array.isArray(saved.chats)) {
            for (const meta of saved.chats) {
                if (meta && typeof meta.id === "string" && CHAT_ID_RE.test(meta.id)) known.set(meta.id, normalizeMeta(meta));
            }
        }
        this.#index = new Map(known);

        // Reconcile with the folders: picks up a chat whose index write was lost
        // to a crash, drops one whose folder was removed by hand, and rebuilds
        // the whole index when index.json was missing or corrupt.
        const found = await this.#scanFolders(known);
        const before = JSON.stringify([...known.values()]);
        this.#index = found;

        if (!saved || before !== JSON.stringify([...found.values()])) {
            // The cache is best effort: failing to refresh it (read-only disk,
            // a file locked by an antivirus scan) must not hide the chats that
            // were just read from the folders. The next write retries.
            await this.#updateIndex(() => {}).catch((error) => {
                console.warn("[Chats] index.json could not be refreshed:", error?.message || error);
            });
        }
    }

    /**
     * One entry per chat folder. A folder that cannot be read right now must
     * never take the whole history down with it: it keeps its entry from the
     * previous index (or is skipped), and every other chat still loads.
     *
     * @param {Map<string, object>} known entries from the saved index
     */
    async #scanFolders(known = new Map()) {
        const found = new Map();
        const entries = await fs.readdir(this.#root, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory() || !CHAT_ID_RE.test(entry.name)) continue;

            try {
                const meta = await this.#recoverMeta(entry.name);
                if (meta) found.set(meta.id, meta);
            } catch (error) {
                console.warn(`[Chats] could not read chat ${entry.name}:`, error?.message || error);
                if (known.has(entry.name)) found.set(entry.name, known.get(entry.name));
            }
        }
        return found;
    }

    /**
     * The usable meta for one chat folder, or null when the folder is not a chat.
     *
     * meta.json is trusted when it is healthy and says the chat has messages.
     * Otherwise messages.jsonl is consulted, because messages are appended
     * BEFORE meta.json is rewritten: closing the app between the two leaves a
     * meta that still says "0 messages", and list() hides empty chats, so a
     * chat with a real conversation in it would silently vanish.
     */
    async #recoverMeta(id) {
        const existing = await readJson(this.#metaFile(id));
        const healthy = Boolean(existing) && typeof existing === "object" && existing.id === id;
        if (healthy && Number(existing.messageCount) > 0) return normalizeMeta(existing);

        let raw;
        try {
            raw = await fs.readFile(this.#messagesFile(id), "utf8");
        } catch (error) {
            if (isMissing(error)) return healthy ? normalizeMeta(existing) : null;
            throw error;
        }

        const messages = parseMessages(raw);
        if (healthy && messages.length === 0) return normalizeMeta(existing);

        const stat = await fs.stat(this.#messagesFile(id));
        const meta = healthy ? normalizeMeta(existing) : this.#newMeta(id);
        const firstUser = messages.find((m) => m.role === "user");

        meta.messageCount = messages.length;
        meta.fileCount = messages.reduce((sum, m) => sum + (m.files?.length || 0), 0);
        if (!healthy) meta.createdAt = messages[0]?.createdAt || stat.birthtimeMs || Date.now();
        meta.updatedAt = Math.max(
            healthy ? meta.updatedAt : 0,
            messages.at(-1)?.createdAt || stat.mtimeMs || Date.now()
        );

        // Never overwrite a title somebody chose; only fill in an automatic one.
        if (firstUser && (!healthy || meta.titleSource === "default")) {
            meta.title = fallbackTitle({ text: firstUser.text, files: firstUser.files });
            meta.titleSource = "fallback";
        }

        await writeAtomic(this.#metaFile(id), JSON.stringify(meta));
        return meta;
    }

    /* ---------------- public API ---------------- */

    /** Chats that have at least one message, newest activity first. */
    async list() {
        await this.init();
        return [...this.#index.values()]
            .filter((meta) => meta.messageCount > 0)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((meta) => ({ ...meta }));
    }

    /**
     * Create a chat. Idempotent. A chat with no messages exists on disk (so
     * attachments can be saved) but is not listed.
     */
    async create({ id, title } = {}) {
        assertChatId(id);
        await this.init();

        return this.#serial(id, async () => {
            try {
                return { ...(await this.#readMeta(id)) };
            } catch (error) {
                if (error.code !== "notFound") throw error;
            }

            await fs.mkdir(path.join(this.#dir(id), "files"), { recursive: true });
            return this.#writeMeta(this.#newMeta(id, title));
        });
    }

    /** @returns {Promise<{ meta: object, messages: object[] }>} */
    async get(id) {
        assertChatId(id);
        await this.init();

        const meta = await this.#readMeta(id);
        let raw = "";
        try {
            raw = await fs.readFile(this.#messagesFile(id), "utf8");
        } catch (error) {
            if (!isMissing(error)) throw error;
        }

        return { meta: { ...meta }, messages: parseMessages(raw) };
    }

    /**
     * Append messages in order. The first user message of a chat also gives it
     * an immediate title (cut from the message), before any model is involved.
     *
     * @param {string} id
     * @param {object[]} messages
     * @param {{ ragIndexed?: boolean }} [options]
     */
    async appendMessages(id, messages, { ragIndexed } = {}) {
        assertChatId(id);
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new ChatStoreError("badRequest", "messages must be a non-empty array");
        }
        if (messages.length > CHAT_LIMITS.maxMessagesPerAppend) {
            throw new ChatStoreError("badRequest", `at most ${CHAT_LIMITS.maxMessagesPerAppend} messages per request`);
        }
        const records = messages.map(normalizeRecord); // validate everything before any write

        await this.init();

        return this.#serial(id, async () => {
            const meta = await this.#readMeta(id);

            const lines = records.map((record) => `\n${JSON.stringify(record)}`).join("");
            await fs.appendFile(this.#messagesFile(id), lines);

            if (meta.titleSource === "default") {
                const first = records.find((record) => record.role === "user");
                if (first) {
                    meta.title = fallbackTitle({ text: first.text, files: first.files });
                    meta.titleSource = "fallback";
                }
            }

            meta.messageCount = (meta.messageCount || 0) + records.length;
            meta.fileCount = (meta.fileCount || 0) + records.reduce((sum, r) => sum + (r.files?.length || 0), 0);
            meta.updatedAt = Math.max(meta.updatedAt || 0, ...records.map((r) => r.createdAt), Date.now());
            if (ragIndexed === true) meta.ragIndexed = true; // sticky

            return this.#writeMeta(meta);
        });
    }

    /** Rename by the user. Wins over any later automatic title. */
    async rename(id, title) {
        assertChatId(id);
        const clean = cleanTitle(title, { maxChars: CHAT_LIMITS.maxUserTitleChars });
        if (!clean) throw new ChatStoreError("badRequest", "the title is empty");

        await this.init();
        return this.#serial(id, async () => {
            const meta = await this.#readMeta(id);
            meta.title = clean;
            meta.titleSource = "user";
            // updatedAt is left alone: renaming must not reorder the sidebar.
            return this.#writeMeta(meta);
        });
    }

    /**
     * Apply an AI-written title, but only while the title is still automatic.
     * @returns {Promise<{ meta: object, applied: boolean }>}
     */
    async setAutoTitle(id, title) {
        assertChatId(id);
        await this.init();

        return this.#serial(id, async () => {
            const meta = await this.#readMeta(id);
            const clean = cleanTitle(title);

            const stillAutomatic = meta.titleSource === "default" || meta.titleSource === "fallback";
            if (!stillAutomatic || !isUsableTitle(clean)) return { meta: { ...meta }, applied: false };

            meta.title = clean;
            meta.titleSource = "ai";
            return { meta: await this.#writeMeta(meta), applied: true };
        });
    }

    /** Bookkeeping flags. Today only `ragIndexed`, which can be set but never cleared. */
    async patchMeta(id, patch = {}) {
        assertChatId(id);
        await this.init();

        return this.#serial(id, async () => {
            const meta = await this.#readMeta(id);
            // Bookkeeping only: updatedAt is left alone so this never reorders the sidebar.
            if (patch.ragIndexed === true) meta.ragIndexed = true;
            return this.#writeMeta(meta);
        });
    }

    /** Delete a chat: its folder, its files and its list entry. @returns {Promise<boolean>} whether it existed */
    async delete(id) {
        assertChatId(id);
        await this.init();

        return this.#serial(id, async () => {
            const dir = this.#dir(id);
            let existed = true;
            try {
                await fs.access(dir);
            } catch {
                existed = false;
            }

            if (existed) await fs.rm(dir, { recursive: true, force: true });
            if (this.#index.has(id)) await this.#updateIndex((index) => index.delete(id));
            return existed;
        });
    }

    /**
     * Keep an attachment.
     * @returns {Promise<{ id: string, name: string, type: string, size: number }>}
     */
    async saveFile(id, { name, type, bytes } = {}) {
        assertChatId(id);
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
            throw new ChatStoreError("badRequest", "the file is empty");
        }
        if (bytes.length > CHAT_LIMITS.maxFileBytes) {
            throw new ChatStoreError("tooLarge", "the file is too large to keep");
        }

        await this.init();
        return this.#serial(id, async () => {
            await this.#readMeta(id); // notFound for an unknown chat

            const info = {
                id: `f-${crypto.randomBytes(8).toString("hex")}`,
                name: safeName(name),
                type: typeof type === "string" && MIME_RE.test(type) ? type : "application/octet-stream",
                size: bytes.length,
            };

            const paths = this.#filePaths(id, info.id);
            await fs.mkdir(path.dirname(paths.bin), { recursive: true });
            await writeAtomic(paths.bin, bytes);
            await writeAtomic(paths.info, JSON.stringify(info));
            return info;
        });
    }

    /** @returns {Promise<{ bytes: Buffer, info: { id: string, name: string, type: string, size: number } }>} */
    async readFile(id, fileId) {
        assertChatId(id);
        await this.init();
        await this.#readMeta(id); // an unknown chat is notFound, whatever the file id looks like

        if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) {
            throw new ChatStoreError("badId", "invalid file id");
        }

        const paths = this.#filePaths(id, fileId);
        try {
            const info = JSON.parse(await fs.readFile(paths.info, "utf8"));
            const bytes = await fs.readFile(paths.bin);
            return { bytes, info };
        } catch (error) {
            if (isMissing(error) || error instanceof SyntaxError) {
                throw new ChatStoreError("notFound", "file not found");
            }
            throw error;
        }
    }
}
