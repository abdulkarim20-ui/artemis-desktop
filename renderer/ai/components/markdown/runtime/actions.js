/**
 * Delegated interactive actions for all MarkdownRenderer instances.
 */
(function (global) {
    const Actions = {
        _bound: false,

        bind() {
            if (this._bound) return;
            this._bound = true;

            document.addEventListener("click", async (event) => {
                const codeBtn = event.target.closest(".ai-code-copy-btn");
                const tableBtn = event.target.closest(".ai-table-copy-btn");
                const button = codeBtn || tableBtn;
                if (!button) return;

                let textToCopy = "";
                if (codeBtn) {
                    textToCopy = global.MarkdownUtils.decodeAttr(codeBtn.dataset.code || "");
                } else if (tableBtn) {
                    textToCopy = global.MarkdownUtils.decodeAttr(tableBtn.dataset.table || "");
                    if (!textToCopy) {
                        const tableWrap = tableBtn.closest(".ai-table-wrap");
                        const table = tableWrap ? tableWrap.querySelector("table") : null;
                        if (table) {
                            const rows = Array.from(table.querySelectorAll("tr"));
                            textToCopy = rows.map(tr => {
                                const cells = Array.from(tr.querySelectorAll("th, td"));
                                return "| " + cells.map(c => c.innerText.trim()).join(" | ") + " |";
                            }).join("\n");
                        }
                    }
                }

                if (!textToCopy) return;

                try {
                    await navigator.clipboard.writeText(textToCopy);
                } catch (_) {
                    const textarea = document.createElement("textarea");
                    textarea.value = textToCopy;
                    textarea.style.position = "fixed";
                    textarea.style.opacity = "0";
                    document.body.appendChild(textarea);
                    textarea.select();
                    try { document.execCommand("copy"); } catch (__) {}
                    textarea.remove();
                }

                this.flashCopied(button);
            });
        },

        flashCopied(button) {
            const copy = button.querySelector(".ai-icon-copy");
            const check = button.querySelector(".ai-icon-check");
            const label = button.querySelector(".ai-copy-label");
            const tooltip = button.querySelector(".ai-code-tooltip");

            button.classList.add("copied");
            if (copy) copy.style.display = "none";
            if (check) check.style.display = "block";
            if (label) label.textContent = "Copied!";
            if (tooltip) tooltip.textContent = "Copied!";

            clearTimeout(button._copyTimer);
            button._copyTimer = setTimeout(() => {
                button.classList.remove("copied");
                if (copy) copy.style.display = "block";
                if (check) check.style.display = "none";
                if (label) label.textContent = "Copy";
                if (tooltip) tooltip.textContent = "Copy";
            }, 1600);
        }
    };

    global.MarkdownActions = Actions;
})(window);
