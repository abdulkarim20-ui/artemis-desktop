/**
 * CHAT COMPONENT LOGIC
 * Uses MarkdownStream/MarkdownRenderer as an isolated rendering layer.
 */
class ChatManager {
    constructor(containerElement) {
        this.container = typeof containerElement === "string"
            ? document.querySelector(containerElement)
            : containerElement;

        this.viewport = this.container.closest(".ai-chat-viewport") || this.container;
        this.inputController = null;
        // Relative-time timers live inside each action bar; track them so
        // destroy() can stop every interval when the view unmounts.
        this._actionBars = new Set();
        this.setupImageModal();
        this.bindImageClicks();
        this.setupScrollListener();
    }

    setInputController(inputController) {
        this.inputController = inputController;
    }

    addUserMessage(data) {
        // Support both older string prompts and the new payload object
        const text = typeof data === 'string' ? data : data.text || '';
        const attachments = typeof data === 'object' ? data.attachments || [] : [];

        // Separate images from other file attachments
        const imageFiles = [];
        const docFiles = [];

        attachments.forEach(file => {
            if (file.type && file.type.startsWith('image/')) {
                imageFiles.push(file);
            } else {
                docFiles.push(file);
            }
        });

        // Generate HTML for attached files based on type and layout
        let attachmentsHtml = '';
        if (attachments.length > 0) {
            attachmentsHtml = '<div class="ai-user-attachments">';

            // Render Image Gallery / Collage Grid
            if (imageFiles.length > 0) {
                const count = imageFiles.length;
                attachmentsHtml += `<div class="ai-user-image-grid" data-count="${count}">`;
                imageFiles.forEach(file => {
                    const url = URL.createObjectURL(file);
                    attachmentsHtml += `
                        <div class="ai-user-img-cell">
                            <img src="${url}" alt="${this.escapeHtml(file.name || 'User uploaded image')}" loading="lazy" />
                        </div>
                    `;
                });
                attachmentsHtml += '</div>';
            }

            // Render Document Chips (compact, wrap in a row)
            if (docFiles.length > 0) {
                const MAX_DOC_CHIPS = 6;
                const visibleDocs = docFiles.length > MAX_DOC_CHIPS + 1
                    ? docFiles.slice(0, MAX_DOC_CHIPS)
                    : docFiles;
                const hiddenDocs = docFiles.slice(visibleDocs.length);
                const fallbackIcon = '<span class="icon icon-file ai-fallback-file-icon" aria-hidden="true"></span>';

                attachmentsHtml += '<div class="ai-user-docs">';
                visibleDocs.forEach(file => {
                    const name = file.name || 'Document';
                    const icon = typeof FileIcons !== 'undefined'
                        ? FileIcons.getIconMarkup(file, 'ai-doc-file-icon')
                        : fallbackIcon;

                    attachmentsHtml += `
                        <div class="ai-user-attachment-doc" title="${this.escapeHtml(name)}">
                            <div class="ai-doc-icon">${icon}</div>
                            <span class="ai-doc-name">${this.escapeHtml(name)}</span>
                        </div>
                    `;
                });

                if (hiddenDocs.length > 0) {
                    const listed = hiddenDocs.slice(0, 40).map(f => f.name || 'file').join('\n')
                        + (hiddenDocs.length > 40 ? `\n…and ${hiddenDocs.length - 40} more` : '');
                    attachmentsHtml += `
                        <div class="ai-user-attachment-doc ai-user-attachment-more" title="${this.escapeHtml(listed)}">
                            <div class="ai-doc-icon">${fallbackIcon}</div>
                            <span class="ai-doc-name">+${hiddenDocs.length} more</span>
                        </div>
                    `;
                }
                attachmentsHtml += '</div>';
            }

            attachmentsHtml += '</div>';
        }

        const row = document.createElement("div");
        row.className = "ai-msg-row user";
        
        // Only render the text bubble if text exists, allowing image-only messages
        row.innerHTML = `
            <div class="ai-user-message">
                ${attachmentsHtml}
                ${text.trim() ? `<div class="ai-user-bubble">${this.escapeHtml(text)}</div>` : ''}
                <div class="ai-user-actions-mount" data-ref="user-actions"></div>
            </div>
        `;
        this.container.appendChild(row);

        const mount = row.querySelector('[data-ref="user-actions"]');
        if (typeof UserMessageActions !== "undefined" && mount) {
            const actions = new UserMessageActions({
                text: text,
                // Restored messages keep their original time instead of "just now".
                createdAt: (typeof data === 'object' && data.createdAt) || Date.now()
            });
            actions.mount(mount);
            this._actionBars.add(actions);
        }

        this.scrollToBottom(true);
        return { row, text };
    }

    /**
     * Show the user what the model could not see.
     *
     * buildFileContext() returns an honest note for every skipped or truncated
     * attachment. Those notes reach the model inside <attached_files>; without
     * this call they never reach the user, and "it answered about the wrong
     * part of my file" becomes impossible to diagnose.
     *
     * Calling this twice on the same row appends to the existing box rather than
     * adding a second one. A message can generate notes from two places - files
     * buildFileContext() could not read, and files the knowledge base could not
     * index - and two stacked boxes would read as two separate problems with the
     * same message rather than one list of attachments that fell short.
     *
     * @param {HTMLElement} row  the row returned by addUserMessage()
     * @param {string[]} warnings
     */
    showFileNotes(row, warnings) {
        if (!row || !Array.isArray(warnings) || warnings.length === 0) return null;

        const existing = row.querySelector('.ai-file-note');
        const notes = existing?._notes ? existing._notes.concat(warnings) : warnings.slice();

        const list = `<ul class="ai-file-note-list">${
            notes.map((note) => `<li>${this.escapeHtml(note)}</li>`).join("")
        }</ul>`;

        let note = existing;
        if (!note) {
            note = document.createElement("div");
            note.className = "ai-file-note";

            const actions = row.querySelector('.ai-user-actions-mount');
            if (actions) actions.before(note);
            else row.querySelector('.ai-user-message')?.appendChild(note);
        }

        // Kept on the element so a later call can extend the same list. The row
        // already carries _thinkingView/_thinkingAnimation the same way.
        note._notes = notes;
        note.innerHTML = notes.length === 1
            ? `<span class="ai-file-note-label">Part of this was not sent</span>${list}`
            : `<details class="ai-file-note-details"><summary>${notes.length} attachment notes</summary>${list}</details>`;

        return note;
    }

    /**
     * Show which knowledge-base passages the answer appears to rely on.
     *
     * Retrieval is invisible otherwise: the passages are injected into the user
     * turn server-side, so without this the user cannot tell whether an answer
     * came from their documents or from the model's own memory - and cannot
     * check a citation against the file it claims to come from.
     *
     * A search error remains visible; empty or unused results stay hidden.
     * Grouping lives in SourcesModel, the DOM in SourcesView.
     *
     * @param {object} controller  the object returned by initiateEmptyAssistantResponse()
     * @param {{ kind: 'hits'|'error', hits?: number, dropped?: number, sources?: Array<object>,
     *   skipped?: string|null, collection?: string, message?: string }} info
     */
    showSources(controller, info) {
        const mount = controller?.sourcesMount;
        if (!mount || !info) return null;

        mount.innerHTML = "";

        if (info.kind === "error") {
            const node = SourcesView.renderNote("Couldn’t search your documents for this answer.", "error");
            mount.appendChild(node);
            return node;
        }

        const sources = Array.isArray(info.sources) ? info.sources : [];

        if (!sources.length) return null;

        const label = info.mode === "inferred" ? "Related files" : "Sources";
        const box = SourcesView.render(SourcesModel.group(sources), { label });
        if (!box) return null;

        mount.appendChild(box);
        return box;
    }

    startThinking(options = {}) {
        const id = "thinking-" + Date.now();
        const row = document.createElement("div");
        row.className = "ai-msg-row assistant has-thinking";
        row.id = id;

        let session = null;
        let view = null;

        if (typeof ThinkingView !== "undefined" && typeof ThinkingSession !== "undefined") {
            session = new ThinkingSession({
                capabilities: options.capabilities || { reasoningSummary: true, tools: true },
                model: options.model
            });
            session.id = id;

            view = new ThinkingView(session);

            row.appendChild(view.getElement());
            row._thinkingView = view;
            row._thinkingSession = session;
        } else if (typeof ThinkingPixelAnimation !== "undefined") {
            const animation = new ThinkingPixelAnimation();
            row.appendChild(animation.getElement());
            row._thinkingAnimation = animation;
        } else {
            throw new Error("ThinkingPixelAnimation is not loaded.");
        }

        this.container.appendChild(row);

        // Start presentation loops after DOM mount
        if (view && typeof view.startPresentationLoops === "function") {
            requestAnimationFrame(() => {
                if (row.isConnected) {
                    view.startPresentationLoops();
                }
            });
        } else if (row._thinkingAnimation && typeof row._thinkingAnimation.start === "function") {
            requestAnimationFrame(() => {
                if (row.isConnected && row._thinkingAnimation) {
                    row._thinkingAnimation.start();
                }
            });
        }

        this.scrollToBottom(true);
        return session || id;
    }

    showThinking(options = {}) {
        return this.startThinking(options);
    }

    finishThinking(sessionOrId) {
        if (!sessionOrId) return;
        if (typeof sessionOrId === "object" && typeof sessionOrId.finish === "function") {
            sessionOrId.finish();
            return;
        }
        const el = typeof sessionOrId === "string" ? document.getElementById(sessionOrId) : null;
        if (el && el._thinkingSession) {
            el._thinkingSession.finish();
        } else if (el && el._thinkingAnimation) {
            el._thinkingAnimation.stop();
        }
    }

    removeThinking(sessionOrId) {
        if (!sessionOrId) return;
        const id = typeof sessionOrId === "object" ? sessionOrId.id : sessionOrId;
        const el = id ? document.getElementById(id) : null;
        if (el) {
            if (el._thinkingView && typeof el._thinkingView.destroy === "function") {
                el._thinkingView.destroy();
            } else if (el._thinkingAnimation && typeof el._thinkingAnimation.destroy === "function") {
                el._thinkingAnimation.destroy();
            }
            el.remove();
        }
    }

    initiateEmptyAssistantResponse() {
        const row = document.createElement("div");
        row.className = "ai-msg-row assistant";

        row.innerHTML = `
            <div class="ai-assistant-wrapper">
                <div class="ai-response-message ai-markdown ai-typing-cursor" data-ref="content"></div>
                <div data-ref="sources-mount"></div>
                <div data-ref="footer-mount"></div>
            </div>`;

        this.container.appendChild(row);
        this.scrollToBottom(true);

        return {
            row,
            contentEl: row.querySelector('[data-ref="content"]'),
            sourcesMount: row.querySelector('[data-ref="sources-mount"]'),
            footerMount: row.querySelector('[data-ref="footer-mount"]'),
            accumulatedText: "",
            markdownStream: null,
            // The action bar under the finished answer shows a relative time
            // ("just now", "3 hours ago") built from this. Without it the bar
            // received undefined and rendered "NaN days ago".
            createdAt: Date.now()
        };
    }

    appendChunkToResponse(controller, textChunk) {
        if (!controller || !controller.contentEl || !textChunk) return;

        controller.accumulatedText += textChunk;

        // Keep a single MarkdownStream instance per assistant response.
        if (!controller.markdownStream) {
            controller.markdownStream = new MarkdownStream(
                controller.contentEl,
                { preset: "ai-chat" }
            );
        }

        controller.markdownStream.append(textChunk);
        this.scrollToBottom(false);
    }

    finalizeResponse(controller) {
        if (!controller || !controller.contentEl || controller.isFinalized) return;
        controller.isFinalized = true;

        if (controller.markdownStream) {
            controller.markdownStream.finish();
        } else {
            MarkdownRenderer.renderInto(
                controller.contentEl,
                controller.accumulatedText,
                { preset: "ai-chat", streaming: false }
            );
        }

        controller.contentEl.classList.remove("ai-typing-cursor");

        if (typeof MessageActionBar !== "undefined" && controller.footerMount) {
            controller.footerMount.innerHTML = "";
            const actionBar = new MessageActionBar({
                text: controller.accumulatedText,
                createdAt: controller.createdAt
            });
            actionBar.mount(controller.footerMount);
            this._actionBars.add(actionBar);
        }

        this.scrollToBottom(true);
    }

    async addAssistantResponse({ text }) {
        const controller = this.initiateEmptyAssistantResponse();

        const words = String(text || "").split(" ");
        for (let i = 0; i < words.length; i++) {
            this.appendChunkToResponse(
                controller,
                (i === 0 ? "" : " ") + words[i]
            );
            await new Promise(r => setTimeout(r, 15));
        }

        this.finalizeResponse(controller);
    }

    scrollToBottom(smooth = false) {
        if (!this.viewport) return;

        if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);

        this._scrollRAF = requestAnimationFrame(() => {
            if (smooth) {
                this.viewport.scrollTo({
                    top: this.viewport.scrollHeight,
                    behavior: "smooth"
                });
            } else {
                this.viewport.scrollTop = this.viewport.scrollHeight;
            }
        });
    }

    setupScrollListener() {
        if (!this.viewport) return;

        // Create floating scroll-to-bottom button
        const scrollBtn = document.createElement("button");
        scrollBtn.type = "button";
        scrollBtn.className = "ai-scroll-bottom-btn";
        scrollBtn.title = "Scroll to bottom";
        scrollBtn.setAttribute("aria-label", "Scroll to bottom");
        scrollBtn.innerHTML = '<span class="icon icon-chevron-down" aria-hidden="true"></span>';

        const appShell = this.viewport.closest(".ai-app-shell") || document.body;
        const inputDock = appShell.querySelector(".ai-input-dock");
        if (inputDock) {
            inputDock.appendChild(scrollBtn);
        } else {
            appShell.appendChild(scrollBtn);
        }

        scrollBtn.addEventListener("click", () => {
            this.scrollToBottom(true);
        });

        this.viewport.addEventListener("scroll", () => {
            const distanceToBottom = this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight;
            if (distanceToBottom > 120) {
                scrollBtn.classList.add("is-visible");
            } else {
                scrollBtn.classList.remove("is-visible");
            }
        }, { passive: true });

        this._scrollBtn = scrollBtn;
    }

    setupImageModal() {
        if (document.getElementById("ai-image-modal")) return;

        const modal = document.createElement("div");
        modal.id = "ai-image-modal";
        modal.className = "ai-image-modal ai-hidden";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-label", "Image Preview");

        modal.innerHTML = `
            <div class="ai-image-modal-backdrop" data-action="close"></div>
            <div class="ai-image-modal-content">
                <button type="button" class="ai-image-modal-close" data-action="close" aria-label="Close image preview">
                    <span class="icon icon-close" aria-hidden="true"></span>
                </button>
                <div class="ai-image-modal-img-wrap">
                    <img class="ai-image-modal-img" src="" alt="Enlarged image preview" />
                </div>
                <div class="ai-image-modal-caption"></div>
            </div>
        `;

        document.body.appendChild(modal);

        const modalImg = modal.querySelector(".ai-image-modal-img");
        const captionEl = modal.querySelector(".ai-image-modal-caption");

        const closeModal = () => {
            modal.classList.add("ai-hidden");
            modalImg.src = "";
            captionEl.textContent = "";
            document.body.classList.remove("ai-modal-open");
        };

        modal.addEventListener("click", (e) => {
            if (e.target.closest('[data-action="close"]')) {
                closeModal();
            }
        });

        this._onModalKeydown = (e) => {
            if (e.key === "Escape" && !modal.classList.contains("ai-hidden")) {
                closeModal();
            }
        };
        document.addEventListener("keydown", this._onModalKeydown);

        this._imageModal = modal;

        this.openImageModal = (src, alt = "") => {
            modalImg.src = src;
            modalImg.alt = alt || "Enlarged preview";
            captionEl.textContent = alt && alt !== "User uploaded image" ? alt : "";
            modal.classList.remove("ai-hidden");
            document.body.classList.add("ai-modal-open");
        };
    }

    bindImageClicks() {
        if (!this.container) return;
        this._onImageClick = (e) => {
            const img = e.target.closest(".ai-user-img-cell img, .ai-user-attachment-img img, .ai-markdown-image img");
            if (img && img.src && this.openImageModal) {
                e.preventDefault();
                this.openImageModal(img.src, img.alt);
            }
        };
        this.container.addEventListener("click", this._onImageClick);
    }

    destroy() {
        if (this._onImageClick && this.container) {
            this.container.removeEventListener("click", this._onImageClick);
            this._onImageClick = null;
        }
        if (this._scrollRAF) {
            cancelAnimationFrame(this._scrollRAF);
            this._scrollRAF = null;
        }
        if (this._scrollBtn && this._scrollBtn.parentNode) {
            this._scrollBtn.parentNode.removeChild(this._scrollBtn);
            this._scrollBtn = null;
        }
        // The image modal is created once per ChatManager; remove it with the view.
        if (this._imageModal && this._imageModal.parentNode) {
            this._imageModal.parentNode.removeChild(this._imageModal);
            this._imageModal = null;
        }
        if (this._onModalKeydown) {
            document.removeEventListener("keydown", this._onModalKeydown);
            this._onModalKeydown = null;
        }
        document.body.classList.remove("ai-modal-open");

        // Stop per-message action timers (relative timestamps).
        this._actionBars.forEach((bar) => {
            try {
                bar.destroy?.();
            } catch (_) {}
        });
        this._actionBars.clear();

        // Thinking views and per-message controllers are owned by the DOM that
        // the view removes, so stop their timers as well.
        if (this.container) {
            this.container.querySelectorAll(".ai-msg-row").forEach((row) => {
                try {
                    row._thinkingView?.destroy?.();
                    row._thinkingAnimation?.destroy?.();
                } catch (_) {}
            });
        }
    }

    escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = ChatManager;
} else {
    window.ChatManager = ChatManager;
}
