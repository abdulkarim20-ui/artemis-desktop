/**
 * ============================================================================
 * THINKING VIEW (components/thinking/thinking-view.js)
 * Presenter for ThinkingSession: status label, elapsed timer, reasoning panel
 * and the Artemis pixel loader. Rendering is driven by session events.
 * ============================================================================
 */

class ThinkingView {
    /**
     * @param {ThinkingSession} session
     */
    constructor(session) {
        if (!session) {
            throw new Error("ThinkingView requires a ThinkingSession.");
        }

        this.session = session;
        this.currentStatus = "Thinking";
        this.isExpanded = false;
        this.isPresentationRunning = false;
        this.reasoningMarkdown = null;
        this.pixelAnimation = null;

        this.element = this.createDOM();
        const animationSlot = this.element.querySelector(".ai-thinking-loader-slot");
        if (!animationSlot || typeof ThinkingPixelAnimation === "undefined") {
            throw new Error("ThinkingPixelAnimation is not loaded.");
        }
        this.pixelAnimation = new ThinkingPixelAnimation();
        animationSlot.replaceWith(this.pixelAnimation.getElement());

        // Initialize dedicated Markdown streaming controller for reasoning content
        if (this.contentEl && typeof MarkdownStream !== "undefined") {
            this.reasoningMarkdown = new MarkdownStream(this.contentEl, { preset: "ai-chat" });
        }

        this.bindSessionEvents();
        this.bindUserInteractions();
    }

    createDOM() {
        const root = document.createElement("div");
        root.className = "ai-thinking";
        root.setAttribute("data-state", "thinking");
        root.setAttribute("data-has-reasoning", "false");

        root.innerHTML = `
            <div class="ai-thinking-header">
                <span class="ai-thinking-loader-slot" aria-hidden="true"></span>
                <button type="button" class="ai-thinking-toggle" aria-expanded="false" title="Toggle reasoning summary">
                    <span class="ai-thinking-label-wrap">
                        <span class="ai-thinking-status">${this.currentStatus}</span>
                    </span>
                    <span class="ai-thinking-sep">·</span>
                    <span class="ai-thinking-timer">0s</span>
                    <span class="icon icon-chevron-right ai-thinking-chevron" aria-hidden="true"></span>
                </button>
            </div>
            <div class="ai-reasoning-panel ai-hidden">
                <div class="ai-reasoning-content"></div>
            </div>
        `;

        this.statusEl = root.querySelector(".ai-thinking-status");
        this.timerEl = root.querySelector(".ai-thinking-timer");
        this.toggleBtn = root.querySelector(".ai-thinking-toggle");
        this.panelEl = root.querySelector(".ai-reasoning-panel");
        this.contentEl = root.querySelector(".ai-reasoning-content");

        return root;
    }

    renderReasoning(text, { streaming = true } = {}) {
        if (!this.contentEl) return;
        const markdown = String(text || "");

        // Use the application's canonical Markdown renderer
        if (typeof MarkdownRenderer !== "undefined" && typeof MarkdownRenderer.renderInto === "function") {
            MarkdownRenderer.renderInto(this.contentEl, markdown, { preset: "ai-chat", streaming });
            return;
        }

        // Safe fallback if Markdown subsystem is loading
        this.contentEl.textContent = markdown;
    }

    bindSessionEvents() {
        if (!this.session) return;

        // 1. Decoupled Timer Tick
        this.session.on("tick", ({ seconds }) => {
            if (this.timerEl) {
                this.timerEl.textContent = `${seconds}s`;
            }
        });

        // 2. Explicit Status Update
        this.session.on("status", ({ status }) => {
            this.setStatus(status);
        });

        // 3. Normalized Reasoning Streaming via MarkdownStream
        this.session.on("reasoning.delta", ({ delta, text }) => {
            this.element.setAttribute("data-has-reasoning", "true");
            this.element.setAttribute("data-state", "thinking");
            if (this.currentStatus === "Thinking") {
                this.setStatus("Reasoning");
            }
            if (this.reasoningMarkdown) {
                this.reasoningMarkdown.append(delta);
            } else if (this.contentEl) {
                this.renderReasoning(text, { streaming: true });
            }
            if (this.panelEl) {
                // Auto-scroll to bottom of reasoning panel so user follows live stream
                this.panelEl.scrollTop = this.panelEl.scrollHeight;
            }
        });

        // 4. Tool Execution Events
        this.session.on("tool.start", (tool) => {
            this.setStatus(tool.name || "Searching");
        });

        this.session.on("tool.update", ({ message }) => {
            if (message) this.setStatus(message);
        });

        // 5. Completion
        this.session.on("complete", ({ elapsed, reasoning }) => {
            if (this.reasoningMarkdown) {
                this.reasoningMarkdown.finish();
            }

            this.stopPresentationLoops();

            // Always finish in compact/collapsed mode by default
            this.isExpanded = false;
            this.element.classList.remove("is-expanded");
            if (this.toggleBtn) {
                this.toggleBtn.setAttribute("aria-expanded", "false");
            }
            if (this.panelEl) {
                this.panelEl.classList.add("ai-hidden");
            }

            this.element.setAttribute("data-state", "complete");

            const exactSeconds = Math.max(
                1,
                elapsed || Math.round((performance.now() - (this.session ? this.session.startedAt : performance.now())) / 1000)
            );

            // Keep the completed status compact.
            this.setStatus(`Thought for ${exactSeconds}s`);

            if (reasoning && reasoning.trim().length > 0) {
                this.element.setAttribute("data-has-reasoning", "true");
            }
        });
    }

    bindUserInteractions() {
        if (!this.toggleBtn) return;

        this.toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.element.getAttribute("data-has-reasoning") !== "true") return;

            this.isExpanded = !this.isExpanded;
            this.element.classList.toggle("is-expanded", this.isExpanded);
            this.toggleBtn.setAttribute("aria-expanded", String(this.isExpanded));

            if (this.isExpanded) {
                this.panelEl.classList.remove("ai-hidden");
            } else {
                this.panelEl.classList.add("ai-hidden");
            }
        });
    }

    startPresentationLoops() {
        if (this.isPresentationRunning) return;
        this.isPresentationRunning = true;
        this.pixelAnimation.start();
    }

    stopPresentationLoops() {
        this.isPresentationRunning = false;
        if (this.pixelAnimation) {
            this.pixelAnimation.stop();
        }
    }

    setStatus(status) {
        if (!status || !this.statusEl) return;
        this.currentStatus = status;
        this.statusEl.textContent = status;
    }

    mount(target) {
        const container = typeof target === "string" ? document.querySelector(target) : target;
        if (!container) return this;
        container.appendChild(this.element);
        this.startPresentationLoops();
        return this;
    }

    getElement() {
        return this.element;
    }

    destroy() {
        this.stopPresentationLoops();
        if (this.pixelAnimation) {
            this.pixelAnimation.destroy();
            this.pixelAnimation = null;
        }
        if (this.reasoningMarkdown) {
            this.reasoningMarkdown.finish();
            this.reasoningMarkdown = null;
        }
        if (this.session) {
            this.session.destroy();
        }
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = ThinkingView;
} else {
    window.ThinkingView = ThinkingView;
}
