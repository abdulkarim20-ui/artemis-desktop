/**
 * Premium table renderer.
 */
(function (global) {
    global.MarkdownTableRenderer = {
        render(token, parser) {
            const utils = global.MarkdownUtils;

            const renderCell = (cell, tag) => {
                const content = cell.tokens && parser
                    ? parser.parseInline(cell.tokens)
                    : (cell.text || "");
                const align = cell.align ? ` align="${utils.escapeHtml(cell.align)}"` : "";
                return `<${tag}${align}>${content}</${tag}>`;
            };

            const headerCells = token.header || [];
            const rowsList = token.rows || [];

            const headerHtml = headerCells
                .map(cell => renderCell(cell, "th"))
                .join("");

            const rowsHtml = rowsList
                .map(row => `<tr>${row.map(cell => renderCell(cell, "td")).join("")}</tr>`)
                .join("\n");

            // Build Markdown string for the clipboard
            let markdownTable = "";
            if (token.raw && typeof token.raw === "string") {
                markdownTable = token.raw.trim();
            } else {
                const headerText = headerCells.map(c => (c.text || "").replace(/\|/g, "\\|").trim());
                const alignText = headerCells.map(c => {
                    if (c.align === "center") return ":---:";
                    if (c.align === "right") return "---:";
                    return "---";
                });
                const rowsText = rowsList.map(row =>
                    "| " + row.map(c => (c.text || "").replace(/\|/g, "\\|").trim()).join(" | ") + " |"
                );
                markdownTable = [
                    "| " + headerText.join(" | ") + " |",
                    "| " + alignText.join(" | ") + " |",
                    ...rowsText
                ].join("\n");
            }

            const encodedTable = utils.encodeAttr(markdownTable);

            return `
<div class="ai-table-wrap">
    <button
        type="button"
        class="ai-table-copy-btn"
        data-table="${encodedTable}"
        aria-label="Copy table"
    >
        <span class="icon icon-copy ai-icon-copy" aria-hidden="true"></span>
        <span class="icon icon-check ai-icon-check" aria-hidden="true"></span>
        <span class="ai-code-tooltip" aria-hidden="true">Copy</span>
    </button>
    <table class="ai-markdown-table">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
    </table>
</div>`.trim();
        }
    };
})(window);
