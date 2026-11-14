/**
 * ============================================================================
 * AI EVENT DEFINITIONS & SSE PROTOCOL (runtime/events.js)
 * Standardized event types and SSE streaming helpers
 * ============================================================================
 */

export const AI_EVENT_TYPES = {
    THINKING_START: "thinking.start",
    THINKING_STATUS: "thinking.status",
    /*
     * Retrieval lifecycle. These are advisory: the UI shows what was searched
     * and what came back, but a RAG failure never cancels the chat, so there is
     * no terminal rag event that the renderer has to wait for.
     */
    RAG_START: "rag.start",
    RAG_HITS: "rag.hits",
    RAG_ERROR: "rag.error",
    SOURCES_USED: "sources.used",
    REASONING_START: "reasoning.start",
    REASONING_DELTA: "reasoning.delta",
    REASONING_END: "reasoning.end",
    TOOL_START: "tool.start",
    TOOL_UPDATE: "tool.update",
    TOOL_END: "tool.end",
    RESPONSE_START: "response.start",
    RESPONSE_DELTA: "response.delta",
    RESPONSE_END: "response.end",
    DONE: "done",
    ERROR: "error"
};

/**
 * Sends a normalized Server-Sent Event (SSE) over an HTTP response
 * @param {import('express').Response} res
 * @param {Object} event
 * @param {string} event.type
 * @param {*} [event.text]
 * @param {*} [event.payload]
 */
const TRANSFORM = Symbol.for("artemis.eventTransform");

/** transform(event) -> array of events to actually send. Returns a detach function. */
export function attachEventTransform(res, transform) {
    res[TRANSFORM] = transform;
    return () => { delete res[TRANSFORM]; };
}

export function sendEvent(res, event) {
    // The renderer may abort a stream (view unmount, new message). Writing to
    // a closed socket would otherwise raise noisy stream errors.
    if (res.writableEnded || res.destroyed || res.writable === false) {
        return;
    }
    const transform = res[TRANSFORM];
    const events = transform ? transform(event) : [event];

    for (const next of events) {
        try {
            res.write(`data: ${JSON.stringify(next)}\n\n`);
        } catch (_) {
            // Client disconnected between the checks above.
            return;
        }
    }
}
