/**
 * ============================================================================
 * CHAT HISTORY, RENDERER SIDE TESTS
 * ============================================================================
 * The modules under test touch no DOM: ChatSession (saving one conversation),
 * initChatNav (what New Chat / open / delete mean) and groupChats (sidebar
 * date groups). A fake history client stands in for the agent.
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChatSession } from "../renderer/js/core/chat-session.js";
import { initChatNav } from "../renderer/js/core/chat-nav.js";
import { renderSavedChat } from "../renderer/js/core/chat-restore.js";
import { groupChats } from "../renderer/js/core/history-groups.js";
import { makeChatId } from "../renderer/js/ai/history-client.js";
import { CHAT_ID_RE } from "../ai-agent/chats/chat-paths.js";

/** A tiny bus so tests do not share listeners. */
function makeBus() {
  const handlers = new Map();
  const seen = [];
  return {
    seen,
    emit(name, detail) {
      seen.push([name, detail]);
      for (const fn of [...(handlers.get(name) || [])]) fn(detail);
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
  };
}

function makeClient({ failAppendOn = null, failUpload = false, title = "Cheese Fondue Recipe" } = {}) {
  const calls = [];
  let appends = 0;
  return {
    calls,
    async createChat(id) { calls.push(["create", id]); return { id }; },
    async uploadChatFile(id, file) {
      calls.push(["upload", file.name]);
      if (failUpload) throw new Error("disk full");
      return { id: "f-0123456789abcdef", name: file.name };
    },
    async appendMessages(id, { messages, ragIndexed }) {
      appends += 1;
      calls.push(["append", messages[0].role, ragIndexed]);
      if (failAppendOn === appends) throw new Error("agent down");
      return { id, title: "t", messageCount: appends };
    },
    async requestTitle(id, body) {
      calls.push(["title", body.query]);
      return { applied: true, title, chat: { id, title } };
    },
    async updateChat(id, patch) { calls.push(["update", patch]); return { id }; },
    async getChat(id) { calls.push(["get", id]); return { meta: { id, ragIndexed: true }, messages: [] }; },
  };
}

const file = (name, size = 10, type = "text/plain") => ({ name, size, type });

/* ------------------------------------------------------------------ */

test("makeChatId produces ids the agent accepts, and they are unique", () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeChatId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(CHAT_ID_RE.test(id), id);
});

test("a new chat is created once, on the first message, and the title is requested once", async () => {
  const client = makeClient();
  const bus = makeBus();
  const session = new ChatSession({ client, bus });

  assert.equal(session.started, false);
  session.recordUser({ text: "fondue?", content: "fondue?" });
  assert.equal(session.started, true, "started is set synchronously");
  session.recordAssistant({ content: "Melt the cheese." });
  session.recordUser({ text: "and bread?", content: "and bread?" });
  await session.flush();
  await new Promise((r) => setImmediate(r)); // the title request is not awaited

  assert.deepEqual(client.calls.filter(([k]) => k === "create").length, 1);
  assert.deepEqual(client.calls.filter(([k]) => k === "title").length, 1);
  assert.deepEqual(client.calls.filter(([k]) => k === "append").map((c) => c[1]), ["user", "assistant", "user"]);
  assert.ok(bus.seen.some(([name, detail]) => name === "chat:updated" && detail.titleChanged), "sidebar is told about the AI title");
});

test("saves run in the order they were requested, even when an earlier one is slow", async () => {
  const client = makeClient();
  const slow = client.createChat;
  client.createChat = async (id) => { await new Promise((r) => setTimeout(r, 30)); return slow(id); };
  const session = new ChatSession({ client, bus: makeBus() });

  session.recordUser({ text: "a", content: "a" });
  session.recordAssistant({ content: "b" });
  await session.flush();

  assert.deepEqual(client.calls.filter(([k]) => k === "append").map((c) => c[1]), ["user", "assistant"]);
  assert.equal(client.calls[0][0], "create");
});

test("attachments are uploaded and referenced; oversized and empty files are shown but not kept", async () => {
  const client = makeClient();
  const session = new ChatSession({ client, bus: makeBus() });

  const record = await session.recordUser({
    text: "see files",
    content: "see files",
    files: [file("a.txt"), file("empty.txt", 0), file("huge.bin", 26 * 1024 * 1024)],
  });

  assert.deepEqual(client.calls.filter(([k]) => k === "upload").map((c) => c[1]), ["a.txt"]);
  assert.equal(record.files[0].id, "f-0123456789abcdef");
  assert.equal(record.files[1].id, undefined);
  assert.equal(record.files[2].id, undefined);
});

test("a failed upload does not lose the message", async () => {
  const client = makeClient({ failUpload: true });
  const session = new ChatSession({ client, bus: makeBus() });
  const record = await session.recordUser({ text: "hi", content: "hi", files: [file("a.txt")] });

  assert.ok(record, "the message was still saved");
  assert.equal(record.files[0].id, undefined);
});

test("a failed save is reported on the bus, never thrown, and the queue keeps going", async () => {
  const client = makeClient({ failAppendOn: 1 });
  const bus = makeBus();
  const session = new ChatSession({ client, bus });

  assert.equal(await session.recordUser({ text: "a", content: "a" }), null);
  assert.ok(await session.recordAssistant({ content: "b" }), "the next save still ran");
  assert.ok(bus.seen.some(([name]) => name === "chat:persist-error"));
});

test("an existing chat is never re-created and never re-titled", async () => {
  const client = makeClient();
  const session = new ChatSession({ id: "chat-lx3k9a-0123456789ab", client, bus: makeBus() });

  assert.equal(session.isExisting, true);
  assert.equal(session.started, true);
  await session.load();
  await session.recordUser({ text: "more", content: "more" });
  await session.flush();
  await new Promise((r) => setImmediate(r));

  assert.equal(client.calls.some(([k]) => k === "create"), false);
  assert.equal(client.calls.some(([k]) => k === "title"), false);
});

test("markIndexed before the first message does nothing; after it, it patches the chat", async () => {
  const client = makeClient();
  const session = new ChatSession({ client, bus: makeBus() });

  assert.equal(await session.markIndexed(), null);
  assert.equal(client.calls.length, 0);

  session.recordUser({ text: "a", content: "a" });
  await session.markIndexed();
  assert.deepEqual(client.calls.at(-1), ["update", { ragIndexed: true }]);
});

/* ------------------------------------------------------------------ */

test("New Chat on a blank chat only refocuses the input", () => {
  const bus = makeBus();
  initChatNav({ bus });
  bus.emit("chat:new");

  assert.deepEqual(bus.seen.map(([n]) => n), ["chat:new", "chat:focus-input"]);
});

test("New Chat on a used chat opens a fresh one with a new key each time", () => {
  const bus = makeBus();
  initChatNav({ bus });
  bus.emit("chat:active", { chatId: "chat-a", isEmpty: false });
  bus.emit("chat:new");

  const nav = bus.seen.find(([n]) => n === "nav:select");
  assert.equal(nav[1].id, "chat");
  assert.equal(nav[1].params.chatId, null);
  assert.ok(nav[1].params.nonce, "a nonce makes the main view remount");
});

test("opening a chat, the same chat again, and deleting the open chat", () => {
  const bus = makeBus();
  initChatNav({ bus });
  bus.emit("chat:active", { chatId: "chat-a", isEmpty: false });

  bus.emit("chat:open", { chatId: "chat-a" });
  assert.equal(bus.seen.filter(([n]) => n === "nav:select").length, 0, "already open: nothing happens");

  bus.emit("chat:open", { chatId: "chat-b" });
  assert.deepEqual(bus.seen.filter(([n]) => n === "nav:select").at(-1)[1].params, { chatId: "chat-b" });

  bus.emit("chat:active", { chatId: "chat-b", isEmpty: false });
  bus.emit("chat:deleted", { id: "chat-zzz" });
  assert.equal(bus.seen.filter(([n]) => n === "nav:select").length, 1, "deleting another chat changes nothing");

  bus.emit("chat:deleted", { id: "chat-b" });
  assert.equal(bus.seen.filter(([n]) => n === "nav:select").length, 2, "deleting the open chat leaves for a blank one");
  const redirect = bus.seen.filter(([n]) => n === "nav:select").at(-1)[1];
  assert.equal(redirect.id, "chat");
  assert.equal(redirect.params.chatId, null);
  assert.ok(redirect.params.nonce, "the blank chat remounts after deletion");
});

test("initChatNav returns a disposer", () => {
  const bus = makeBus();
  const dispose = initChatNav({ bus });
  dispose();
  bus.emit("chat:active", { chatId: "x", isEmpty: false });
  bus.emit("chat:new");
  assert.equal(bus.seen.filter(([n]) => n === "nav:select").length, 0);
});

test("restored chats render their already-filtered saved sources unchanged", async () => {
  const savedInfo = { kind: "hits", sources: [{ path: "docs/Interview_Prep.docx", excerpt: "Used passage." }] };
  let shownInfo = null;
  const chatManager = {
    initiateEmptyAssistantResponse: () => ({}),
    finalizeResponse: () => {},
    showSources: (_controller, info) => { shownInfo = info; },
    scrollToBottom: () => {},
  };

  await renderSavedChat({
    chatManager,
    chatId: "chat-example",
    messages: [{
      role: "assistant",
      content: "The result follows the passage.",
      sources: savedInfo,
    }],
  });

  assert.strictEqual(shownInfo, savedInfo);
});

/* ------------------------------------------------------------------ */

test("groupChats buckets by local day and drops empty groups", () => {
  const now = new Date(2026, 10, 11, 15, 0, 0); // 11 Nov 2026, 15:00 local
  const at = (daysAgo, hour = 10) => new Date(2026, 10, 11 - daysAgo, hour).getTime();
  const chats = [
    { id: "a", updatedAt: at(0) },
    { id: "b", updatedAt: at(0, 14) },
    { id: "c", updatedAt: at(1, 23) },
    { id: "d", updatedAt: at(5) },
    { id: "e", updatedAt: at(20) },
    { id: "f", updatedAt: at(90) },
  ];

  const groups = groupChats(chats, now);
  assert.deepEqual(groups.map((g) => g.key), ["today", "yesterday", "week", "month", "older"]);
  assert.deepEqual(groups[0].items.map((c) => c.id), ["b", "a"], "newest first inside a group");

  assert.deepEqual(groupChats([{ id: "x", updatedAt: at(0) }], now).map((g) => g.key), ["today"]);
  assert.deepEqual(groupChats([], now), []);
});

/* ------------------------------------------------------------------ */
/* relative timestamps under messages ("NaN days ago" regression)      */
/* ------------------------------------------------------------------ */

test("assistant rows are born with a timestamp and the action bar cannot render NaN", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const manager = await fs.readFile(path.join(here, "../renderer/ai/components/chat/chat.js"), "utf8");
  assert.match(
    manager,
    /initiateEmptyAssistantResponse\(\) \{[\s\S]*?createdAt: Date\.now\(\)/,
    "assistant rows are created without a timestamp"
  );

  // The action bar's defaults must come after the option spread: spreading
  // an explicit `createdAt: undefined` over them used to kill the fallback
  // and produce "NaN days ago" under every answer.
  const bar = await fs.readFile(path.join(here, "../renderer/ai/components/message-actions/message-actions.js"), "utf8");
  assert.match(bar, /\.\.\.options\s*\};[\s\S]{0,400}createdAt = this\.options\.createdAt \|\| Date\.now\(\)/);
  assert.match(bar, /Number\.isFinite\(timestamp\)/, "formatRelativeTime can still render NaN");

  const userBar = await fs.readFile(path.join(here, "../renderer/ai/components/message-actions/user-message-actions.js"), "utf8");
  assert.match(userBar, /Number\.isFinite\(timestamp\)/, "user actions can still render NaN");
});

test("saved chats enter the docked layout before restoration and reveal after rendering", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, "../renderer/js/views/chat.js"), "utf8");
  const styles = await fs.readFile(path.join(here, "../renderer/ai/ai.css"), "utf8");
  const restore = source.slice(source.indexOf("if (params.chatId) {"), source.indexOf("\n  // Return cleanup", source.indexOf("if (params.chatId) {")));

  assert.ok(
    restore.indexOf("shell.classList.add('is-restoring', 'is-chatting')") < restore.indexOf("await session.load()"),
    "the saved chat waits to change layouts until after its data loads"
  );
  assert.match(restore, /aiInput\.setDocked\(true\)/);
  assert.match(restore, /requestAnimationFrame\(\(\) => shell\.classList\.remove\('is-restoring'\)\)/);
  assert.match(styles, /\.ai-app-shell\.is-restoring,\s*\.ai-app-shell\.is-restoring \*/);
  assert.match(styles, /\.ai-app-shell\.is-restoring \.ai-chat-messages\s*\{\s*opacity: 0;/);
  assert.match(styles, /\.ai-chat-messages\s*\{\s*transition: opacity 0\.18s ease;/);
});

test("the input hides send while voice input is busy", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, "../renderer/ai/components/input/ai-input.js"), "utf8");
  const styles = await fs.readFile(path.join(here, "../renderer/ai/components/input/ai-input.css"), "utf8");
  const aiStyles = await fs.readFile(path.join(here, "../renderer/ai/ai.css"), "utf8");
  const html = await fs.readFile(path.join(here, "../renderer/index.html"), "utf8");

  assert.match(source, /data-tooltip="Voice input"/);
  assert.match(source, /typeof this\.options\.onMic === 'function'\) this\.options\.onMic\(\)/);
  assert.match(source, /classList\.toggle\('ai-hidden', this\.state\.micBusy \|\| !hasText\)/);
  assert.match(source, /this\.el\.sendBtn\.disabled = this\.state\.micBusy/);
  assert.match(source, /if \(this\.state\.micBusy\) return;/);
  assert.match(source, /classList\.toggle\('is-requesting', state === 'requesting'\)/);
  assert.match(styles, /\.ai-mic-btn\.is-requesting::after,\s*\.ai-mic-btn\.is-transcribing::after\s*\{/);
  assert.doesNotMatch(source, /voiceModeBtn|voiceActiveBar|voiceWaveCanvas|startVoiceInput|ScrollingWave/);
  assert.doesNotMatch(styles, /ai-voice-mode-btn|is-listening/);
  assert.doesNotMatch(aiStyles, /voice-ui\.css/);
  assert.doesNotMatch(html, /voice-wave\.js/);
});

test("the chat greeting renders as plain text without the app logo", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, "../renderer/js/views/chat.js"), "utf8");

  assert.match(source, /<h1 class="ai-header-title">\s*<span class="greeting__text"><\/span>\s*<\/h1>/);
  assert.doesNotMatch(source, /HEADER_LOGO|ai-brand-icon|icon-artemis-mark/);
});

test("user documents render as wrapping chips with a light-theme bubble outline", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, "../renderer/ai/components/chat/chat.js"), "utf8");
  const styles = await fs.readFile(path.join(here, "../renderer/ai/components/chat/chat.css"), "utf8");
  const lightStyles = await fs.readFile(path.join(here, "../renderer/ai/styles/theme-light.css"), "utf8");
  const actionStyles = await fs.readFile(
    path.join(here, "../renderer/ai/components/message-actions/user-message-actions.css"),
    "utf8"
  );

  assert.match(source, /const MAX_DOC_CHIPS = 6;/);
  assert.match(source, /attachmentsHtml \+= '<div class="ai-user-docs">';/);
  assert.match(source, /<span class="ai-doc-name">\$\{this\.escapeHtml\(name\)\}<\/span>/);
  assert.doesNotMatch(source, /ai-doc-type|ai-doc-info|slice\(0, 5\)/);
  assert.match(source, /ai-user-attachment-more/);
  assert.match(styles, /\.ai-user-docs\s*\{[^}]*flex-wrap: wrap;[^}]*justify-content: flex-end;/s);
  assert.match(styles, /\.ai-user-attachment-doc\s*\{[^}]*display: inline-flex;[^}]*padding: 5px 12px 5px 6px;/s);
  assert.match(styles, /\.ai-doc-icon\s*\{[^}]*width: 26px;[^}]*height: 26px;/s);
  assert.match(styles, /max-width: 240px;/);
  assert.doesNotMatch(styles, /min-width: 220px/);
  assert.match(lightStyles, /:root\[data-theme="light"\] \.ai-user-bubble\s*\{[^}]*border: 1px solid var\(--palette-ink\);[^}]*box-shadow: none;/s);
  assert.match(actionStyles, /\.ai-user-message-actions\s*\{[^}]*margin-top: 6px;/s);
});

test("a failed history load retries itself and never masks the older chats", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, "../renderer/js/components/history-list.js"), "utf8");

  // The list loads once at startup, racing the agent's boot. Without a retry,
  // one slow cold start left the panel empty for the whole session.
  assert.match(source, /const scheduleRetry = \(\) => \{/, "a failed load is final");
  assert.match(source, /retryTimer = setTimeout\(load, delay\)/, "the retry never fires");
  assert.doesNotMatch(source, /retryAttempts > 10/, "the retry stops before a slow agent starts");

  // The old masking bug: a failed load followed by one sent message flipped
  // the status to 'ready' and rendered a sidebar holding only the new chat,
  // so every older chat looked deleted.
  assert.ok(
    !source.includes("if (status !== 'ready') status = 'ready';"),
    "a single chat still masks a failed list load"
  );
  assert.match(
    source,
    /const upsert = \(chat, \{ titleChanged = false \} = \{\}\) => \{[\s\S]{0,500}if \(status !== 'ready'\) return;/,
    "upsert renders onto a panel that never loaded"
  );

  // A successful save or an opened chat proves the agent is back: recover by
  // reloading the whole list, not by showing one chat.
  const reloads = (source.match(/if \(status === 'error'\) \{ load\(\); return; \}/g) || []).length;
  assert.equal(reloads, 2, "chat:updated / chat:active do not recover an error-state list");

  // The retry timer must not outlive the sidebar.
  assert.match(source, /clearRetry\(\);\s*\n\s*root\.replaceChildren\(\);/, "the retry timer leaks past unmount");
});
