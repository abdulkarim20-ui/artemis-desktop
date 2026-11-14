/**
 * Regression tests for the one-time import of chats that were saved under one
 * of the other known data folders (standalone agent runs, dev runs before the
 * data folder was pinned). Copy, never move; never overwrite; one-time per
 * source folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ChatStore } from "../ai-agent/chats/chat-store.js";
import { standaloneChatsRoot } from "../ai-agent/chats/chat-paths.js";
import { knownChatFolders, importForeignChats } from "../ai-agent/chats/chat-import.js";

const A = "chat-aaaaaa-111111";
const B = "chat-bbbbbb-222222";

async function withRoot(fn) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "artemis-import-"));
    try {
        await fn(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function seed(root, ids, { title } = {}) {
    const store = new ChatStore({ root });
    for (const id of ids) {
        await store.create({ id, title });
        await store.appendMessages(id, [{ role: "user", text: `hello from ${id}`, content: `hello from ${id}` }]);
    }
    return store;
}

const importFrom = async (root, sourceRoot) => {
    const logs = [];
    const summary = await importForeignChats({
        root,
        sources: [{ path: sourceRoot, label: "a test source" }],
        log: (...args) => logs.push(args.join(" ")),
    });
    return { summary, logs };
};

const fileExists = async (file) => {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
};

test("chats saved by a standalone run are copied in and listed", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A, B]);

            const { summary, logs } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 2);
            assert.equal(summary.scanned[0].status, "imported");
            assert.equal(summary.scanned[0].found, 2);
            assert.match(logs.join("\n"), /copied 2 chats from/);

            const listed = await new ChatStore({ root: targetRoot }).list();
            assert.deepEqual(listed.map((chat) => chat.id).sort(), [A, B], "the imported chats are listed");

            // Copy, never move: the source folder keeps every chat.
            const stillThere = await new ChatStore({ root: sourceRoot }).list();
            assert.deepEqual(stillThere.map((chat) => chat.id).sort(), [A, B]);
        });
    });
});

test("a chat that already exists in the target is never overwritten", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(targetRoot, [A], { title: "kept title" });
            await seed(sourceRoot, [A]); // same id, different history

            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 0);
            assert.equal(summary.scanned[0].skipped, 1);

            const { meta, messages } = await new ChatStore({ root: targetRoot }).get(A);
            assert.equal(meta.title, "kept title", "the live copy wins");
            assert.equal(meta.titleSource, "user");
            assert.equal(meta.messageCount, 1);
            assert.equal(messages[0].content, "hello from " + A, "the live history wins");
        });
    });
});

test("the import is one-time per chat, so deleted chats stay deleted", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A]);
            await importFrom(targetRoot, sourceRoot);

            // The user deletes the chat in the app (its folder is gone; the
            // saved index still lists it, as on a real next launch).
            await fs.rm(path.join(targetRoot, A), { recursive: true, force: true });

            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 0, "the chat is not offered again");
            assert.equal(summary.scanned[0].skipped, 1, "the id is remembered");

            const listed = await new ChatStore({ root: targetRoot }).list();
            assert.deepEqual(listed.map((chat) => chat.id), [], "a deleted chat is not resurrected");
        });
    });
});

test("a chat created in the source after the first import is picked up later", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A]);
            await importFrom(targetRoot, sourceRoot);

            // The user keeps using the standalone agent, which writes a new chat.
            await seed(sourceRoot, [B]);
            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 1, "the new chat is imported");
            assert.equal(summary.scanned[0].skipped, 1, "the old one is not offered twice");

            const listed = await new ChatStore({ root: targetRoot }).list();
            assert.deepEqual(listed.map((chat) => chat.id).sort(), [A, B]);
        });
    });
});

test("a source that does not exist yet is picked up when it appears", async () => {
    await withRoot(async (base) => {
        const targetRoot = path.join(base, "target");
        const later = path.join(base, "standalone-run", "chats"); // does not exist yet

        const first = await importForeignChats({
            root: targetRoot,
            sources: [{ path: later, label: "not there yet" }],
            log: () => {},
        });
        assert.equal(first.copied, 0);
        assert.equal(first.scanned[0].status, "missing");
        assert.equal(await fileExists(path.join(targetRoot, "imported.json")), false,
            "a missing source must not be written down");

        await seed(later, [A]);

        const second = await importForeignChats({
            root: targetRoot,
            sources: [{ path: later, label: "there now" }],
            log: () => {},
        });
        assert.equal(second.copied, 1);
        const listed = await new ChatStore({ root: targetRoot }).list();
        assert.deepEqual(listed.map((chat) => chat.id), [A]);
    });
});

test("attachments come along with the chat", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            const source = await seed(sourceRoot, [A]);
            const saved = await source.saveFile(A, { name: "hello.txt", type: "text/plain", bytes: Buffer.from("hello") });

            await importFrom(targetRoot, sourceRoot);

            const { bytes, info } = await new ChatStore({ root: targetRoot }).readFile(A, saved.id);
            assert.equal(bytes.toString(), "hello");
            assert.equal(info.name, "hello.txt");
        });
    });
});

test("folders that are not chats and loose files in the source are ignored", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A]);
            await fs.mkdir(path.join(sourceRoot, "not a chat id!"));
            await fs.mkdir(path.join(sourceRoot, "-leading-dash")); // chat ids cannot start with "-"
            await fs.writeFile(path.join(sourceRoot, "notes.txt"), "loose file");
            await fs.writeFile(path.join(sourceRoot, B), "a file named like a chat");

            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 1);
            assert.equal(summary.scanned[0].found, 1);

            const listed = await new ChatStore({ root: targetRoot }).list();
            assert.deepEqual(listed.map((chat) => chat.id), [A]);
        });
    });
});

test("an empty chat from the old folder is copied but not listed", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            const store = new ChatStore({ root: sourceRoot });
            await store.create({ id: A }); // created, never written to

            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 1);

            const target = new ChatStore({ root: targetRoot });
            assert.deepEqual((await target.list()).map((chat) => chat.id), [], "empty chats stay hidden");
            await target.get(A); // ...but it is there on disk
        });
    });
});

test("a corrupt import marker does not stop the import", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A]);
            await fs.writeFile(path.join(targetRoot, "imported.json"), "not json at all {{{");

            const { summary } = await importFrom(targetRoot, sourceRoot);
            assert.equal(summary.copied, 1);

            const marker = JSON.parse(await fs.readFile(path.join(targetRoot, "imported.json"), "utf8"));
            assert.equal(marker.version, 2, "the marker is valid JSON again");
        });
    });
});

test("the marker records the chat ids a source has offered", async () => {
    await withRoot(async (sourceRoot) => {
        await withRoot(async (targetRoot) => {
            await seed(sourceRoot, [A]);
            await importFrom(targetRoot, sourceRoot);

            const marker = JSON.parse(await fs.readFile(path.join(targetRoot, "imported.json"), "utf8"));
            const record = marker.sources[path.resolve(sourceRoot)];
            assert.ok(record, "the source is written down by its absolute path");
            assert.deepEqual(record.seen, [A], "the chat id is remembered");
            assert.ok(Number.isFinite(record.at));
        });
    });
});

/* ------------------------------------------------------------------ */
/* the known folders                                                   */
/* ------------------------------------------------------------------ */

test("knownChatFolders lists the other known folders and never the one being read", () => {
    const env = { APPDATA: "C:\\Users\\me\\AppData\\Roaming", XDG_CONFIG_HOME: "/fake/xdg" };
    const home = "/fake/home";

    const windows = knownChatFolders({ env, platform: "win32", home });
    const windowsPaths = windows.map((source) => source.path);
    assert.ok(windowsPaths.includes(path.join(env.APPDATA, "Electron", "chats")), "dev runs before the pin");
    assert.ok(windowsPaths.includes(path.join(env.APPDATA, "Artemis", "chats")), "the app's own folder");
    assert.ok(windowsPaths.includes(standaloneChatsRoot()), "standalone agent runs");
    assert.ok(windows.every((source) => source.label.length > 0), "every folder says what it is");

    // The folder being read is not one of the sources - not even by a case
    // variant of its name on Windows, where folder names are case-insensitive.
    const appChats = path.join(env.APPDATA, "Artemis", "chats");
    const variant = path.join(env.APPDATA, "Artemis", "CHATS");
    const fromVariant = knownChatFolders({ root: variant, env, platform: "win32", home }).map((source) => source.path);
    assert.ok(!fromVariant.includes(appChats), "the current folder is excluded (case-insensitive on Windows)");
    assert.ok(fromVariant.includes(path.join(env.APPDATA, "Electron", "chats")), "the other folders remain");
    assert.ok(fromVariant.includes(standaloneChatsRoot()), "the other folders remain");
    assert.ok(!knownChatFolders({ root: standaloneChatsRoot(), env, platform: "win32", home })
        .some((source) => source.path === standaloneChatsRoot()));

    // Linux folder names are case-sensitive, so the same comparison keeps it,
    // and the appData root there comes from XDG_CONFIG_HOME, not APPDATA.
    const linuxAppChats = path.join(env.XDG_CONFIG_HOME, "Artemis", "chats");
    const linux = knownChatFolders({ root: path.join(env.XDG_CONFIG_HOME, "Artemis", "CHATS"), env, platform: "linux", home });
    assert.ok(linux.some((source) => source.path === linuxAppChats), "CHATS is a different folder on Linux");
    assert.ok(linux.some((source) => source.path === standaloneChatsRoot()), "the standalone folder is still offered");
});
