import test from "node:test";
import assert from "node:assert/strict";

import { GroqProvider } from "../ai-agent/providers/groq.js";

test("Groq uses the configured model token limit unless an environment cap is set", () => {
    const previous = process.env.GROQ_MAX_COMPLETION_TOKENS;
    delete process.env.GROQ_MAX_COMPLETION_TOKENS;
    try {
        const provider = new GroqProvider("");
        const request = provider.buildRequest([], {
            model: "test-model",
            request: { max_completion_tokens: 4096 },
        });
        assert.equal(request.max_completion_tokens, 4096);

        process.env.GROQ_MAX_COMPLETION_TOKENS = "2048";
        const capped = provider.buildRequest([], {
            model: "test-model",
            request: { max_completion_tokens: 4096 },
        });
        assert.equal(capped.max_completion_tokens, 2048);

        const lowerModelLimit = provider.buildRequest([], {
            model: "test-model",
            request: { max_completion_tokens: 1024 },
        });
        assert.equal(lowerModelLimit.max_completion_tokens, 1024);
    } finally {
        if (previous === undefined) delete process.env.GROQ_MAX_COMPLETION_TOKENS;
        else process.env.GROQ_MAX_COMPLETION_TOKENS = previous;
    }
});
