/**
 * ============================================================================
 * CHAT IMPORT (chats/chat-import.js)
 * ============================================================================
 * Chat history is only ever read from ONE folder - resolveChatsRoot(). But
 * chats also exist in other known folders on the same machine:
 *
 *   <appData>/Electron/chats    dev runs before the app pinned its data folder
 *                               (`electron main/main.js` fell back to the name
 *                               "Electron", so history landed there)
 *   <appData>/Artemis/chats     the app's own folder (relevant when the agent
 *                               is run standalone)
 *   ai-agent/.data/chats        standalone agent runs (npm run agent at the root)
 *
 * The sidebar then says "Your conversations will appear here." even though
 * every chat is still on disk - it is just in the folder that is not being
 * read. importForeignChats() runs once at agent startup and copies those chats
 * into the folder that IS being read.
 *
 * Rules, each covered by a test:
 *
 *   - COPY, never move: the source folders are left exactly as they were.
 *   - Never overwrite: a chat id that already exists in the target is skipped,
 *     whatever is in the source. The target's copy is the live one.
 *   - One-time PER CHAT: every chat id a source ever offered is written down
 *     in <root>/imported.json and never offered again - so a chat the user
 *     deleted in the app is not resurrected on the next launch. A chat that
 *     shows up in the source LATER was never seen before, so it is imported
 *     on the launch after that.
 *   - A copy that fails halfway is removed, and its id is not written down,
 *     so the next launch simply tries it again.
 *   - Nothing here is allowed to take the chat history down: every failure is
 *     caught, logged and skipped.
 * ============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { CHAT_ID_RE, standaloneChatsRoot } from "./chat-paths.js";

const MARKER_VERSION = 2;
const MARKER_FILE = "imported.json";

const isMissing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

/**
 * Electron's app.getPath('appData'), reconstructed without Electron: the agent
 * process is plain Node (ELECTRON_RUN_AS_NODE) and cannot ask the app module.
 */
function appDataRoot({ env, platform, home }) {
    switch (platform) {
        case "win32": return env.APPDATA || path.join(home, "AppData", "Roaming");
        case "darwin": return path.join(home, "Library", "Application Support");
        default: return env.XDG_CONFIG_HOME || path.join(home, ".config");
    }
}

/** Case-tolerant path equality: Windows and macOS folders differ by case. */
function samePath(a, b, platform) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return platform === "win32" || platform === "darwin"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

/**
 * The other folders an older chat history may be sitting in, current root
 * excluded. Pure in everything it reads, so tests can inject the environment.
 *
 * @param {object} [options]
 * @param {string} [options.root] the folder that is being read now
 * @param {object} [options.env] process.env
 * @param {string} [options.platform] process.platform
 * @param {string} [options.home] os.homedir()
 * @returns {Array<{ path: string, label: string }>}
 */
export function knownChatFolders({ root, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
    const appData = appDataRoot({ env, platform, home });

    const candidates = [
        {
            path: path.join(appData, "Electron", "chats"),
            label: "an older development run (Electron's default data folder)",
        },
        {
            path: path.join(appData, "Artemis", "chats"),
            label: "the Artemis app's data folder",
        },
        {
            path: standaloneChatsRoot(),
            label: "standalone agent runs (ai-agent/.data/chats)",
        },
    ];

    const isOther = (candidate) =>
        !root || !samePath(candidate.path, root, platform);

    return candidates
        .filter(isOther)
        // The same place could be reached twice through different names.
        .filter((candidate, index, list) =>
            list.findIndex((other) => samePath(other.path, candidate.path, platform)) === index);
}

/* ------------------------------------------------------------------ */
/* the marker                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which chat ids each source folder has already offered to this root, keyed by
 * absolute source path, so the same file works whichever folder is the target.
 *
 *   { "version": 2, "sources": { "C:\\...\\chats": { "at": 0, "seen": ["chat-..."] } } }
 *
 * The file name cannot collide with a chat folder: chat ids never contain a
 * dot, and the store only ever looks at directories that match its id pattern.
 * Records without a `seen` array (an older format) count as never imported.
 */
async function readMarker(root) {
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(root, MARKER_FILE), "utf8"));
        if (parsed && typeof parsed === "object" && parsed.sources && typeof parsed.sources === "object") {
            const sources = {};
            for (const [source, record] of Object.entries(parsed.sources)) {
                if (record && Array.isArray(record.seen)) {
                    sources[source] = { at: Number(record.at) || 0, seen: record.seen.filter((id) => typeof id === "string") };
                }
            }
            return { version: MARKER_VERSION, sources };
        }
    } catch (error) {
        if (!isMissing(error) && !(error instanceof SyntaxError)) {
            console.warn("[Chats] import marker could not be read:", error?.message || error);
        }
    }
    return { version: MARKER_VERSION, sources: {} };
}

/** Write to a temp file, then rename over the target: readers never see half a file. */
async function writeMarker(root, marker) {
    const file = path.join(root, MARKER_FILE);
    const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(temp, JSON.stringify(marker, null, 2));

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

/* ------------------------------------------------------------------ */
/* the import                                                          */
/* ------------------------------------------------------------------ */

const exists = async (file) => {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
};

/**
 * Copy one chat folder. A copy that fails halfway is removed again: a
 * half-written chat in the target would otherwise exist forever and block its
 * own re-import on the next launch.
 */
async function copyChat(from, to) {
    try {
        await fs.cp(from, to, { recursive: true });
        return true;
    } catch (error) {
        console.warn(`[Chats] import: could not copy chat from ${from}:`, error?.message || error);
        await fs.rm(to, { recursive: true, force: true }).catch(() => {});
        return false;
    }
}

/**
 * One-time import of chats from the other known data folders into `root`.
 *
 * @param {object} [options]
 * @param {string} options.root the folder that is being read now
 * @param {Array<{ path: string, label: string }>} [options.sources]
 *   defaults to knownChatFolders({ root })
 * @param {(...args: unknown[]) => void} [options.log]
 * @returns {Promise<{ copied: number, scanned: Array<object> }>} what was
 *   checked and copied, for tests and for the startup log
 */
export async function importForeignChats({ root, sources = knownChatFolders({ root }), log = console.log } = {}) {
    if (!root) throw new Error("importForeignChats needs a target root folder");

    const summary = { copied: 0, scanned: [] };
    if (!Array.isArray(sources) || sources.length === 0) return summary;

    const target = path.resolve(root);
    await fs.mkdir(target, { recursive: true });

    const marker = await readMarker(target);
    let markerDirty = false;

    for (const source of sources) {
        const sourcePath = path.resolve(source.path);
        const record = marker.sources[sourcePath];
        const seen = new Set(record ? record.seen : []);
        const scanned = (status, found = 0, copied = 0, skipped = 0) =>
            summary.scanned.push({ source: sourcePath, label: source.label, status, found, copied, skipped });

        let entries;
        try {
            entries = await fs.readdir(sourcePath, { withFileTypes: true });
        } catch (error) {
            if (isMissing(error)) {
                // Not written down: if this folder shows up later it gets imported then.
                scanned("missing");
                continue;
            }
            console.warn(`[Chats] import: could not read ${sourcePath}:`, error?.message || error);
            scanned("error");
            continue;
        }

        const chatDirs = entries.filter((entry) => entry.isDirectory() && CHAT_ID_RE.test(entry.name));

        let copied = 0;
        let skipped = 0;
        let learned = false; // a chat id this source offered for the first time
        for (const entry of chatDirs) {
            const from = path.join(sourcePath, entry.name);
            const to = path.join(target, entry.name);

            if (seen.has(entry.name)) { skipped += 1; continue; } // offered before: deletions stay deleted

            if (await exists(to)) {
                // The target already has its own copy: it is the live one. Write
                // the id down now, so deleting the chat in the app is final.
                seen.add(entry.name);
                learned = true;
                skipped += 1;
                continue;
            }

            if (await copyChat(from, to)) {
                seen.add(entry.name); // only a successful copy is remembered
                learned = true;
                copied += 1;
            }
        }

        if (learned) {
            marker.sources[sourcePath] = { at: Date.now(), seen: [...seen] };
            markerDirty = true;
        }
        summary.copied += copied;
        scanned("imported", chatDirs.length, copied, skipped);

        if (copied > 0) {
            const noun = copied === 1 ? "chat" : "chats";
            log(`[Chats] import: copied ${copied} ${noun} from ${sourcePath} (${source.label})`);
        }
    }

    if (markerDirty) {
        // Failing to write the marker only means the scan repeats next launch,
        // which copies nothing new - but deletions could come back, so say so.
        await writeMarker(target, marker).catch((error) => {
            console.warn("[Chats] import: the one-time marker could not be written:", error?.message || error);
        });
    }

    return summary;
}
