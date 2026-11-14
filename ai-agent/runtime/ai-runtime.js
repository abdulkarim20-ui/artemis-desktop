import { GroqProvider } from "../providers/groq.js";
import { NVIDIAProvider } from "../providers/nvidia.js";
import { contextBudget } from "../rag/context-block.js";
import { buildSearchQuery, toQueryText } from "../rag/retriever.js";
import { RagService } from "../rag/service.js";
import { SourceRegistry, createCitationTransform } from "../rag/citations.js";
import { parseDocumentBytes } from "./document-parser.js";
import { AI_EVENT_TYPES, attachEventTransform, sendEvent } from "./events.js";
import { ModelRegistry } from "./model-registry.js";
import { buildSystemMessages } from "./system-prompts.js";
import { ATTACH_IMAGES_ONLY_NOTE, assertVisionSupport, sanitizeImages, toProviderMessages } from "./vision.js";
import { isSmallTalk } from "../../shared/small-talk.js";

const MAX_MESSAGE_CHARS = 150000;
const MAX_TOTAL_CHARS = 300000;

/**
 * Below this much free room, retrieval is skipped rather than attempted.
 * A <retrieved_context> block that has to be squeezed into a few hundred
 * characters is worse than no block at all: it costs an embedding call, adds a
 * passage too short to be useful, and still has to be explained by the system
 * prompt.
 */
const MIN_RAG_BUDGET = 4000;

const FILE_BLOCK_RE = /<(attached_files|retrieved_context)\b[\s\S]*?<\/\1>/gi;

/** A casual message about THIS turn: no new attachment, and the text is small talk. */
function isSmallTalkTurn(messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return false;
    if (Array.isArray(lastUser.images) && lastUser.images.length) return false;
    if (/<attached_images\b/i.test(lastUser.content)) return false;
    if (/<attached_files\b/i.test(lastUser.content)) return false; // files arrived with this message
    return isSmallTalk(lastUser.content);
}

/**
 * Casual replies need neither the file text nor a long history. Keep the last
 * two exchanges for tone, drop every file block, and let the system prompt
 * (which only adds file rules when a block is present) shrink with it.
 */
function lightenForSmallTalk(messages) {
    const tail = messages.slice(-5);
    while (tail.length && tail[0].role !== "user") tail.shift();
    return tail.map((m) =>
        m.role === "user"
            ? { ...m, content: m.content.replace(FILE_BLOCK_RE, "[file contents omitted for this short reply]") }
            : m
    );
}

/** Lower reasoning effort; optionally pin a low temperature for grounded answers. */
function tuneRequest(selectedModel, { temperature = null } = {}) {
    const request = selectedModel.request || {};
    const next = { ...request };

    if (typeof request.reasoning_effort === "string" && request.reasoning_effort !== "low") {
        next.reasoning_effort = "low";
    }
    const kwargs = request.chat_template_kwargs;
    if (kwargs && typeof kwargs === "object" && kwargs.enable_thinking === true) {
        next.chat_template_kwargs = { ...kwargs, enable_thinking: false };
    }
    if (temperature !== null) {
        next.temperature = Math.min(typeof request.temperature === "number" ? request.temperature : temperature, temperature);
    }
    selectedModel.request = next;
}

/** Normalize keys copied from .env / docs (quotes, spaces, CRLF). */
const cleanKey = (value) => String(value ?? "").trim().replace(/^["']|["']$/g, "").trim();

/**
 * Normalize a browser chat payload into provider-safe messages.
 * Accepts either the newer `messages` array or the legacy `prompt` string.
 */
export function normalizeMessages({ messages, prompt } = {}) {
    const cleaned = [];

    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (!message || typeof message !== "object") continue;
            // The browser may not send system messages. The backend adds its own.
            const role = String(message.role || "").toLowerCase();
            if (role !== "user" && role !== "assistant") continue;

            const content = typeof message.content === "string"
                ? message.content
                : String(message.content ?? "");
            let trimmed = content.trim();
            const images = role === "user" ? sanitizeImages(message.images) : [];
            if (!trimmed && images.length === 0) continue;
            if (!trimmed) trimmed = ATTACH_IMAGES_ONLY_NOTE;
            const withImages = images.length ? { images } : {};

            if (trimmed.length > MAX_MESSAGE_CHARS) {
                if (trimmed.includes("<attached_files")) {
                    throw new Error(
                        "The attached files are too large to send. Attach fewer or smaller files."
                    );
                }
                cleaned.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS), ...withImages });
            } else {
                cleaned.push({ role, content: trimmed, ...withImages });
            }
        }
    }

    // Keep the NEWEST messages that fit. The latest user message must never be dropped.
    const kept = [];
    let totalChars = 0;
    for (let i = cleaned.length - 1; i >= 0; i -= 1) {
        const size = cleaned[i].content.length;
        if (kept.length > 0 && totalChars + size > MAX_TOTAL_CHARS) break;
        totalChars += size;
        kept.unshift(cleaned[i]);
    }

    if (kept.length === 0 && typeof prompt === "string" && prompt.trim()) {
        kept.push({ role: "user", content: prompt.trim().slice(0, MAX_MESSAGE_CHARS) });
    }

    if (!kept.some((message) => message.role === "user")) {
        throw new Error("No prompt provided.");
    }

    return kept;
}

export class AIRuntime {
    constructor(config = {}) {
        this.config = config;
        this.registry = new ModelRegistry();
        this.providers = {
            groq: new GroqProvider(cleanKey(process.env.GROQ_API_KEY)),
            nvidia: new NVIDIAProvider(cleanKey(process.env.NVIDIA_API_KEY))
        };

        /*
         * Retrieval reuses the exact converter behind POST /api/parse, so a file
         * that attaches successfully is indexed by the same rules - including
         * the honest "pages 2, 5-7 need OCR" refusal.
         */
        this.rag = new RagService({
            apiKey: cleanKey(process.env.NVIDIA_API_KEY),
            parseDocument: parseDocumentBytes,
            ...(config.rag || {})
        });
    }

    async getModels() {
        return this.registry.getPublicRegistry();
    }

    /** Never throws; "unavailable, and why" is the answer the UI needs. */
    async getRagStatus() {
        try {
            return await this.rag.status();
        } catch (error) {
            return { enabled: false, configured: false, reason: error.message || String(error) };
        }
    }

    /**
     * Search the knowledge base and append the result to the newest user turn.
     *
     * Deliberately non-fatal. Retrieval is an enhancement to a chat that already
     * works, so every failure path reports itself over SSE and returns false,
     * leaving the message to be answered from whatever context it already had.
     * Turning a missing API key into a broken chat would be a bad trade.
     *
     * @returns {Promise<boolean>} true when passages were injected
     */
    async #applyRetrieval({ messages, rag, res, isAborted, registry }) {
        if (!rag || rag.enabled === false || !rag.collection) return false;

        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        if (!lastUser) return false;

        // normalizeMessages builds fresh objects, so mutating this one cannot
        // reach back into the caller's history array.
        const budget = contextBudget(lastUser.content.length, MAX_MESSAGE_CHARS);
        if (budget < MIN_RAG_BUDGET) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.RAG_ERROR,
                message: "the message is already close to the size limit, so the knowledge base was not searched"
            });
            return false;
        }

        sendEvent(res, { type: AI_EVENT_TYPES.RAG_START, collection: String(rag.collection) });

        // Follow-ups borrow the previous REAL question (never a casual turn).
        const query = buildSearchQuery(messages, lastUser);

        try {
            const result = await this.rag.retrieveContext({
                collection: rag.collection,
                query,
                topK: rag.topK,
                budgetChars: budget
            });

            if (isAborted?.()) return false;

            registry.addPassages(result.included);

            if (result.block) {
                lastUser.content = `${lastUser.content}\n\n${result.block}`;
            }

            sendEvent(res, {
                type: AI_EVENT_TYPES.RAG_HITS,
                collection: String(rag.collection),
                hits: result.hits,
                dropped: result.dropped,
                sources: result.sources.map(({ body, ...source }) => source),
                skipped: result.skipped
            });

            return result.hits > 0;
        } catch (error) {
            console.warn("[RAG] retrieval skipped:", error?.message || error);
            sendEvent(res, {
                type: AI_EVENT_TYPES.RAG_ERROR,
                code: error?.code || "error",
                message: `the knowledge base could not be searched (${error?.message || "unknown error"}). Answering from the message alone.`
            });
            return false;
        }
    }

    async executeChat({ prompt, messages, model, rag, isAborted }, res) {
        let selectedModel;
        try {
            /*
             * IMPORTANT:
             * Never trust the model object sent from the browser.
             * Resolve it again from our backend registry. A null model means
             * "use the registry default" (fixes the old fake-name bug).
             */
            selectedModel = await this.registry.resolve(model);
        } catch (error) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: error.message
            });
            return;
        }

        if (!selectedModel) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: "No AI model is configured."
            });
            return;
        }

        let normalizedMessages;
        try {
            normalizedMessages = normalizeMessages({ messages, prompt });
            assertVisionSupport(normalizedMessages, selectedModel);
        } catch (error) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                ...(error.code ? { code: error.code } : {}),
                message: error.message
            });
            return;
        }

        const provider = this.providers[selectedModel.provider];
        if (!provider) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: `Unsupported AI provider: ${selectedModel.provider}`
            });
            return;
        }

        const smallTalk = isSmallTalkTurn(normalizedMessages);
        const registry = new SourceRegistry();
        let modelMessages = normalizedMessages;
        let ragApplied = false;

        if (smallTalk) {
            // No retrieval at all: no query embedding, no passages, no tokens.
            modelMessages = lightenForSmallTalk(normalizedMessages);
            tuneRequest(selectedModel);
        } else {
            /*
             * Retrieval runs before the system prompt is built, so
             * buildSystemMessages can see the injected <retrieved_context> block.
             */
            ragApplied = await this.#applyRetrieval({ messages: normalizedMessages, rag, res, isAborted, registry });

            const lastUser = [...normalizedMessages].reverse().find((message) => message.role === "user");
            registry.addAttachedFiles(lastUser);

            const hasFileContext = normalizedMessages.some(
                (m) => m.role === "user" && /<(attached_files|retrieved_context)\b/i.test(m.content)
            );
            // Passages already hold the facts, so long deliberation only adds wait.
            // Grounded answers also get a low temperature to cut invention.
            if (ragApplied) tuneRequest(selectedModel, { temperature: 0.2 });
            else if (hasFileContext) tuneRequest(selectedModel, { temperature: 0.2 });
        }

        const sources = registry.entries();
        const detach = registry.size
            ? attachEventTransform(res, createCitationTransform({
                registry,
                searched: {
                    passages: sources.filter((source) => source.kind === "passage").length,
                    files: sources.filter((source) => source.kind === "file").length,
                },
            }))
            : () => {};

        const providerMessages = toProviderMessages(modelMessages, selectedModel);

        try {
            await provider.streamChat({
                messages: [...buildSystemMessages(modelMessages, { smallTalk }), ...providerMessages],
                model: selectedModel,
                isAborted
            }, res);
        } finally {
            detach();
        }
    }
}
