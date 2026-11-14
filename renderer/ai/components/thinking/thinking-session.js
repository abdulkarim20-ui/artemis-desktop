/**
 * ============================================================================
 * THINKING SESSION (components/thinking/thinking-session.js)
 * Provider-agnostic runtime state manager for AI reasoning & tool execution
 * Owns the lifecycle, timer, reasoning summaries, and tool states.
 * ============================================================================
 */

class ThinkingSession {
    constructor(options = {}) {
        this.options = {
            capabilities: {
                reasoningSummary: true,
                tools: true,
                streaming: true
            },
            model: null,
            ...options
        };

        this.startedAt = performance.now();
        this.elapsed = 0;
        this.status = "Thinking";
        this.state = "thinking"; // "thinking" | "reasoning" | "tool" | "complete" | "error"
        this.reasoning = "";
        this.tools = [];
        this.listeners = new Map();
        this.timer = null;
        this.isActive = false;

        this.start();
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.startedAt = performance.now();

        // 250ms polling loop that updates integer seconds cleanly without excessive DOM churn
        this.timer = setInterval(() => {
            if (!this.isActive) return;
            const currentSeconds = Math.floor((performance.now() - this.startedAt) / 1000);
            if (currentSeconds !== this.elapsed) {
                this.elapsed = currentSeconds;
                this.emit("tick", { seconds: this.elapsed });
            }
        }, 250);
    }

    setStatus(status) {
        this.status = status;
        this.emit("status", { status: this.status });
    }

    addReasoning(deltaText) {
        if (!deltaText) return;
        this.reasoning += deltaText;
        this.state = "reasoning";
        this.emit("reasoning.delta", {
            delta: deltaText,
            text: this.reasoning
        });
    }

    startTool(toolName, metadata = {}) {
        const toolObj = {
            id: toolName,
            name: metadata.name || toolName,
            status: "running",
            message: metadata.message || `Running ${toolName}...`,
            startedAt: Date.now()
        };
        this.tools.push(toolObj);
        this.state = "tool";
        this.emit("tool.start", toolObj);
    }

    updateTool(toolName, message) {
        const tool = this.tools.find(t => t.id === toolName);
        if (tool) {
            tool.message = message;
        }
        this.emit("tool.update", { tool: toolName, message });
    }

    endTool(toolName) {
        const tool = this.tools.find(t => t.id === toolName);
        if (tool) {
            tool.status = "completed";
            tool.endedAt = Date.now();
        }
        this.emit("tool.end", { tool: toolName });
    }

    finish() {
        this.isActive = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.state = "complete";
        this.emit("complete", {
            elapsed: this.elapsed,
            reasoning: this.reasoning,
            tools: this.tools
        });
    }

    getElapsedSeconds() {
        return this.elapsed;
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).delete(callback);
        }
    }

    emit(event, data) {
        if (this.listeners.has(event)) {
            for (const cb of this.listeners.get(event)) {
                try {
                    cb(data);
                } catch (e) {
                    console.error(`[ThinkingSession] Listener error on '${event}':`, e);
                }
            }
        }
    }

    destroy() {
        this.finish();
        this.listeners.clear();
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = ThinkingSession;
} else {
    window.ThinkingSession = ThinkingSession;
}
