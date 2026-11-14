/**
 * Safe external link renderer with external link icon.
 */
(function (global) {
    const LINK_ICON = '<span class="icon icon-external-link ai-link-icon" aria-hidden="true"></span>';

    global.MarkdownLinkRenderer = {
        render(token, parser) {
            const utils = global.MarkdownUtils;
            const href = utils.safeUrl(token.href);
            const title = token.title
                ? ` title="${utils.escapeHtml(token.title)}"`
                : "";
            const text = token.tokens && parser
                ? parser.parseInline(token.tokens)
                : utils.escapeHtml(token.text || href);

            const external = utils.isExternalProtocol(href);
            return `<a href="${utils.escapeHtml(href)}"${title}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}><span>${text}</span>            ${LINK_ICON}</a>`;
        }
    };
})(window);
