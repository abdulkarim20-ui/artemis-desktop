/**
 * ============================================================================
 * NVIDIA PROVIDER ADAPTER (ai-agent/providers/nvidia.js)
 * ============================================================================
 *
 * NVIDIA NIM exposes an OpenAI-compatible Chat Completions API at:
 * https://integrate.api.nvidia.com/v1
 *
 * Features:
 * - Automatic exponential backoff retry for transient 503 / 429 server spikes
 * - Normalized streaming reasoning (delta.reasoning_content -> reasoning.delta)
 * - Direct mapping to unified AI event lifecycle
 *
 * ============================================================================
 */

import OpenAI from "openai";
import { AI_EVENT_TYPES, sendEvent } from "../runtime/events.js";

function extractReasoningDelta(delta) {
    if (!delta || typeof delta !== "object") {
        return "";
    }

    /*
     * NVIDIA Nemotron uses:
     * delta.reasoning_content
     */
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        return delta.reasoning_content;
    }

    /*
     * Keep the adapter tolerant of compatible NVIDIA/NIM response variants.
     */
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        return delta.reasoning;
    }

    if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
        return delta.thinking;
    }

    return "";
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class NVIDIAProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        const looksValid = typeof apiKey === "string" && /^nvapi-\S{20,}$/.test(apiKey);

        if (apiKey && !looksValid) {
            console.warn("[NVIDIAProvider] NVIDIA_API_KEY does not look like an nvapi- key. Ignoring it.");
        }

        this.client = looksValid ? new OpenAI({
            apiKey,
            baseURL: "https://integrate.api.nvidia.com/v1",
            maxRetries: 3,
            timeout: 60000
        }) : null;
    }

    async streamChat({ messages, model, isAborted }, res) {
        if (!model) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: "No NVIDIA model selected."
            });
            return;
        }

        if (!this.client) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: "NVIDIA_API_KEY is not configured in .env file."
            });
            return;
        }

        const modelId = model.model;
        const requestConfig = model.request || {};
        const request = {
            model: modelId,
            messages: Array.isArray(messages) && messages.length > 0
                ? messages
                : [{ role: "user", content: "" }],
            temperature: requestConfig.temperature ?? 1,
            top_p: requestConfig.top_p ?? 0.95,
            max_tokens: requestConfig.max_tokens ?? 16384,
            stream: requestConfig.stream !== false
        };

        if (typeof requestConfig.parallel_tool_calls === "boolean") {
            request.parallel_tool_calls = requestConfig.parallel_tool_calls;
        }

        if (typeof requestConfig.seed === "number") {
            request.seed = requestConfig.seed;
        }

        if (requestConfig.chat_template_kwargs) {
            request.chat_template_kwargs = requestConfig.chat_template_kwargs;
        } else if (requestConfig.extra_body?.chat_template_kwargs) {
            request.chat_template_kwargs = requestConfig.extra_body.chat_template_kwargs;
        }

        /*
         * Start unified thinking lifecycle.
         */
        sendEvent(res, {
            type: AI_EVENT_TYPES.THINKING_START,
            model: modelId,
            selectedModel: model.name
        });

        const maxAttempts = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[NVIDIAProvider] Model: ${modelId} (Attempt ${attempt}/${maxAttempts})`);

                const stream = await this.client.chat.completions.create(request);

                let hasStartedReasoning = false;
                let hasStartedResponse = false;
                let hasReceivedAnyChunk = false;

                for await (const chunk of stream) {
                    if (isAborted?.()) break;
                    if (!chunk || !Array.isArray(chunk.choices) || !chunk.choices.length) {
                        continue;
                    }

                    hasReceivedAnyChunk = true;
                    const delta = chunk.choices[0]?.delta || {};

                    /*
                     * ------------------------------------------------------------
                     * REASONING
                     * ------------------------------------------------------------
                     */
                    const reasoningText = extractReasoningDelta(delta);
                    if (reasoningText) {
                        if (!hasStartedReasoning) {
                            hasStartedReasoning = true;
                            sendEvent(res, {
                                type: AI_EVENT_TYPES.REASONING_START,
                                model: modelId
                            });
                        }
                        sendEvent(res, {
                            type: AI_EVENT_TYPES.REASONING_DELTA,
                            text: reasoningText
                        });
                    }

                    /*
                     * ------------------------------------------------------------
                     * FINAL RESPONSE
                     * ------------------------------------------------------------
                     */
                    const content = typeof delta.content === "string" ? delta.content : "";
                    if (content) {
                        if (hasStartedReasoning && !hasStartedResponse) {
                            sendEvent(res, { type: AI_EVENT_TYPES.REASONING_END });
                        }
                        if (!hasStartedResponse) {
                            hasStartedResponse = true;
                            sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_START });
                        }
                        sendEvent(res, {
                            type: AI_EVENT_TYPES.RESPONSE_DELTA,
                            text: content
                        });
                    }
                }

                /*
                 * Close reasoning lifecycle.
                 */
                if (hasStartedReasoning && !hasStartedResponse) {
                    sendEvent(res, { type: AI_EVENT_TYPES.REASONING_END });
                }

                /*
                 * Close response lifecycle.
                 */
                if (hasStartedResponse) {
                    sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_END });
                }

                /*
                 * Finished successfully.
                 */
                sendEvent(res, { type: AI_EVENT_TYPES.DONE });
                return;

            } catch (error) {
                lastError = error;
                const statusCode = error?.status || error?.statusCode || error?.code;
                const isOverloaded = statusCode === 503 || statusCode === 429 || error?.message?.includes("overloaded") || error?.message?.includes("rate limit");

                console.warn(`[NVIDIAProvider] Attempt ${attempt} failed for ${modelId}:`, error?.message || error);

                if (isOverloaded && attempt < maxAttempts) {
                    const delayMs = attempt * 1200;
                    console.log(`[NVIDIAProvider] Server busy. Retrying in ${delayMs}ms...`);
                    await sleep(delayMs);
                    continue;
                }

                break;
            }
        }

        /*
         * Format user-friendly error message
         */
        const statusCode = lastError?.status || lastError?.statusCode || null;
        let userMessage = lastError?.message || `NVIDIA request failed for ${model.name}`;

        if (statusCode === 401 || statusCode === 403) {
            userMessage = "NVIDIA rejected the API key (401/403). The key in the project-root .env is invalid, expired, or not authorized for this model. Generate a new key at build.nvidia.com, update NVIDIA_API_KEY, then restart Artemis. In the meantime, switch the model badge to a Groq model.";
        } else if (statusCode === 404) {
            userMessage = `NVIDIA does not expose the model "${modelId}" to this account. Pick another model or check your access on build.nvidia.com.`;
        } else if (statusCode === 503 || userMessage.includes("overloaded")) {
            userMessage = "NVIDIA servers are temporarily busy/overloaded (503). Retried automatically. Please try again in a moment.";
        } else if (statusCode === 429) {
            userMessage = "NVIDIA rate limit reached. Please wait a moment and try again.";
        }

        console.error(`[NVIDIAProvider] Final failure for ${modelId}:`, lastError);

        sendEvent(res, {
            type: AI_EVENT_TYPES.ERROR,
            provider: "nvidia",
            model: modelId,
            status: statusCode,
            message: userMessage
        });
    }
}
