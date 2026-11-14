/**
 * Regression tests for "add the history folder": ONE pinned folder holds the
 * whole agent history (conversations, attachments, titles), the UI shows
 * where it is and can open it, and the agent loads the history from it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFile(path.join(here, "..", rel), "utf8");

test("the main process owns the history folder and can open it", async () => {
    const source = await read("main/ipc.js");

    assert.match(source, /path\.join\(app\.getPath\('userData'\), 'chats'\)/,
        "the folder is pinned to <userData>/chats - the one the agent is pointed at");
    assert.match(source, /mkdirSync\(historyFolder\(\), \{ recursive: true \}\)/,
        "the folder exists from launch, before any chat is saved");
    assert.match(source, /ipcMain\.handle\('history:folder'/,
        "the renderer can ask where the history lives");
    assert.match(source, /ipcMain\.handle\('history:folder', \(\) => \(\{ path: historyFolder\(\) \}\)\)/,
        "the settings view receives the path in the shape it expects");
    assert.match(source, /ipcMain\.handle\('history:open-folder'/,
        "the renderer can ask the main process to open it");
    assert.match(source, /shell\.openPath\(/,
        "opening goes through Electron's shell, not a renderer guess");
});

test("the preload bridge exposes the folder without letting the renderer choose it", async () => {
    const source = await read("preload/preload.js");

    assert.match(source, /exposeInMainWorld\('historyFolder'/,
        "a dedicated, documented bridge");
    assert.match(source, /get: \(\) => ipcRenderer\.invoke\('history:folder'\)/);
    assert.match(source, /open: \(\) => ipcRenderer\.invoke\('history:open-folder'\)/);
    assert.doesNotMatch(source, /invoke\('history:[^']+',\s*[^)]/,
        "no renderer-supplied arguments: the path cannot be redirected");
});

test("the history sidebar has a search icon and no folder footer", async () => {
    const source = await read("renderer/js/components/history-list.js");
    const icons = await read("renderer/styles/icons.css");
    const searchIcon = await read("assets/icons/search.svg");
    const historyCss = await read("renderer/styles/history.css");

    assert.match(source, /<label class="history-search-wrap">[\s\S]*icon icon-search[\s\S]*class="history-search"/,
        "the search icon is inside a label that focuses the input");
    assert.doesNotMatch(source, /history-foot|open-folder|folderPath/,
        "the folder footer is removed from chat history");
    assert.match(icons, /\.icon-search\s*\{[^}]*url\("\.\.\/\.\.\/assets\/icons\/search\.svg"\)/);
    assert.match(searchIcon, /<circle /);
    assert.match(searchIcon, /<path /);
    assert.match(historyCss, /\.history-row\[aria-current="true"\] \.history-open::before/);
    assert.match(historyCss, /\.history-search-wrap \.icon/);
});

test("a failed chat deletion restores the entry and announces the error", async () => {
    const source = await read("renderer/js/components/history-list.js");
    const remove = source.match(/const remove = async \(id\) => \{([\s\S]*?)\n  \};/);

    assert.ok(remove, "the delete handler exists");
    assert.match(remove[1], /catch \(error\) \{[\s\S]*chats = before;[\s\S]*deleteError = true;[\s\S]*render\(\);[\s\S]*return;/);
    assert.match(source, /history-note history-error" role="alert">Could not delete the chat/);
});

test("settings shows the history folder path with an Open folder button", async () => {
    const source = await read("renderer/js/views/settings.js");

    assert.match(source, /History folder/,
        "a settings row names the folder");
    assert.match(source, /data-ref="open-history"/,
        "the button exists");
    assert.match(source, /data-ref="history-path"/,
        "the full path is shown");
    assert.match(source, /window\.historyFolder\.open\(\)/,
        "the button opens the folder");
    assert.match(source, /historyRow\?\.remove\(\)/,
        "without the bridge the row is removed instead of sitting there dead");
});

test("the folder icon is registered like the other icons", async () => {
    const svg = await read("assets/icons/folder.svg");
    assert.match(svg, /<path /, "the artwork exists");
    assert.match(svg, /viewBox="0 0 24 24"/, "same canvas as every other icon");

    const css = await read("renderer/styles/icons.css");
    assert.match(css, /\.icon-folder\s*\{[^}]*url\("\.\.\/\.\.\/assets\/icons\/folder\.svg"\)/,
        "registered as a mask, painted with the current color like the rest");

    const icons = await read("renderer/js/icons.js");
    assert.match(icons, /folder: icon\('folder'\)/);
});

test("search and chat bullets, and the settings history row, are styled", async () => {
    const historyCss = await read("renderer/styles/history.css");
    assert.match(historyCss, /\.history-search-wrap \{/, "the search icon wrapper is positioned");
    assert.match(historyCss, /\.history-open::before \{/, "the chat bullet is styled");

    const settingsCss = await read("renderer/styles/settings.css");
    assert.match(settingsCss, /\.settings-history-path \{/, "the path is styled");
    assert.match(settingsCss, /\.settings-btn \{/, "the open button is styled");
});

test("New Chat stays an action rather than a selected navigation page", async () => {
    const sidebarCss = await read("renderer/styles/sidebar.css");
    const mainView = await read("renderer/js/components/mainview.js");
    const settingsModal = await read("renderer/js/components/settings/settings-modal.js");

    assert.match(sidebarCss, /\.nav-btn\[data-action\]\[aria-current="true"\] \{ background: transparent; \}/);
    assert.match(mainView, /\.nav-btn\[data-nav\]:not\(\[data-action\]\)/);
    assert.match(settingsModal, /\.nav-btn\[data-nav\]:not\(\[data-action\]\)/);
});

test("New Chat is active while blank, then the active history row follows its title", async () => {
    const sidebar = await read("renderer/js/components/sidebar.js");
    const sidebarCss = await read("renderer/styles/sidebar.css");
    const chatView = await read("renderer/js/views/chat.js");
    const history = await read("renderer/js/components/history-list.js");

    assert.match(sidebar, /setNewChatPressed\(true\)/, "the clean chat is selected at startup");
    assert.match(sidebar, /bus\.on\('chat:active', \(\{ isEmpty \}\) => setNewChatPressed\(Boolean\(isEmpty\)\)\)/);
    assert.match(sidebarCss, /\.nav-btn\[data-action\]\[aria-pressed="true"\]\s*\{[^}]*background: var\(--active\);/s);
    assert.match(chatView, /bus\.emit\('chat:active', \{ chatId: session\.id, isEmpty: false \}\)/);
    assert.match(history, /bus\.on\('chat:active', \(\{ chatId \}\) => \{\s*activeId = chatId;/);
    assert.match(history, /if \(index === -1\) chats\.push\(next\); else chats\[index\] = next;/);
    assert.match(history, /if \(titleChanged\) typeFor = next\.id;/);
});

test("settings uses themed thin scrollbars inset from the modal edges", async () => {
    const tokens = await read("renderer/styles/tokens.css");
    const base = await read("renderer/styles/base.css");
    const settings = await read("renderer/styles/settings.css");

    assert.match(tokens, /--scroll-thumb:\s*rgba\(255, 255, 255, 0\.14\)/);
    assert.match(tokens, /--scroll-thumb-hover:\s*rgba\(0, 0, 0, 0\.34\)/);
    assert.match(base, /:root\s*\{\s*scrollbar-width: thin;\s*scrollbar-color: var\(--scroll-thumb\) transparent;/);
    assert.match(settings, /\.settings-panel \.settings-content\s*\{[^}]*margin: 14px 0;[^}]*scrollbar-gutter: stable;/);
    assert.match(settings, /\.settings-content:hover\s*\{\s*scrollbar-color: var\(--scroll-thumb-hover\) transparent;/);
});
