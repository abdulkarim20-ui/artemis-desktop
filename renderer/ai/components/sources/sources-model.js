/**
 * Groups retrieval passages into one display entry per source file.
 */
(function (global) {
    'use strict';

    const MAX_SECTIONS = 3;

    const baseName = (value) =>
        String(value || '').split(/[\\/]/).filter(Boolean).pop() || 'Document';

    const extOf = (name) => {
        const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
        return match ? match[1].toUpperCase() : '';
    };

    function group(sources) {
        const files = new Map();

        for (const source of Array.isArray(sources) ? sources : []) {
            if (!source || typeof source !== 'object') continue;
            const key = source.path || 'unknown';
            if (!files.has(key)) {
                const name = baseName(source.path);
                files.set(key, { key, path: source.path || '', name, ext: extOf(name), sections: [], excerpt: '' });
            }
            const file = files.get(key);
            const section = String(source.section || source.heading || source.symbol || '').trim();
            if (section && !file.sections.includes(section) && file.sections.length < MAX_SECTIONS) {
                file.sections.push(section);
            }
            if (!file.excerpt && (source.quote || source.excerpt)) {
                file.excerpt = String(source.quote || source.excerpt);
            }
        }

        return [...files.values()];
    }

    global.SourcesModel = { group, baseName, extOf };
})(typeof window !== 'undefined' ? window : globalThis);
