/**
 * Streaming controller.
 *
 * It keeps the raw Markdown separate from the DOM and renders through the
 * same MarkdownRenderer used for completed messages.
 */
(function (global) {
    class MarkdownStream {
        constructor(target, options = {}) {
            this.target = typeof target === "string"
                ? document.querySelector(target)
                : target;

            if (!this.target) {
                throw new Error("[MarkdownStream] Target element not found.");
            }

            this.options = {
                preset: "ai-chat",
                ...options
            };

            this.text = "";
            this.renderScheduled = false;
            this.finished = false;
            this._lastRenderTime = 0;
            this._timer = null;
        }

        append(chunk) {
            if (this.finished || !chunk) return;
            this.text += String(chunk);
            this.scheduleRender();
        }

        scheduleRender() {
            if (this.renderScheduled) return;
            this.renderScheduled = true;

            const now = performance.now();
            const elapsed = now - this._lastRenderTime;

            const execute = () => {
                this.renderScheduled = false;
                this._lastRenderTime = performance.now();
                global.MarkdownRenderer.renderInto(this.target, this.text, {
                    ...this.options,
                    streaming: true
                });
            };

            if (elapsed >= 30) {
                requestAnimationFrame(execute);
            } else {
                clearTimeout(this._timer);
                this._timer = setTimeout(() => {
                    requestAnimationFrame(execute);
                }, 30 - elapsed);
            }
        }

        finish() {
            this.finished = true;
            clearTimeout(this._timer);
            this.renderScheduled = false;
            global.MarkdownRenderer.renderInto(this.target, this.text, {
                ...this.options,
                streaming: false
            });
        }

        reset() {
            this.text = "";
            this.finished = false;
            clearTimeout(this._timer);
            this.target.innerHTML = "";
        }

        getText() {
            return this.text;
        }
    }

    global.MarkdownStream = MarkdownStream;
})(window);
