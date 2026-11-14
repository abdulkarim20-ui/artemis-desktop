/**
 * ============================================================================
 * USER MESSAGE ACTIONS COMPONENT (components/message-actions/user-message-actions.js)
 * Standalone, reusable User Message Action Bar Class
 * Features: Relative Timestamp + Copy
 * ============================================================================
 */

class UserMessageActions {
    constructor(options = {}) {
        this.options = {
            ...options
        };
        // Same ordering as MessageActionBar: defaults after the spread, so an
        // explicit undefined cannot clobber them.
        this.options.text = String(this.options.text || "");
        this.options.createdAt = this.options.createdAt || Date.now();
        this.options.onCopy = this.options.onCopy || null;

        this.timer = null;
        this.element = this.createDOM();
        this.bindEvents();
        this.startTimer();
    }

    /**
     * Format timestamp into human-readable relative time (e.g. 'just now', '3 minutes ago')
     * @param {number} timestamp 
     * @returns {string}
     */
    formatRelativeTime(timestamp) {
        // A missing or junk timestamp must never render as "NaN days ago".
        if (!Number.isFinite(timestamp)) return "just now";
        const now = Date.now();
        const diffInSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));

        if (diffInSeconds < 60) {
            return "just now";
        }
        const diffInMinutes = Math.floor(diffInSeconds / 60);
        if (diffInMinutes === 1) {
            return "1 minute ago";
        }
        if (diffInMinutes < 60) {
            return `${diffInMinutes} minutes ago`;
        }
        const diffInHours = Math.floor(diffInMinutes / 60);
        if (diffInHours === 1) {
            return "1 hour ago";
        }
        if (diffInHours < 24) {
            return `${diffInHours} hours ago`;
        }
        const diffInDays = Math.floor(diffInHours / 24);
        if (diffInDays === 1) {
            return "yesterday";
        }
        return `${diffInDays} days ago`;
    }

    createDOM() {
        const footer = document.createElement("div");
        footer.className = "ai-user-message-actions";
        footer.innerHTML = `
            <span class="ai-user-action-time">${this.formatRelativeTime(this.options.createdAt)}</span>
            <div class="ai-user-action-buttons">
                <button
                    type="button"
                    class="ai-user-action-btn user-copy-btn"
                    title="Copy prompt"
                    aria-label="Copy prompt"
                >
                    <span class="icon icon-copy" aria-hidden="true"></span>
                </button>
            </div>
        `;
        return footer;
    }

    startTimer() {
        this.timer = setInterval(() => {
            const timeEl = this.element.querySelector(".ai-user-action-time");
            if (timeEl) {
                timeEl.textContent = this.formatRelativeTime(this.options.createdAt);
            }
        }, 30000);
    }

    bindEvents() {
        const copyButton = this.element.querySelector(".user-copy-btn");

        if (copyButton) {
            copyButton.addEventListener("click", () => {
                this.copy();
            });
        }
    }

    async copy() {
        try {
            await navigator.clipboard.writeText(this.options.text);
            this.showCopiedState();
            if (typeof this.options.onCopy === "function") {
                this.options.onCopy(this.options.text);
            }
        } catch (error) {
            console.warn("[UserMessageActions] Clipboard failed", error);
            this.fallbackCopy();
        }
    }

    fallbackCopy() {
        const textarea = document.createElement("textarea");
        textarea.value = this.options.text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
        } catch (_) {
            // Ignore clipboard fallback failure.
        }
        textarea.remove();
        this.showCopiedState();
    }

    showCopiedState() {
        const button = this.element.querySelector(".user-copy-btn");
        if (!button) return;

        const original = button.innerHTML;
        button.classList.add("is-copied");
        button.innerHTML = '<span class="icon icon-check" aria-hidden="true"></span>';

        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
            button.classList.remove("is-copied");
            button.innerHTML = original;
        }, 1600);
    }

    mount(target) {
        if (target) {
            target.appendChild(this.element);
        }
    }

    setText(text) {
        this.options.text = String(text || "");
    }

    destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        clearTimeout(this.copyTimer);
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = UserMessageActions;
} else {
    window.UserMessageActions = UserMessageActions;
}
