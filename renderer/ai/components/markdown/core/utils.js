/**
 * Small DOM/string utilities shared by the renderer modules.
 */
(function (global) {
    const Utils = {
        escapeHtml(value) {
            const div = document.createElement("div");
            div.textContent = value == null ? "" : String(value);
            return div.innerHTML;
        },

        encodeAttr(value) {
            return encodeURIComponent(value == null ? "" : String(value));
        },

        decodeAttr(value) {
            try { return decodeURIComponent(value); }
            catch (_) { return value || ""; }
        },

        uid(prefix) {
            return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        },

        getLanguage(info) {
            return String(info || "")
                .trim()
                .split(/\s+/)[0]
                .toLowerCase() || "text";
        },

        isExternalProtocol(href) {
            return /^(https?:|mailto:|tel:)/i.test(String(href || ""));
        },

        safeUrl(href) {
            const value = String(href || "").trim();
            if (!value) return "#";

            // Block javascript:, vbscript:, and data: URLs from model/user content.
            if (/^(javascript|vbscript|data):/i.test(value)) return "#";

            return value;
        }
    };

    global.MarkdownUtils = Utils;
})(window);
