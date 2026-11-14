/**
 * Chat history module (ai-agent/chats).
 *
 * server.js needs exactly one import from here:
 *
 *     import { createChatServices } from "./chats/index.js";
 *     app.use("/api/chats", createChatServices({ runtime }).router);
 */
export { createChatServices } from "./chat-routes.js";
export { ChatStore, ChatStoreError, CHAT_LIMITS } from "./chat-store.js";
export { TitleGenerator } from "./title-generator.js";
export { resolveChatsRoot, standaloneChatsRoot } from "./chat-paths.js";
export { knownChatFolders, importForeignChats } from "./chat-import.js";
