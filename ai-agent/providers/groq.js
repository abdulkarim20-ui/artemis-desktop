import { Groq } from "groq-sdk";
import { AI_EVENT_TYPES, sendEvent } from "../runtime/events.js";
import { textOf } from "../runtime/vision.js";

function extractReasoningDelta(delta) {
    if (!delta || typeof delta !== "object") {
        return "";
    }
    const candidates = [
        delta.reasoning,
        delta.reasoning_content,
        delta.thinking,
        delta.thought
    ];
    for (const value of candidates) {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return "";
}

export class GroqProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = apiKey && apiKey !== "your_key_here" ? new Groq({ apiKey }) : null;
    }

    async streamChat({ messages, model, isAborted }, res) {
        if (!model) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: "No AI model selected."
            });
            return;
        }

        if (!this.client) {
            await this.streamDemoResponse(messages, res, model);
            return;
        }

        const modelId = model.model;
        console.log(`[GroqProvider] Model: ${modelId}`);

        try {
            sendEvent(res, {
                type: AI_EVENT_TYPES.THINKING_START,
                model: modelId,
                selectedModel: model.name
            });

            const request = this.buildRequest(messages, model);
            const stream = await this.client.chat.completions.create(request);

            let hasStartedReasoning = false;
            let hasStartedResponse = false;

            for await (const chunk of stream) {
                if (isAborted?.()) break;

                const delta = chunk.choices?.[0]?.delta || {};

                /*
                 * Normalize reasoning text across providers and model types
                 */
                const reasoningText = extractReasoningDelta(delta);

                if (reasoningText) {
                    if (!hasStartedReasoning) {
                        hasStartedReasoning = true;
                        sendEvent(res, { type: AI_EVENT_TYPES.REASONING_START, model: modelId });
                    }
                    sendEvent(res, {
                        type: AI_EVENT_TYPES.REASONING_DELTA,
                        text: reasoningText
                    });
                }

                /*
                 * Standard content
                 */
                if (delta.content) {
                    if (hasStartedReasoning && !hasStartedResponse) {
                        sendEvent(res, { type: AI_EVENT_TYPES.REASONING_END });
                    }
                    if (!hasStartedResponse) {
                        hasStartedResponse = true;
                        sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_START });
                    }
                    sendEvent(res, {
                        type: AI_EVENT_TYPES.RESPONSE_DELTA,
                        text: delta.content
                    });
                }
            }

            if (hasStartedReasoning && !hasStartedResponse) {
                sendEvent(res, { type: AI_EVENT_TYPES.REASONING_END });
            }
            if (hasStartedResponse) {
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_END });
            }
            sendEvent(res, { type: AI_EVENT_TYPES.DONE });

        } catch (error) {
            console.error(`[GroqProvider] ${modelId}`, error);

            /*
             * IMPORTANT:
             * NO fallback to another model.
             * The selected model is the model that must execute the request.
             */
            sendEvent(res, {
                type: AI_EVENT_TYPES.ERROR,
                message: error?.message || `Groq request failed for ${model.name}`
            });
        }
    }

    buildRequest(messages, model) {
        const requestConfig = model.request || {};
        const configuredEnvCap = Number(process.env.GROQ_MAX_COMPLETION_TOKENS);
        const envCap = Number.isFinite(configuredEnvCap) && configuredEnvCap > 0
            ? configuredEnvCap
            : null;

        /*
         * Build from the selected model's own configuration.
         */
        const request = {
            messages: Array.isArray(messages) && messages.length > 0
                ? messages
                : [{ role: "user", content: "" }],
            model: model.model,
            stream: requestConfig.stream !== false
        };

        /*
         * Copy supported generation settings with safety clamps for account limits
         */
        const allowedFields = [
            "temperature",
            "max_completion_tokens",
            "top_p",
            "reasoning_effort",
            "reasoning_format",
            "include_reasoning",
            "stop"
        ];

        for (const field of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(requestConfig, field)) {
                if (requestConfig[field] === null) continue;
                if (field === "max_completion_tokens") {
                    const modelLimit = Number(requestConfig[field]);
                    request[field] = envCap
                        ? Math.min(Number.isFinite(modelLimit) && modelLimit > 0 ? modelLimit : envCap, envCap)
                        : requestConfig[field];
                } else {
                    request[field] = requestConfig[field];
                }
            }
        }

        return request;
    }

    async streamDemoResponse(messages, res, model) {
        sendEvent(res, {
            type: AI_EVENT_TYPES.THINKING_START,
            model: model.model,
            selectedModel: model.name
        });

        await new Promise(resolve => setTimeout(resolve, 400));
        sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_START });

        const lastUser = [...(messages || [])].reverse().find(message => message.role === "user");
        const lastUserText = textOf(lastUser?.content);
        const echo = lastUserText ? ` You said: "${lastUserText}".` : "";
        const text = `Demo response for ${model.name}.${echo} Configure GROQ_API_KEY to execute this model.`;
        for (const word of text.split(" ")) {
            sendEvent(res, {
                type: AI_EVENT_TYPES.RESPONSE_DELTA,
                text: word + " "
            });
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_END });
        sendEvent(res, { type: AI_EVENT_TYPES.DONE });
    }
}
