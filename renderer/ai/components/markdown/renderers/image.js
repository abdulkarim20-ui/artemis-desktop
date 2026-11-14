/**
 * Safe responsive image renderer.
 */
(function (global) {
    global.MarkdownImageRenderer = {
        render(token) {
            const utils = global.MarkdownUtils;
            const href = utils.safeUrl(token.href);
            const src = /^(https?:|blob:)/i.test(href) ? href : "#";
            const alt = utils.escapeHtml(token.text || "");
            const title = token.title
                ? ` title="${utils.escapeHtml(token.title)}"`
                : "";

            return `
<figure class="ai-markdown-image">
    <img src="${utils.escapeHtml(src)}" alt="${alt}" loading="lazy"${title}>
    ${alt ? `<figcaption>${alt}</figcaption>` : ""}
</figure>`.trim();
        }
    };
})(window);
