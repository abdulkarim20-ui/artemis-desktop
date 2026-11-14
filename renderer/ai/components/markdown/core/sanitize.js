/**
 * DOMPurify boundary.
 * Marked itself does not sanitize HTML, so all generated HTML passes here.
 */
(function (global) {
    const MarkdownSanitizer = {
        sanitize(html) {
            if (typeof DOMPurify === "undefined" || !DOMPurify || typeof DOMPurify.sanitize !== "function") {
                console.warn("[MarkdownRenderer] DOMPurify is not loaded. Falling back to escaped HTML.");
                // Returning the original HTML would turn a missing sanitizer
                // into an XSS hole. Escape everything instead.
                return global.MarkdownUtils
                    ? global.MarkdownUtils.escapeHtml(html)
                    : String(html == null ? "" : html)
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;")
                        .replace(/'/g, "&#039;");
            }

            return DOMPurify.sanitize(html, {
                USE_PROFILES: { html: true, mathMl: true, svg: true },
                ADD_TAGS: ["annotation", "semantics", "math", "mrow", "mi", "mo", "mn", "msup", "msub", "mfrac", "msqrt", "mroot", "mtable", "mtr", "mtd"],
                ADD_ATTR: [
                    "target",
                    "rel",
                    "aria-label",
                    "aria-hidden",
                    "data-code",
                    "data-table",
                    "data-lang",
                    "checked",
                    "disabled",
                    "type"
                ]
            });
        }
    };

    global.MarkdownSanitizer = MarkdownSanitizer;
})(window);
