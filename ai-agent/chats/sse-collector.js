/**
 * ============================================================================
 * SSE COLLECTOR (chats/sse-collector.js)
 * ============================================================================
 * The providers (groq.js, nvidia.js) only know how to stream into an Express
 * response: they call sendEvent(res, ...) which does res.write("data: ...").
 *
 * This object quacks like that response but keeps everything in memory, so we
 * can reuse the providers for a one-shot call (chat titles) without touching
 * them and without a second code path per provider.
 * ============================================================================
 */
export class SseCollector {
    #buffer = "";

    constructor() {
        // The three flags sendEvent() inspects before writing.
        this.writable = true;
        this.writableEnded = false;
        this.destroyed = false;

        /** Concatenated response.delta text. Reasoning is ignored. */
        this.text = "";
        /** Message of the first error event, if any. */
        this.error = null;
    }

    write(chunk) {
        this.#buffer += String(chunk);

        let boundary = this.#buffer.indexOf("\n\n");
        while (boundary !== -1) {
            const block = this.#buffer.slice(0, boundary);
            this.#buffer = this.#buffer.slice(boundary + 2);
            this.#handle(block);
            boundary = this.#buffer.indexOf("\n\n");
        }
        return true;
    }

    end() {
        this.writableEnded = true;
    }

    #handle(block) {
        for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
                const event = JSON.parse(line.slice(5).trim());
                if (event.type === "response.delta" && typeof event.text === "string") {
                    this.text += event.text;
                } else if (event.type === "error" && this.error === null) {
                    this.error = event.message || "the model request failed";
                }
            } catch {
                // A malformed fragment is not worth failing a title over.
            }
        }
    }
}
