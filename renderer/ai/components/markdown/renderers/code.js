/**
 * AI code block renderer.
 * Handles language, Highlight.js, copy, filename metadata and diff detection.
 */
(function (global) {
    const CodeRenderer = {
        render(token, rendererContext) {
            const utils = global.MarkdownUtils;
            const features = rendererContext.features || {};

            let code = "";
            let lang = "text";
            let meta = "";

            if (token && typeof token === "object") {
                code = token.text || "";
                lang = utils.getLanguage(token.lang);
                meta = token.meta || "";
            } else {
                code = String(token || "");
            }

            const metaParts = String(meta || "").trim().split(/\s+/).filter(Boolean);
            let filename = "";
            for (const part of metaParts) {
                if (/^(file|filename)=/i.test(part)) {
                    filename = part.split("=").slice(1).join("=").replace(/^["']|["']$/g, "");
                }
            }

            const rawLang = token && typeof token === "object" ? String(token.lang || "") : String(rendererContext.infostring || "");

            const isDiff = features.diff && ["diff", "patch", "udiff"].includes(lang);
            const displayLang = isDiff ? "diff" : lang;

            let highlightedHtml;
            if (typeof hljs !== "undefined") {
                try {
                    if (hljs.getLanguage(displayLang) && displayLang !== "diff") {
                        highlightedHtml = hljs.highlight(code, {
                            language: displayLang,
                            ignoreIllegals: true
                        }).value;
                    } else if (displayLang === "diff" && hljs.getLanguage("diff")) {
                        highlightedHtml = hljs.highlight(code, {
                            language: "diff",
                            ignoreIllegals: true
                        }).value;
                    } else {
                        highlightedHtml = hljs.highlightAuto(code).value;
                    }
                } catch (_) {
                    highlightedHtml = utils.escapeHtml(code);
                }
            } else {
                highlightedHtml = utils.escapeHtml(code);
            }

            const encodedCode = utils.encodeAttr(code);
            const headerLabel = filename || displayLang;

            return `
<div class="ai-code-block${isDiff ? " ai-code-block--diff" : ""}" data-code-block>
    <div class="ai-code-block-header" data-code-header>
        <div class="ai-code-meta">
            <span class="icon icon-code ai-code-glyph icon-sm me-2.5 shrink-0" aria-hidden="true"></span>
            <span class="ai-code-lang">${utils.escapeHtml(headerLabel)}</span>
            ${filename ? `<span class="ai-code-type">${utils.escapeHtml(displayLang)}</span>` : ""}
        </div>
    </div>
    <button
        type="button"
        class="ai-code-copy-btn"
        data-code="${encodedCode}"
        aria-label="Copy code"
    >
        <span class="icon icon-copy ai-icon-copy" aria-hidden="true"></span>
        <span class="icon icon-check ai-icon-check" aria-hidden="true"></span>
        <span class="ai-code-tooltip" aria-hidden="true">Copy</span>
    </button>
    <pre><code class="hljs language-${utils.escapeHtml(displayLang)}">${highlightedHtml}</code></pre>
</div>`.trim();
        }
    };

    global.MarkdownCodeRenderer = CodeRenderer;
})(window);
