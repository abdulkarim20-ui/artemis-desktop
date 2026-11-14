/**
 * Regression tests for "the chat history is missing from the sidebar when the
 * app starts". Each test is one way the list used to come up empty or hidden.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChatStore } from "../ai-agent/chats/chat-store.js";
import { normalizeChatEntry, normalizeChatList } from "../renderer/js/core/history-groups.js";
import {
    SIDEBAR_STATE_KEY,
    readSidebarExpanded,
    saveSidebarExpanded,
} from "../renderer/js/core/sidebar-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const A = "chat-aaaaaa-111111";
const B = "chat-bbbbbb-222222";

async function withRoot(fn) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "artemis-history-"));
    try {
        await fn(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function seed(root, ids) {
    const store = new ChatStore({ root });
    for (const id of ids) {
        await store.create({ id });
        await store.appendMessages(id, [{ role: "user", text: `hello from ${id}`, content: `hello from ${id}` }]);
    }
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

test("a chat whose meta lost its message count is still listed (closed between append and meta write)", async () => {
    await withRoot(async (root) => {
        await seed(root, [A, B]);

        // Messages are appended before meta.json is rewritten. Closing the app
        // in between leaves "0 messages" next to a real conversation.
        const metaFile = path.join(root, A, "meta.json");
        const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
        meta.messageCount = 0;
        await fs.writeFile(metaFile, JSON.stringify(meta));
        await fs.rm(path.join(root, "index.json"));

        const listed = await new ChatStore({ root }).list();
        assert.deepEqual(listed.map((c) => c.id).sort(), [A, B]);
        assert.equal(listed.find((c) => c.id === A).messageCount, 1, "the count is repaired");
    });
});

test("a repaired chat keeps the title the user chose", async () => {
    await withRoot(async (root) => {
        await seed(root, [A]);
        const store = new ChatStore({ root });
        await store.rename(A, "My own title");

        const metaFile = path.join(root, A, "meta.json");
        const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
        meta.messageCount = 0;
        await fs.writeFile(metaFile, JSON.stringify(meta));
        await fs.rm(path.join(root, "index.json"));

        const [chat] = await new ChatStore({ root }).list();
        assert.equal(chat.title, "My own title");
        assert.equal(chat.titleSource, "user");
    });
});

test("one unreadable chat folder does not take the whole history down", async () => {
    await withRoot(async (root) => {
        await seed(root, [A, B]);
        await fs.rm(path.join(root, "index.json"));

        // A directory where meta.json should be: readFile fails with EISDIR,
        // which is neither "missing" nor "corrupt JSON".
        await fs.rm(path.join(root, B, "meta.json"));
        await fs.mkdir(path.join(root, B, "meta.json"));

        const listed = await new ChatStore({ root }).list();
        assert.deepEqual(listed.map((c) => c.id), [A], "the healthy chat is still there");
    });
});

test("an unreadable chat keeps its entry from the previous index", async () => {
    await withRoot(async (root) => {
        await seed(root, [A, B]);

        await fs.rm(path.join(root, B, "meta.json"));
        await fs.mkdir(path.join(root, B, "meta.json"));

        const listed = await new ChatStore({ root }).list();
        assert.deepEqual(listed.map((c) => c.id).sort(), [A, B], "a transient read error must not drop a chat");
    });
});

test("an index.json that cannot be read or rewritten does not hide the chats", async () => {
    await withRoot(async (root) => {
        await seed(root, [A, B]);
        await fs.rm(path.join(root, "index.json"));
        await fs.mkdir(path.join(root, "index.json")); // EISDIR on read, and on rewrite

        const listed = await new ChatStore({ root }).list();
        assert.deepEqual(listed.map((c) => c.id).sort(), [A, B]);
    });
});

test("a meta with a missing or wrongly typed title and time cannot break the list", async () => {
    await withRoot(async (root) => {
        await seed(root, [A]);
        const metaFile = path.join(root, A, "meta.json");
        const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
        meta.title = null;
        meta.updatedAt = "yesterday";
        await fs.writeFile(metaFile, JSON.stringify(meta));
        await fs.rm(path.join(root, "index.json"));

        const [chat] = await new ChatStore({ root }).list();
        assert.equal(typeof chat.title, "string");
        assert.ok(chat.title.length > 0);
        assert.ok(Number.isFinite(chat.updatedAt));
    });
});

/* ------------------------------------------------------------------ */
/* the sidebar                                                         */
/* ------------------------------------------------------------------ */

const makeStore = (initial = {}) => {
    const data = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
        set: (key, value) => data.set(key, value),
        data,
    };
};

test("a first launch shows the sidebar, and so the history", () => {
    assert.equal(readSidebarExpanded(makeStore(), true), true);
});

test("the old key (a default that was saved as if it were a choice) is ignored", () => {
    // Earlier builds defaulted to collapsed and wrote that to 'sidebarExpanded'
    // on every launch. Honouring it hides the history forever.
    const store = makeStore({ sidebarExpanded: false });
    assert.equal(readSidebarExpanded(store, true), true);
});

test("an explicit choice is remembered, and only a choice is saved", () => {
    const store = makeStore();
    assert.equal(readSidebarExpanded(store, true), true);
    assert.equal(store.data.size, 0, "reading must not write the default back");

    saveSidebarExpanded(store, false);
    assert.equal(store.data.get(SIDEBAR_STATE_KEY), false);
    assert.equal(readSidebarExpanded(store, true), false);
});

test("a stored value of the wrong type falls back to the default", () => {
    assert.equal(readSidebarExpanded(makeStore({ [SIDEBAR_STATE_KEY]: "no" }), true), true);
});

test("sidebar.js saves the state only in the toggle handler", async () => {
    const source = await fs.readFile(path.join(here, "../renderer/js/components/sidebar.js"), "utf8");
    assert.ok(!/storage\.set\('sidebarExpanded'/.test(source), "the default is written to storage at startup again");
    assert.match(source, /bus\.on\('sidebar:toggle'[\s\S]{0,200}saveSidebarExpanded\(storage, next\)/);
});

/* ------------------------------------------------------------------ */
/* the list                                                            */
/* ------------------------------------------------------------------ */

test("normalizeChatEntry drops what cannot be shown and repairs what can", () => {
    assert.equal(normalizeChatEntry(null), null);
    assert.equal(normalizeChatEntry({ title: "no id" }), null);
    assert.equal(normalizeChatEntry({ id: 5 }), null);

    const fixed = normalizeChatEntry({ id: "chat-x", title: 42, updatedAt: "soon" });
    assert.equal(fixed.title, "New chat");
    assert.equal(fixed.updatedAt, 0);

    const kept = normalizeChatEntry({ id: "chat-x", title: "Hello", updatedAt: 1700000000000 });
    assert.equal(kept.title, "Hello");
    assert.equal(kept.updatedAt, 1700000000000);
});

test("normalizeChatList survives a malformed response", () => {
    assert.deepEqual(normalizeChatList(undefined), []);
    assert.deepEqual(normalizeChatList({}), []);
    assert.deepEqual(normalizeChatList([null, { id: "a", title: "A", updatedAt: 1 }, "x"]).map((c) => c.id), ["a"]);
});

test("the history list keeps what it has while refreshing, ignores stale loads and refreshes on focus", async () => {
    const source = await fs.readFile(path.join(here, "../renderer/js/components/history-list.js"), "utf8");

    assert.match(source, /const seq = \+\+loadSeq;/, "loads are not sequenced: a slow old response can overwrite a new one");
    assert.match(source, /if \(seq !== loadSeq \|\| disposed\) return;/);
    assert.match(source, /if \(status !== 'ready'\) \{\s*status = 'loading';/, "a refresh blanks a list that is already showing");
    assert.match(source, /window\.addEventListener\('focus', onWake\)/, "no refresh when the window comes back");
    assert.match(source, /window\.removeEventListener\('focus', onWake\)/, "the focus listener leaks past unmount");
    assert.match(source, /refreshTimer = setInterval\(/, "no periodic quiet refresh while the window sits open");
    assert.match(source, /clearInterval\(refreshTimer\)/, "the refresh interval leaks past unmount");
    assert.match(source, /bus\.on\('history:refresh', \(\) => load\(\)\)/);
});

test("the history list keeps retrying while the agent is starting", async () => {
    const source = await fs.readFile(path.join(here, "../renderer/js/components/history-list.js"), "utf8");

    assert.match(source, /if \(starting\) return '<p class="history-note">Starting the assistant…<\/p>'/);
    assert.match(source, /const up = await waitForBackend\(\{ attempts: 20 \}\);[\s\S]{0,220}notUp\.code = 'network'/);
    assert.match(source, /const delay = Math\.min\(1500 \* retryAttempts, 5000\);/);
    assert.doesNotMatch(source, /retryAttempts > 10/);
    assert.match(source, /const sortChats = \(list = chats\) => list\.sort/);
});

test("rename mode hides history tools and gives the input the full row", async () => {
    const source = await fs.readFile(path.join(here, "../renderer/js/components/history-list.js"), "utf8");
    const css = await fs.readFile(path.join(here, "../renderer/styles/history.css"), "utf8");

    assert.match(source, /resetDeleteConfirm\(\);\s*row\.classList\.add\('is-renaming'\);/);
    assert.match(source, /row\.classList\.remove\('is-renaming'\);/);
    assert.match(css, /\.history-row\.is-renaming \.history-tools \{\s*display: none;/);
    assert.match(css, /\.history-rename \{[^}]*width: 100%;/s);
});
