/**
 * Post-render enhancement:
 * - KaTeX math
 */
(function (global) {
    const Enhancer = {
        async run(container, options) {
            if (!container) return;

            const opts = options || {};
            const features = opts.features || {};

            // Skip heavy DOM parsing and diagram compilation during active text streaming
            if (opts.streaming) return;

            if (features.math && typeof renderMathInElement === "function") {
                try {
                    renderMathInElement(container, {
                        delimiters: [
                            { left: "$$", right: "$$", display: true },
                            { left: "\\[", right: "\\]", display: true },
                            { left: "\\(", right: "\\)", display: false },
                            { left: "$", right: "$", display: false }
                        ],
                        throwOnError: false,
                        strict: "ignore"
                    });
                } catch (error) {
                    console.warn("[MarkdownRenderer] Math enhancement failed:", error);
                }
            }
        }
    };

    global.MarkdownEnhancer = Enhancer;
})(window);
