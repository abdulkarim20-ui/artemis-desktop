/**
 * ============================================================================
 * INPUT COMPONENT LOGIC (components/input/ai-input.js)
 * Standalone, zero-dependency, production-grade UI Component Class
 *
 * ============================================================================
 */

class AIInputBox {
    // The composer grows to this many lines, then scrolls internally.
    static MAX_LINES = 5;

    /**
     * @param {HTMLElement|string} target - The DOM element or selector to mount into
     * @param {Object} options - Configuration options
     * @param {string} [options.placeholder="How can I help you today?"] - Textarea placeholder
     * @param {string} [options.modelName="GPT OSS 120B"] - Initial model name
     * @param {string} [options.modelTier=""] - Initial model tier
     * @param {Array<Object>} [options.models] - Available models for dropdown
     * @param {Function} [options.onSend] - Callback when user submits prompt
     * @param {Function} [options.onModelChange] - Callback when model changes
     * @param {Function} [options.onAttachment] - Callback when file/plus is clicked
     * @param {Function} [options.onMic] - Callback when the microphone control is clicked
     */
    constructor(target, options = {}) {
        this.container = typeof target === 'string' ? document.querySelector(target) : target;
        if (!this.container) {
            throw new Error(`[AIInputBox] Target element not found: ${target}`);
        }

        const savedModel = typeof ModelSelector !== 'undefined' ? ModelSelector.getSavedModel() : null;
        const initialModelName = options.modelName || savedModel?.name || "GPT OSS 120B";

        this.options = {
            placeholder: options.placeholder || "How can I help you today?",
            mode: options.mode || "chat",
            modelId: options.modelId || savedModel?.id || null,
            modelName: initialModelName,
            onSend: options.onSend || null,
            onModeChange: options.onModeChange || null,
            onModelChange: options.onModelChange || null,
            onAttachment: options.onAttachment || null,
            ...options
        };

        this.state = {
            mode: this.options.mode,
            model: savedModel || null,
            modelName: initialModelName,
            modelTier: "",
            attachments: [],
            isModelMenuOpen: false,
            isPlusMenuOpen: false,
            docked: false,
            micBusy: false
        };
        this.micMessage = '';

        this.render();
        this.bindEvents();
    }

    render() {
        const modelIconClass = typeof ModelSelector !== 'undefined' && this.state.model
            ? ModelSelector.getModelIconClass(this.state.model)
            : '';

        this.container.innerHTML = `
            <div class="ai-input-component">
                <div class="ai-input-card">
                    <!-- Short status line (for example "Switched to a vision model") -->
                    <div class="ai-input-notice ai-hidden" data-ref="notice" role="status" aria-live="polite"></div>

                    <!-- Optional Attachment Previews -->
                    <div class="ai-attachments-preview ai-hidden" data-ref="attachments"></div>

                    <!-- Single-row composer: plus, prompt, voice controls -->
                    <div class="ai-input-main">
                        <!-- Left Controls: Plus Button -->
                        <div class="ai-plus-btn-wrap" data-ref="plusBtnWrap">
                                <button class="ai-btn-icon" data-ref="plusBtn" title="Add attachment" aria-label="Add attachment" aria-haspopup="true">
                                    <span class="icon icon-plus" aria-hidden="true"></span>
                                </button>

                                <!-- Clean Focused Drop-up Context Menu -->
                                <div class="ai-dropdown-menu align-left ai-hidden" data-ref="plusMenu">
                                    <button class="ai-dropdown-item" data-action="upload-file">
                                        <span class="ai-menu-left">
                                            <span class="icon icon-paperclip ai-menu-icon" aria-hidden="true"></span>
                                            Add files or photos
                                        </span>
                                        <span class="ai-menu-right-text">Ctrl U</span>
                                    </button>
                                </div>
                            </div>

                            <textarea
                                class="ai-textarea"
                                placeholder="${this.options.placeholder}"
                                rows="1"
                                data-ref="textarea"
                                aria-label="AI Prompt Input"
                            ></textarea>

                            <!-- Right controls: model, mic, send -->
                            <div class="ai-toolbar-right">
                                <div class="ai-model-badge-wrap" data-ref="modelBadgeWrap">
                                    <button class="ai-model-badge" data-ref="modelBadge" title="Change AI Model" aria-label="Selected Model" aria-haspopup="true">
                                        <span class="icon ai-model-current-icon ${modelIconClass}" data-ref="modelIcon" aria-hidden="true" ${modelIconClass ? '' : 'hidden'}></span>
                                        <span class="ai-model-name" data-ref="modelName">${this.formatModelName(this.state.modelName)}</span>
                                        <span class="ai-model-tier" data-ref="modelTier" style="${this.state.modelTier ? '' : 'display: none;'}">${this.state.modelTier}</span>
                                        <span class="icon icon-chevron-down ai-model-chevron" aria-hidden="true"></span>
                                    </button>
                                </div>

                                <div class="ai-voice-active-bar" data-ref="voiceActive" role="group" aria-label="Recording audio. Cancel to discard or finish to transcribe." hidden>
                                    <div class="ai-voice-wave" data-ref="voiceWave" aria-hidden="true">
                                        <canvas class="ai-voice-wave-canvas" data-ref="voiceWaveCanvas"></canvas>
                                    </div>
                                    <button type="button" class="ai-voice-action-btn ai-voice-cancel-btn" data-ref="voiceCancel" title="Cancel recording" aria-label="Cancel recording">
                                        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                    </button>
                                    <button type="button" class="ai-voice-action-btn ai-voice-done-btn" data-ref="voiceDone" title="Finish recording" aria-label="Finish recording and transcribe">
                                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                            <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                    </button>
                                </div>

                                <div class="ai-action-slot" data-ref="actionSlot">
                                <button type="button" class="ai-mic-btn" data-ref="micBtn" data-tooltip="Voice input" aria-label="Voice input">
                                    <span class="icon icon-microphone ai-mic-icon" aria-hidden="true"></span>
                                </button>

                                <button type="button" class="ai-send-btn ai-hidden" data-ref="sendBtn" data-tooltip="Send message" data-tooltip-kbd="Enter" aria-label="Send prompt">
                                    <span class="icon icon-arrow-up" aria-hidden="true"></span>
                                </button>
                            </div>

                        </div>
                    </div>
                </div>

                <div class="ai-mic-status" data-ref="micStatus" role="status" aria-live="polite"></div>

                <!-- Footer: disclaimer + model selector, shown only when docked -->
                <div class="ai-input-footer">
                    <span class="ai-input-disclaimer">Artemis is AI and can make mistakes. Please double-check responses.</span>
                </div>

                <!-- Hidden file input for attachments -->
                <input type="file" data-ref="fileInput" multiple style="display: none;" />
            </div>
        `;

        this.el = {
            root: this.container.querySelector('.ai-input-component'),
            textarea: this.container.querySelector('[data-ref="textarea"]'),
            plusBtn: this.container.querySelector('[data-ref="plusBtn"]'),
            toolbarRight: this.container.querySelector('.ai-toolbar-right'),
            footer: this.container.querySelector('.ai-input-footer'),
            modelBadgeWrap: this.container.querySelector('[data-ref="modelBadgeWrap"]'),
            modelBadge: this.container.querySelector('[data-ref="modelBadge"]'),
            modelIcon: this.container.querySelector('[data-ref="modelIcon"]'),
            modelName: this.container.querySelector('[data-ref="modelName"]'),
            modelTier: this.container.querySelector('[data-ref="modelTier"]'),
            actionSlot: this.container.querySelector('[data-ref="actionSlot"]'),
            micBtn: this.container.querySelector('[data-ref="micBtn"]'),
            voiceActive: this.container.querySelector('[data-ref="voiceActive"]'),
            voiceCancel: this.container.querySelector('[data-ref="voiceCancel"]'),
            voiceDone: this.container.querySelector('[data-ref="voiceDone"]'),
            voiceWaveCanvas: this.container.querySelector('[data-ref="voiceWaveCanvas"]'),
            micStatus: this.container.querySelector('[data-ref="micStatus"]'),
            sendBtn: this.container.querySelector('[data-ref="sendBtn"]'),
            fileInput: this.container.querySelector('[data-ref="fileInput"]'),
            notice: this.container.querySelector('[data-ref="notice"]'),
            attachments: this.container.querySelector('[data-ref="attachments"]'),
            modelMenu: null,
            plusMenu: this.container.querySelector('[data-ref="plusMenu"]')
        };

        this.voiceWaveform = typeof VoiceWaveform !== 'undefined' && this.el.voiceWaveCanvas
            ? new VoiceWaveform(this.el.voiceWaveCanvas)
            : null;

        // Initialize Modular AIAttachments Component
        this.attachmentsManager = typeof AIAttachments !== 'undefined'
            ? new AIAttachments(this.el.attachments, {
                maxFiles: 100,
                onChange: (files) => {
                    this.toggleSendButton();
                    if (typeof this.options.onAttachmentsChange === 'function') {
                        this.options.onAttachmentsChange(files);
                    }
                }
            })
            : null;

        // Initialize Modular ModelSelector Component
        const modelSelectorOptions = {
            selectedModel: this.options.modelId || null,
            onOpen: () => {
                this.closeAllMenus();
            },
            onSelect: (model) => {
                this.state.model = model;
                this.state.modelName = model.name;
                this.state.modelTier = "";
                this.setModel(model.name, "", model);
                if (typeof this.options.onModelChange === 'function') {
                    this.options.onModelChange(model);
                }
            }
        };

        if (this.options.modelDataSource) {
            modelSelectorOptions.dataSource = this.options.modelDataSource;
        }

        this.modelSelector = typeof ModelSelector !== 'undefined'
            ? new ModelSelector(this.el.modelBadgeWrap || this.el.root, modelSelectorOptions)
            : null;
    }

    bindEvents() {
        // 1. Textarea Input & Auto-expand (Switches to straight send button on typing)
        this.el.textarea.addEventListener('input', () => {
            this.updateSendButtonIcon('straight');
            this.adjustHeight();
            this.toggleSendButton();
        });

        // Clipboard image paste support
        // Allows screenshots copied with Win+Shift+S / Print Screen / Snipping Tool
        // to be pasted directly into the AI input as an attachment.
        this.el.textarea.addEventListener('paste', (e) => {
            const clipboardItems = Array.from(e.clipboardData?.items || []);

            const imageFiles = [];

            for (const item of clipboardItems) {
                if (item.kind !== 'file') continue;

                const file = item.getAsFile();
                if (!file) continue;

                // Only intercept actual image clipboard data.
                if (file.type && file.type.startsWith('image/')) {
                    imageFiles.push(file);
                }
            }

            // No image in clipboard -> keep normal textarea paste behavior.
            if (imageFiles.length === 0) {
                return;
            }

            // Prevent the browser from trying to insert the image into the textarea.
            e.preventDefault();

            // Add the screenshot through the existing attachment pipeline.
            this.addAttachments(imageFiles);

            // Make sure the UI immediately switches to the send state.
            this.updateSendButtonIcon('straight');
            this.adjustHeight();
            this.toggleSendButton();

            if (typeof this.options.onAttachment === 'function') {
                this.options.onAttachment(imageFiles);
            }
        });

        // Close open menus when clicking or focusing the textarea
        this.el.textarea.addEventListener('focus', () => {
            this.closeAllMenus();
        });
        this.el.textarea.addEventListener('click', () => {
            this.closeAllMenus();
        });

        // 2. Keyboard shortcuts: Enter to send, Shift+Enter for new line, Ctrl+U to upload
        this.el.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.send();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
                e.preventDefault();
                this.el.fileInput.click();
            }
        });

        // Global shortcut Ctrl+U inside container
        this.el.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && typeof this.options.onMicCancel === 'function' && this.options.onMicCancel()) {
                e.preventDefault();
                e.stopPropagation();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
                e.preventDefault();
                this.el.fileInput.click();
            }
        });

        // 3. Send Button Click
        this.el.sendBtn.addEventListener('click', () => {
            this.send();
        });

        // 5. Microphone: a hook until real voice input exists.
        if (this.el.micBtn) {
            this.el.micBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (typeof this.options.onMic === 'function') this.options.onMic();
            });
        }
        this.el.voiceCancel.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof this.options.onMicCancel === 'function') this.options.onMicCancel();
        });
        this.el.voiceDone.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof this.options.onMicStop === 'function') this.options.onMicStop();
        });

        // 6. Plus Button Click (Toggle Drop-up Menu)
        this.el.plusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePlusMenu();
        });

        // Plus Menu Items & Actions
        this.el.plusMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.ai-dropdown-item');
            if (!item) return;
            const action = item.dataset.action;

            if (action === 'upload-file') {
                this.el.fileInput.click();
                this.closeAllMenus();
            }
        });

        // File Input Change
        this.el.fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            this.addAttachments(files);
            if (this.options.onAttachment) {
                this.options.onAttachment(files);
            }
        });

        // 7. Model Badge Click (Delegate to ModelSelector or fallback)
        if (this.el.modelBadge && !this.modelSelector) {
            this.el.modelBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleModelMenu();
                this.el.modelBadge.blur();
            });
        }

        // Model Menu selection (Fallback)
        if (this.el.modelMenu) {
            this.el.modelMenu.addEventListener('click', (e) => {
                const item = e.target.closest('.ai-dropdown-item');
                if (!item) return;
                const name = item.dataset.model;
                const tier = item.dataset.tier;
                this.setModel(name, tier);
                this.closeAllMenus();
            });
        }

        // Close menus when clicking outside their respective trigger & dropdown
        this._onDocumentClick = (e) => {
            // Plus Menu: close if click was not inside plus button or plus menu
            if (this.el.plusMenu && !this.el.plusMenu.classList.contains('ai-hidden')) {
                const clickedPlus = this.el.plusBtn && this.el.plusBtn.contains(e.target);
                const clickedMenu = this.el.plusMenu.contains(e.target);
                if (!clickedPlus && !clickedMenu) {
                    this.el.plusMenu.classList.add('ai-hidden');
                }
            }

            // Fallback Model Menu: close if click was not inside model badge or model menu
            if (this.el.modelMenu && !this.el.modelMenu.classList.contains('ai-hidden')) {
                const clickedBadge = this.el.modelBadge && this.el.modelBadge.contains(e.target);
                const clickedMenu = this.el.modelMenu.contains(e.target);
                if (!clickedBadge && !clickedMenu) {
                    this.el.modelMenu.classList.add('ai-hidden');
                }
            }
        };
        document.addEventListener('click', this._onDocumentClick);
    }

    setMode(mode) {
        if (this.state.mode === mode) return;
        this.state.mode = mode;
        if (this.options.onModeChange) {
            this.options.onModeChange(mode);
        }
    }

    adjustHeight() {
        const textarea = this.el.textarea;
        if (!textarea) return;

        // Grow with the text, but never past five lines. After that the
        // textarea keeps its height and grows a slim internal scrollbar.
        // The cap is measured from the live font metrics so the fresh and
        // docked states (different font sizes) both end on exactly five lines.
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(textarea) : null;
        const fontSize = parseFloat(style?.fontSize) || 16;
        const lineHeight = parseFloat(style?.lineHeight) || fontSize * 1.5;
        const verticalPadding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
        const maxHeight = Math.round(lineHeight * AIInputBox.MAX_LINES + verticalPadding);

        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
        textarea.style.overflowY = textarea.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
    }

    updateSendButtonIcon(type = 'straight') {
        this.state.sendButtonType = type;
        if (!this.el.sendBtn) return;

        if (type === 'curved') {
            this.el.sendBtn.innerHTML = '<span class="icon icon-undo" aria-hidden="true"></span>';
            this.el.sendBtn.classList.add('ai-send-btn-curved');
        } else {
            this.el.sendBtn.innerHTML = '<span class="icon icon-arrow-up" aria-hidden="true"></span>';
            this.el.sendBtn.classList.remove('ai-send-btn-curved');
        }
    }

    toggleSendButton() {
        const hasAttachments = this.attachmentsManager ? this.attachmentsManager.getCount() > 0 : false;
        const hasText = this.el.textarea.value.trim().length > 0 || hasAttachments;
        if (this.el.sendBtn) this.el.sendBtn.classList.toggle('ai-hidden', this.state.micBusy || !hasText);
    }

    toggleModelMenu() {
        if (this.el.plusMenu) this.el.plusMenu.classList.add('ai-hidden');
        if (this.modelSelector) {
            this.modelSelector.toggle();
        } else if (this.el.modelMenu) {
            this.el.modelMenu.classList.toggle('ai-hidden');
        }
    }

    togglePlusMenu() {
        if (this.modelSelector) this.modelSelector.close();
        if (this.el.modelMenu) this.el.modelMenu.classList.add('ai-hidden');
        if (this.el.plusMenu) this.el.plusMenu.classList.toggle('ai-hidden');
    }

    closeAllMenus() {
        if (this.modelSelector) this.modelSelector.close();
        if (this.el.modelMenu) this.el.modelMenu.classList.add('ai-hidden');
        if (this.el.plusMenu) this.el.plusMenu.classList.add('ai-hidden');
    }

    /**
     * Switch between the fresh-chat rectangle and the docked chat pill.
     * The docked state moves the model selector to the footer. Recording
     * controls stay in the composer, while a fresh chat places them by the model.
     */
    setDocked(docked) {
        const next = Boolean(docked);
        if (this.state.docked === next && this.el.root.classList.contains('is-docked') === next) {
            return;
        }

        this.state.docked = next;
        this.closeAllMenus();
        this.el.root.classList.toggle('is-docked', next);

        const badge = this.el.modelBadgeWrap;
        const actionSlot = this.el.actionSlot;
        const target = next ? this.el.footer : this.el.toolbarRight;

        if (badge && target && badge.parentElement !== target) {
            if (next) {
                target.appendChild(badge);
            } else if (actionSlot && actionSlot.parentElement === target) {
                target.insertBefore(badge, actionSlot);
            } else {
                target.appendChild(badge);
            }
        }

        const voiceTarget = next ? actionSlot : this.el.toolbarRight;
        if (this.el.voiceActive && voiceTarget && this.el.voiceActive.parentElement !== voiceTarget) {
            if (next && this.el.micBtn?.parentElement === voiceTarget) {
                voiceTarget.insertBefore(this.el.voiceActive, this.el.micBtn);
            } else if (!next && actionSlot?.parentElement === voiceTarget) {
                voiceTarget.insertBefore(this.el.voiceActive, actionSlot);
            } else {
                voiceTarget.appendChild(this.el.voiceActive);
            }
        }
        badge.hidden = Boolean(this.el.micBtn?.classList.contains('is-recording') && !next);

        // The layout swap changes available width (and the textarea's row),
        // so recompute the auto-grown height after the DOM settles.
        requestAnimationFrame(() => {
            this.adjustHeight();
            this.toggleSendButton();
        });
    }

    formatModelName(name) {
        if (!name) return '';
        // Wrap digits / numbers (e.g. 5.1, 5, 4.5, 3.7) in accent color span
        return String(name).replace(/(\d+(?:\.\d+)?)/g, '<span class="ai-model-version">$1</span>');
    }

    setModel(name, tier = "", model = this.state.model) {
        if (model) {
            this.state.model = model;
        }
        this.state.modelName = name;
        this.state.modelTier = tier;
        const iconClass = typeof ModelSelector !== 'undefined' && model
            ? ModelSelector.getModelIconClass(model)
            : '';
        if (this.el.modelIcon) {
            this.el.modelIcon.className = `icon ai-model-current-icon${iconClass ? ` ${iconClass}` : ''}`;
            this.el.modelIcon.hidden = !iconClass;
        }
        if (this.el.modelName) {
            this.el.modelName.innerHTML = this.formatModelName(name);
        }
        if (this.el.modelTier) {
            this.el.modelTier.textContent = tier;
            this.el.modelTier.style.display = tier ? 'inline' : 'none';
        }

        if (this.options.onModelChange) {
            this.options.onModelChange({ name, tier });
        }
    }

    addAttachments(files) {
        if (this.attachmentsManager) {
            this.attachmentsManager.addFiles(files);
        }
        this.toggleSendButton();
    }

    removeAttachment(index) {
        if (this.attachmentsManager) {
            this.attachmentsManager.removeFile(index);
        }
        this.toggleSendButton();
    }

    getAttachments() {
        return this.attachmentsManager ? this.attachmentsManager.getFiles() : [];
    }

    getModels() {
        return this.modelSelector ? this.modelSelector.getModels() : [];
    }

    getModel() {
        return this.state.model;
    }

    /** Select a model by id. Use { persist: false } for automatic switches. */
    selectModelById(id, options) {
        if (this.modelSelector) this.modelSelector.selectModel(id, options);
    }

    showNotice(text, { tone = 'info', timeout = 7000 } = {}) {
        const el = this.el.notice;
        if (!el) return;
        clearTimeout(this._noticeTimer);
        el.textContent = text;
        el.dataset.tone = tone;
        el.classList.remove('ai-hidden');
        if (timeout > 0) {
            this._noticeTimer = setTimeout(() => this.hideNotice(), timeout);
        }
    }

    hideNotice() {
        if (this.el.notice) this.el.notice.classList.add('ai-hidden');
    }

    clearAttachments() {
        if (this.attachmentsManager) {
            this.attachmentsManager.clear();
        }
        this.toggleSendButton();
    }

    send() {
        if (this.state.micBusy) return;
        const text = this.el.textarea.value.trim();
        const attachments = this.getAttachments();

        if (!text && attachments.length === 0) return;

        if (typeof this.options.beforeSend === 'function') {
            const verdict = this.options.beforeSend({ text, attachments, model: this.state.model });
            if (verdict && verdict.allow === false) {
                if (verdict.message) this.showNotice(verdict.message, { tone: 'warn' });
                return; // text and attachments stay exactly where they are
            }
        }

        const payload = {
            text,
            mode: this.state.mode,
            // Never send a model name as a fake model object: the backend
            // resolves models by id and rejects unknown names. Null lets the
            // backend fall back to its configured default model.
            model: this.state.model ? {
                id: this.state.model.id,
                provider: this.state.model.provider,
                model: this.state.model.model,
                name: this.state.model.name,
                capabilities: this.state.model.capabilities
            } : null,
            attachments
        };

        this.el.textarea.value = '';
        this.updateSendButtonIcon('straight');
        this.clearAttachments();
        this.adjustHeight();
        this.toggleSendButton();

        if (this.options.onSend) {
            this.options.onSend(payload);
        }
    }

    getValue() {
        return this.el.textarea.value;
    }

    setValue(val) {
        this.el.textarea.value = val;
        this.adjustHeight();
        this.toggleSendButton();
    }

    insertText(text) {
        const textarea = this.el.textarea;
        const value = textarea.value;
        const start = textarea.selectionStart ?? value.length;
        const end = textarea.selectionEnd ?? value.length;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const separator = before && !/\s$/.test(before) ? ' ' : '';
        const inserted = String(text || '');
        const next = `${before}${separator}${inserted}${after}`;

        textarea.value = next;
        const caret = before.length + separator.length + inserted.length;
        textarea.setSelectionRange(caret, caret);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    startMicWaveform(stream) {
        if (this.voiceWaveform) {
            void this.voiceWaveform.start(stream);
        }
    }

    setMicState(state) {
        const button = this.el.micBtn;
        if (!button) return;
        const recording = state === 'recording';
        this.state.micBusy = state !== 'idle';
        const wasActiveControlFocused = this.el.voiceActive.contains(document.activeElement);

        const labels = {
            idle: 'Voice input',
            requesting: 'Requesting microphone',
            recording: 'Stop recording',
            transcribing: 'Transcribing audio'
        };
        button.classList.toggle('is-requesting', state === 'requesting');
        button.classList.toggle('is-recording', recording);
        button.classList.toggle('is-transcribing', state === 'transcribing');
        button.disabled = state === 'requesting' || state === 'transcribing';
        button.setAttribute('aria-pressed', String(state === 'recording'));
        button.setAttribute('aria-label', labels[state] || labels.idle);
        button.title = this.micMessage || labels[state] || labels.idle;
        button.dataset.tooltip = this.micMessage || labels[state] || labels.idle;
        this.el.modelBadgeWrap.hidden = recording && !this.state.docked;
        this.el.voiceActive.hidden = !recording;
        button.hidden = recording;
        this.el.sendBtn.disabled = this.state.micBusy;
        this.toggleSendButton();
        if (recording) {
            this.el.voiceDone.focus();
        } else if (wasActiveControlFocused) {
            this.el.textarea.focus();
        }
        if (!recording) {
            this.el.root.classList.remove('has-audio-level');
            this.voiceWaveform?.stop();
        }
    }

    setMicLevel(level) {
        const normalized = Math.max(0, Math.min(1, Number(level) || 0));
        this.el.root.classList.add('has-audio-level');
        this.voiceWaveform?.setLevel(normalized);
    }

    setMicMessage(message) {
        this.micMessage = message || '';
        const status = this.el.micStatus;
        if (!status) return;
        status.textContent = this.micMessage;
        if (this.el.micBtn) {
            const label = this.micMessage || this.el.micBtn.getAttribute('aria-label') || 'Voice input';
            this.el.micBtn.title = label;
            this.el.micBtn.dataset.tooltip = label;
        }
    }

    focus() {
        this.el.textarea.focus();
    }

    clear() {
        this.setValue('');
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    destroy() {
        clearTimeout(this._noticeTimer);
        // Detach global listeners so navigating away from the chat view does
        // not keep this instance (and the whole AI view) alive.
        if (this._onDocumentClick) {
            document.removeEventListener('click', this._onDocumentClick);
            this._onDocumentClick = null;
        }

        if (this.modelSelector && typeof this.modelSelector.destroy === 'function') {
            this.modelSelector.destroy();
        }
        if (this.attachmentsManager && typeof this.attachmentsManager.clear === 'function') {
            this.attachmentsManager.clear();
        }
        if (this.voiceWaveform && typeof this.voiceWaveform.destroy === 'function') {
            this.voiceWaveform.destroy();
            this.voiceWaveform = null;
        }

        if (this.container) {
            this.container.innerHTML = '';
        }
        this.el = {};
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AIInputBox;
} else {
    window.AIInputBox = AIInputBox;
}
