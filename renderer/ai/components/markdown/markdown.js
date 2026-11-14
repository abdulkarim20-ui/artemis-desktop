/**
 * ============================================================================
 * MODULAR AI MARKDOWN RENDERER
 *
 * Public API:
 *   MarkdownRenderer.render(markdown)
 *   MarkdownRenderer.renderInto(element, markdown, options)
 *   MarkdownRenderer.create(options)
 *
 * Presets:
 *   ai-chat
 *   resume-editor
 *   documentation
 *
 * Dependencies loaded before this file:
 *   marked
 *   highlight.js
 *   DOMPurify
 *   KaTeX + auto-render
 * ============================================================================
 */
(function (global) {
    class MarkdownRenderer {
        constructor(options = {}) {
            this.options = global.MarkdownConfig.resolveOptions(options);
            this.configure();
        }

        configure() {
            if (this._configured || typeof marked === "undefined") return;

            const features = this.options.features;
            const renderer = new marked.Renderer();

            renderer.code = function (token) {
                return features.code
                    ? global.MarkdownCodeRenderer.render(token, {
                        features,
                        renderer: this
                    })
                    : marked.Renderer.prototype.code.call(this, token);
            };

            renderer.table = function (token) {
                return features.tables
                    ? global.MarkdownTableRenderer.render(token, this.parser)
                    : marked.Renderer.prototype.table.call(this, token);
            };

            renderer.blockquote = function (token) {
                return features.callouts
                    ? global.MarkdownBlockquoteRenderer.render(token, this.parser)
                    : marked.Renderer.prototype.blockquote.call(this, token);
            };

            renderer.link = function (token) {
                return features.links
                    ? global.MarkdownLinkRenderer.render(token, this.parser)
                    : marked.Renderer.prototype.link.call(this, token);
            };

            renderer.image = function (token) {
                return features.images
                    ? global.MarkdownImageRenderer.render(token)
                    : marked.Renderer.prototype.image.call(this, token);
            };

            const options = {
                gfm: this.options.gfm,
                breaks: this.options.breaks,
                renderer
            };

            marked.use(options);
            this._configured = true;
        }

        processMath(text) {
            if (!text || typeof katex === "undefined" || !this.options.features?.math) return text;

            // Protect code blocks (``` and `) from math parsing
            const codePlaceholders = [];
            let clean = text.replace(/(```[\s\S]*?```|`[^`\n]+?`)/g, (match) => {
                const id = `@@AI_MATH_CODE_${codePlaceholders.length}@@`;
                codePlaceholders.push(match);
                return id;
            });

            // 1. Display math: $$ ... $$ and \[ ... \]
            clean = clean.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
                try {
                    return katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
                } catch (_) {
                    return match;
                }
            });

            clean = clean.replace(/\\\[([\s\S]+?)\\\]/g, (match, formula) => {
                try {
                    return katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
                } catch (_) {
                    return match;
                }
            });

            // 2. Inline math: \( ... \) and $ ... $
            clean = clean.replace(/\\\(([\s\S]+?)\\\)/g, (match, formula) => {
                try {
                    return katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
                } catch (_) {
                    return match;
                }
            });

            clean = clean.replace(/(^|[^\$\\])\$([^\$\n\r]+?)\$(?!\d)/g, (match, prefix, formula) => {
                if (/^\s|\s$/.test(formula) || !formula.trim()) return match;
                try {
                    return prefix + katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
                } catch (_) {
                    return match;
                }
            });

            // Restore code blocks
            codePlaceholders.forEach((code, i) => {
                clean = clean.replace(`@@AI_MATH_CODE_${i}@@`, () => code);
            });

            return clean;
        }

        render(markdownText) {
            this.configure();

            const text = markdownText == null ? "" : String(markdownText);

            if (typeof marked === "undefined") {
                return `<p>${global.MarkdownUtils.escapeHtml(text)}</p>`;
            }

            const processedText = this.processMath(text);
            let html = marked.parse(processedText);
            return global.MarkdownSanitizer.sanitize(html);
        }

        renderInto(element, markdownText, extraOptions = {}) {
            if (!element) return;

            const merged = {
                ...this.options,
                ...extraOptions,
                features: {
                    ...this.options.features,
                    ...(extraOptions.features || {})
                }
            };

            const html = this.render(markdownText);
            element.innerHTML = html;

            // Render math every pass; it is safe to run because KaTeX replaces
            // only matching text nodes and ignores already-rendered math markup.
            global.MarkdownEnhancer.run(element, merged);

            return html;
        }

        static create(options = {}) {
            return new MarkdownRenderer(options);
        }

        static configure(options = {}) {
            if (!this._instance || options) {
                this._instance = new MarkdownRenderer(options);
            }
            return this._instance;
        }

        static render(markdownText, options = {}) {
            const instance = this.configure(options);
            return instance.render(markdownText);
        }

        static renderInto(element, markdownText, options = {}) {
            const instance = this.configure(options);
            return instance.renderInto(element, markdownText, options);
        }
    }

    // Preserve the old global API used by chat.js and other consumers.
    global.MarkdownRenderer = MarkdownRenderer;

    if (global.MarkdownActions) {
        global.MarkdownActions.bind();
    } else {
        window.addEventListener("load", () => {
            if (global.MarkdownActions) global.MarkdownActions.bind();
        });
    }
})(window);
