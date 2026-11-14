/**
 * ============================================================================
 * MESSAGE ACTIONS COMPONENT LOGIC (components/message-actions/message-actions.js)
 * Modular Message Action Bar Class (Copy + Relative Timestamp)
 * ============================================================================
 */

class MessageActionBar {
    /**
     * @param {Object} options
     * @param {string} [options.text=""] - The raw message text to copy
     * @param {number} [options.createdAt] - Creation timestamp in ms (defaults to Date.now())
     * @param {Function} [options.onCopy] - Callback when copied
     */
    constructor(options = {}) {
        this.options = {
            ...options
        };
        // Defaults are applied after the spread on purpose. Spreading first
        // would let an explicit `createdAt: undefined` clobber the fallback,
        // which is exactly what produced "NaN days ago" under answers.
        this.options.text = this.options.text || "";
        this.options.createdAt = this.options.createdAt || Date.now();
        this.options.onCopy = this.options.onCopy || null;

        this.timer = null;
        this.element = this.createDOM();
        this.bindEvents();
        this.startTimer();
    }

    /**
     * Format timestamp to relative time string (e.g., 'just now', '3 minutes ago', '2 hours ago')
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
        const footer = document.createElement('div');
        footer.className = 'ai-msg-footer';
        footer.innerHTML = `
            <div class="ai-action-group">
                <button class="ai-action-btn copy-btn" title="Copy response" aria-label="Copy response">
                    <span class="icon icon-copy" aria-hidden="true"></span>
                </button>

                <span class="ai-msg-time" data-ref="time">${this.formatRelativeTime(this.options.createdAt)}</span>
            </div>
        `;
        return footer;
    }

    startTimer() {
        this.timer = setInterval(() => {
            const timeEl = this.element.querySelector('[data-ref="time"]');
            if (timeEl) {
                timeEl.textContent = this.formatRelativeTime(this.options.createdAt);
            }
        }, 30000);
    }

    bindEvents() {
        const copyBtn = this.element.querySelector('.copy-btn');

        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.options.text);
            } catch (_) {
                // Clipboard API can be unavailable in some Electron contexts.
                const textarea = document.createElement('textarea');
                textarea.value = this.options.text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try { document.execCommand('copy'); } catch (__) {}
                textarea.remove();
            }

            copyBtn.classList.add('copied-success');
            copyBtn.innerHTML = '<span class="icon icon-check" aria-hidden="true"></span>';

            if (this.options.onCopy) this.options.onCopy(this.options.text);

            setTimeout(() => {
                copyBtn.classList.remove('copied-success');
                copyBtn.innerHTML = '<span class="icon icon-copy" aria-hidden="true"></span>';
            }, 2000);
        });
    }

    /**
     * Update message text for copy action
     */
    setText(newText) {
        this.options.text = newText;
    }

    /**
     * Get DOM element
     */
    getElement() {
        return this.element;
    }

    /**
     * Mount into target parent DOM node
     */
    mount(targetElement) {
        if (targetElement) {
            targetElement.appendChild(this.element);
        }
    }

    destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MessageActionBar;
} else {
    window.MessageActionBar = MessageActionBar;
}
