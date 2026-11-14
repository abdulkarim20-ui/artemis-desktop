/**
 * Markdown renderer configuration.
 * All features are opt-in through presets/options.
 */
(function (global) {
    const DEFAULT_FEATURES = {
        code: true,
        tables: true,
        links: true,
        images: true,
        taskLists: true,
        callouts: true,
        math: true,
        diff: true
    };

    const PRESETS = {
        "ai-chat": {
            gfm: true,
            breaks: true,
            features: { ...DEFAULT_FEATURES }
        },
        "resume-editor": {
            gfm: true,
            breaks: true,
            features: {
                ...DEFAULT_FEATURES
            }
        },
        "documentation": {
            gfm: true,
            breaks: false,
            features: { ...DEFAULT_FEATURES }
        }
    };

    function resolveOptions(options) {
        const preset = options && options.preset
            ? (PRESETS[options.preset] || PRESETS["ai-chat"])
            : PRESETS["ai-chat"];

        return {
            gfm: preset.gfm,
            breaks: preset.breaks,
            ...preset,
            ...(options || {}),
            features: {
                ...preset.features,
                ...((options && options.features) || {})
            }
        };
    }

    global.MarkdownConfig = {
        DEFAULT_FEATURES,
        PRESETS,
        resolveOptions
    };
})(window);
