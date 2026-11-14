/**
 * ============================================================================
 * MODEL SELECTOR (components/model-selector/model-selector.js)
 * ============================================================================
 * Dynamic model registry UI driven by backend GET /api/models.
 * Persists user model selection in localStorage for reload continuity.
 * Displays 3 visible models with clean scrollbar for additional items.
 * ============================================================================
 */

const AGENT_PORT = Number(globalThis.appConfig?.agentPort) || 3000;

class ModelSelector {
    static STORAGE_KEY = "artemis-selected-model-id";
    static STORAGE_META_KEY = "artemis-selected-model-meta";
    static MODEL_ICON_CLASS = "icon-model";

    // Vendor marks live in assets/model-icons. Order matters: the first brand
    // whose token appears in the registry metadata wins.
    static MODEL_BRANDS = [
        { icon: "icon-brand-qwen", tokens: ["qwen"] },
        { icon: "icon-brand-nvidia", tokens: ["nvidia", "nemotron"] },
        { icon: "icon-brand-openai", tokens: ["openai", "gpt"] }
    ];

    static getModelBrand(model) {
        if (!model) return null;
        const haystack = [model.family, model.name, model.model, model.provider, model.id]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        return ModelSelector.MODEL_BRANDS.find(brand =>
            brand.tokens.some(token => haystack.includes(token))
        ) || null;
    }

    static getModelIconClass(model) {
        return ModelSelector.getModelBrand(model)?.icon || ModelSelector.MODEL_ICON_CLASS;
    }

    // Keep saved selections working after a registry model is replaced.
    static LEGACY_MODEL_IDS = {
        "nvidia:nvidia/nemotron-3-super-120b-a12b": {
            id: "nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b",
            name: "Nemotron 3.5 Super VL 120B",
            provider: "nvidia",
            providerLabel: "NVIDIA",
            model: "nvidia/nemotron-3.5-super-vl-120b-a12b"
        }
    };

    /**
     * Retrieves the persisted model from storage if available
     * @returns {{ id: string, name?: string, provider?: string, providerLabel?: string, model?: string } | null}
     */
    static getSavedModel() {
        try {
            const raw = localStorage.getItem(ModelSelector.STORAGE_META_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.id) {
                    const replacement = ModelSelector.LEGACY_MODEL_IDS[parsed.id];
                    return replacement ? { ...parsed, ...replacement } : parsed;
                }
            }
            const id = localStorage.getItem(ModelSelector.STORAGE_KEY);
            if (!id) return null;
            const replacement = ModelSelector.LEGACY_MODEL_IDS[id];
            return replacement ? { ...replacement } : { id };
        } catch (_) {
            return null;
        }
    }

    /**
     * Persists the selected model to storage
     * @param {Object} model
     */
    static saveModel(model) {
        if (!model || !model.id) return;
        try {
            localStorage.setItem(ModelSelector.STORAGE_KEY, model.id);
            localStorage.setItem(ModelSelector.STORAGE_META_KEY, JSON.stringify({
                id: model.id,
                name: model.name,
                provider: model.provider,
                providerLabel: model.providerLabel,
                model: model.model,
                family: model.family
            }));
        } catch (_) {}
    }

    constructor(target, options = {}) {
        this.container = typeof target === "string" ? document.querySelector(target) : target;
        if (!this.container) {
            throw new Error(`[ModelSelector] Target element not found: ${target}`);
        }

        const savedModel = ModelSelector.getSavedModel();

        this.options = {
            dataSource: options.dataSource || `http://127.0.0.1:${AGENT_PORT}/api/models`,
            selectedModel: options.selectedModel || savedModel?.id || null,
            onSelect: options.onSelect || (() => {}),
            ...options
        };

        this.state = {
            isOpen: false,
            selectedModel: this.options.selectedModel,
            models: []
        };

        this.el = {
            menu: null
        };

        this._eventsBound = false;
        this._onDocumentClick = null;
        this.init();
    }

    async init() {
        await this.loadModels();

        // Validate that saved/requested model exists in registry, otherwise fallback
        if (this.state.models.length) {
            const exists = this.state.models.some(m => m.id === this.state.selectedModel);
            if (!exists) {
                this.state.selectedModel = this.state.models[0].id;
            }
        }

        this.render();
        this.bindEvents();

        // Fire initial selection callback so parent components synchronize immediately
        const initial = this.getSelectedModel();
        if (initial) {
            ModelSelector.saveModel(initial);
            if (typeof this.options.onSelect === "function") {
                this.options.onSelect({ ...initial });
            }
        }
    }

    async refresh() {
        await this.loadModels();
        if (!this.state.models.some(model => model.id === this.state.selectedModel)) {
            this.state.selectedModel = this.state.models[0]?.id || null;
        }
        this.render();
        this.updateSelectionUI();
    }

    async loadModels() {
        // The local AI agent may still be starting when the view mounts.
        // Retry briefly before giving up instead of showing an empty menu.
        const attempts = 6;
        let lastError = null;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const separator = this.options.dataSource.includes("?") ? "&" : "?";
                const response = await fetch(`${this.options.dataSource}${separator}v=${Date.now()}`);
                if (!response.ok) {
                    throw new Error(`Failed to load models: ${response.status}`);
                }
                const json = await response.json();
                const models = Array.isArray(json.models) ? json.models : [];
                this.state.models = models.filter(
                    model => model && model.id && model.provider && model.model && model.name
                );

                if (!this.state.selectedModel) {
                    this.state.selectedModel = json.defaultModel || this.state.models[0]?.id || null;
                }
                return;
            } catch (error) {
                lastError = error;
                if (attempt < attempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 400 + attempt * 250));
                }
            }
        }

        console.error("[ModelSelector] Failed to load model registry:", lastError);
        this.state.models = [];
    }

    getSelectedModel() {
        return this.state.models.find(model => model.id === this.state.selectedModel) || null;
    }

    getModels() {
        return this.state.models.slice();
    }

    updateModelBadge(model) {
        const badge = this.container.querySelector("[data-ref='modelBadge']");
        if (!badge) return;

        if (model) badge.setAttribute("data-model-id", model.id);
        else badge.removeAttribute("data-model-id");

        const icon = badge.querySelector("[data-ref='modelIcon']");
        if (!icon) return;

        const iconClass = model ? ModelSelector.getModelIconClass(model) : "";
        icon.className = `icon ai-model-current-icon${iconClass ? ` ${iconClass}` : ""}`;
        icon.hidden = !iconClass;
    }

    formatModelName(name) {
        if (!name) return "";
        return String(name).replace(/(\d+(?:\.\d+)?)/g, '<span class="ai-model-version-accent">$1</span>');
    }

    escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    render() {
        const existing = this.container.querySelector(".ai-model-selector-menu");
        if (existing) {
            existing.remove();
        }

        const menu = document.createElement("div");
        menu.className = `ai-model-selector-menu ${this.state.isOpen ? "" : "ai-hidden"}`;
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "Select AI model");

        const selected = this.getSelectedModel();

        menu.innerHTML = `
            <div class="ai-model-selector-header">
                <span class="ai-model-selector-title">Model</span>
            </div>
            <div class="ai-model-selector-list">
                ${this.state.models.length
                    ? this.state.models.map(model => this.renderModel(model)).join("")
                    : `<div class="ai-model-empty">No models available</div>`
                }
            </div>
        `;

        this.container.appendChild(menu);
        this.el.menu = menu;

        this.updateModelBadge(selected);
    }

    renderModel(model) {
        const selected = model.id === this.state.selectedModel;
        const iconClass = ModelSelector.getModelIconClass(model);

        return `
            <button
                type="button"
                role="menuitemradio"
                aria-checked="${selected}"
                class="ai-model-option ${selected ? "is-selected" : ""}"
                data-model-id="${this.escapeHtml(model.id)}"
            >
                <span class="ai-model-option-main">
                    ${iconClass
                        ? `<span class="icon ${iconClass} ai-model-provider-icon" aria-hidden="true"></span>`
                        : ""
                    }
                    <span class="ai-model-option-name">${this.formatModelName(model.name)}</span>
                    ${model.capabilities && model.capabilities.vision ? '<span class="ai-model-cap" title="Can read images">Vision</span>' : ''}
                </span>
                <span class="ai-model-option-meta">
                    ${selected
                        ? `<span class="ai-model-checkmark" aria-hidden="true">
                            <span class="icon icon-check" aria-hidden="true"></span>
                        </span>`
                        : ""
                    }
                </span>
            </button>
        `;
    }

    bindEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;

        // Delegate from the stable container so the menu keeps working after
        // render()/refresh() replaces the menu element.
        this.container.addEventListener("click", event => {
            const option = event.target.closest(".ai-model-option[data-model-id]");
            if (!option) return;
            event.stopPropagation();
            this.selectModel(option.dataset.modelId);
            option.blur();
        });

        const badge = this.container.querySelector("[data-ref='modelBadge']");
        if (badge) {
            badge.addEventListener("click", event => {
                event.stopPropagation();
                this.toggle();
                badge.blur();
            });
        }

        this._onDocumentClick = event => {
            if (this.state.isOpen && !this.container.contains(event.target)) {
                this.close();
            }
        };
        document.addEventListener("click", this._onDocumentClick);
    }

    destroy() {
        if (this._onDocumentClick) {
            document.removeEventListener("click", this._onDocumentClick);
            this._onDocumentClick = null;
        }
        if (this.el.menu) {
            this.el.menu.remove();
            this.el.menu = null;
        }
        this._eventsBound = false;
    }

    updateSelectionUI() {
        if (!this.el.menu) return;
        const options = this.el.menu.querySelectorAll("[data-model-id]");
        options.forEach(option => {
            const isSelected = option.dataset.modelId === this.state.selectedModel;
            option.classList.toggle("is-selected", isSelected);
            option.setAttribute("aria-checked", isSelected ? "true" : "false");

            const meta = option.querySelector(".ai-model-option-meta");
            if (meta) {
                const existingCheck = meta.querySelector(".ai-model-checkmark");
                const existingArrow = meta.querySelector(".ai-model-option-arrow");
                if (existingArrow) existingArrow.remove();
                if (isSelected) {
                    if (!existingCheck) {
                        meta.insertAdjacentHTML("beforeend", `
                            <span class="ai-model-checkmark" aria-hidden="true">
                                <span class="icon icon-check" aria-hidden="true"></span>
                            </span>
                        `);
                    }
                } else {
                    if (existingCheck) existingCheck.remove();
                }
            }
        });

        const selected = this.getSelectedModel();
        this.updateModelBadge(selected);
    }

    selectModel(modelId, { persist = true, close = true } = {}) {
        const model = this.state.models.find(item => item.id === modelId);
        if (!model) {
            console.warn(`[ModelSelector] Unknown model: ${modelId}`);
            return;
        }

        this.state.selectedModel = model.id;

        // Auto-switches (for example to read an image) must not overwrite the
        // user's saved default model.
        if (persist) ModelSelector.saveModel(model);

        this.updateSelectionUI();
        if (close) this.close();

        if (typeof this.options.onSelect === "function") {
            this.options.onSelect({ ...model });
        }
    }

    open() {
        if (typeof this.options.onOpen === "function") {
            this.options.onOpen();
        }
        this.state.isOpen = true;
        if (this.el.menu) {
            this.el.menu.classList.remove("ai-hidden");
        }
        const badge = this.container.querySelector("[data-ref='modelBadge']");
        badge?.setAttribute("aria-expanded", "true");
    }

    close() {
        this.state.isOpen = false;
        if (this.el.menu) {
            this.el.menu.classList.add("ai-hidden");
        }
        const badge = this.container.querySelector("[data-ref='modelBadge']");
        badge?.setAttribute("aria-expanded", "false");
    }

    toggle() {
        if (this.state.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    getSelected() {
        return this.getSelectedModel();
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = ModelSelector;
} else {
    window.ModelSelector = ModelSelector;
}
