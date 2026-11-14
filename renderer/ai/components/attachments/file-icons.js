/**
 * ============================================================================
 * FILE TYPE ICONS (components/attachments/file-icons.js)
 * ============================================================================
 * Resolves a filename or File object to the matching SVG icon in this folder.
 *
 * Usage:
 *   FileIcons.getIconPath(file)      -> "../assets/file-icons/code/file-type-js.svg"
 *   FileIcons.getIconMarkup(file)    -> <span class="ai-file-type-icon" ...></span>
 *
 * Icons are applied as CSS masks so they inherit the surrounding text color
 * instead of rendering as black images on a dark background.
 * ============================================================================
 */

(function (global) {
    'use strict';

    const ICON_ROOT = '../assets/file-icons/';

    const EXTENSION_ICONS = Object.freeze({
        // Code
        js: 'code/file-type-js.svg',
        mjs: 'code/file-type-js.svg',
        cjs: 'code/file-type-js.svg',
        jsx: 'code/file-type-jsx.svg',
        ts: 'code/file-type-ts.svg',
        mts: 'code/file-type-ts.svg',
        cts: 'code/file-type-ts.svg',
        tsx: 'code/file-type-tsx.svg',
        py: 'code/file-type-py.svg',
        pyw: 'code/file-type-py.svg',
        rb: 'code/file-type-rb.svg',
        php: 'code/file-type-php.svg',
        java: 'code/file-type-java.svg',
        kt: 'code/file-type-kt.svg',
        kts: 'code/file-type-kt.svg',
        cs: 'code/file-type-cs.svg',
        cpp: 'code/file-type-cpp.svg',
        cc: 'code/file-type-cpp.svg',
        cxx: 'code/file-type-cpp.svg',
        'c++': 'code/file-type-cpp.svg',
        hpp: 'code/file-type-cpp.svg',
        hxx: 'code/file-type-cpp.svg',
        hh: 'code/file-type-cpp.svg',
        c: 'code/file-type-c.svg',
        h: 'code/file-type-c.svg',
        go: 'code/file-type-go.svg',
        rs: 'code/file-type-rs.svg',
        swift: 'code/file-type-swift.svg',
        dart: 'code/file-type-dart.svg',
        scala: 'code/file-type-scala.svg',
        sc: 'code/file-type-scala.svg',
        hs: 'code/file-type-hs.svg',
        lhs: 'code/file-type-hs.svg',
        lua: 'code/file-type-lua.svg',
        pl: 'code/file-type-pl.svg',
        pm: 'code/file-type-pl.svg',
        r: 'code/file-type-r.svg',
        sh: 'code/file-type-sh.svg',
        bash: 'code/file-type-sh.svg',
        zsh: 'code/file-type-sh.svg',
        fish: 'code/file-type-sh.svg',
        ksh: 'code/file-type-sh.svg',
        ex: 'code/file-type-ex.svg',
        exs: 'code/file-type-ex.svg',
        clj: 'code/file-type-clj.svg',
        cljs: 'code/file-type-clj.svg',
        cljc: 'code/file-type-clj.svg',
        edn: 'code/file-type-clj.svg',
        oc: 'code/file-type-oc.svg',
        ml: 'code/file-type-oc.svg',
        mli: 'code/file-type-oc.svg',

        // Web
        css: 'web/file-type-css.svg',
        scss: 'web/file-type-css.svg',
        sass: 'web/file-type-css.svg',
        less: 'web/file-type-css.svg',
        html: 'web/file-type-html.svg',
        htm: 'web/file-type-html.svg',
        vue: 'web/file-type-vue.svg',
        svelte: 'web/file-type-svelte.svg',

        // Data / config
        json: 'data/file-type-json.svg',
        jsonc: 'data/file-type-json.svg',
        json5: 'data/file-type-json.svg',
        yml: 'data/file-type-yml.svg',
        yaml: 'data/file-type-yml.svg',
        toml: 'data/file-type-toml.svg',
        xml: 'data/file-type-xml.svg',
        xsl: 'data/file-type-xml.svg',
        xslt: 'data/file-type-xml.svg',
        csv: 'data/file-type-csv.svg',
        tsv: 'data/file-type-csv.svg',
        sql: 'data/file-type-sql.svg',
        graphql: 'api/file-type-graphql.svg',
        gql: 'api/file-type-graphql.svg',
        proto: 'api/file-type-proto.svg',

        // DevOps
        tf: 'devops/file-type-tf.svg',
        tfvars: 'devops/file-type-tf.svg',
        dockerfile: 'devops/file-type-docker.svg',
        docker: 'devops/file-type-docker.svg',
        env: 'devops/file-type-env.svg',

        // Docs
        md: 'docs/file-type-md.svg',
        markdown: 'docs/file-type-md.svg',
        mdx: 'docs/file-type-md.svg',
        txt: 'docs/file-type-txt.svg',
        text: 'docs/file-type-txt.svg',
        log: 'docs/file-type-txt.svg',
        pdf: 'docs/file-type-pdf.svg',
        doc: 'docs/file-type-doc.svg',
        docx: 'docs/file-type-doc.svg',
        rtf: 'docs/file-type-doc.svg',
        odt: 'docs/file-type-doc.svg',
        xls: 'docs/file-type-xls.svg',
        xlsx: 'docs/file-type-xls.svg',
        ods: 'docs/file-type-xls.svg',
        ppt: 'docs/file-type-ppt.svg',
        pptx: 'docs/file-type-ppt.svg',
        odp: 'docs/file-type-ppt.svg',

        // Media
        jpg: 'media/file-type-jpg.svg',
        jpeg: 'media/file-type-jpg.svg',
        png: 'media/file-type-png.svg',
        gif: 'media/file-type-png.svg',
        webp: 'media/file-type-png.svg',
        bmp: 'media/file-type-png.svg',
        avif: 'media/file-type-png.svg',
        ico: 'media/file-type-png.svg',
        svg: 'media/file-type-svg.svg'
    });

    const FILENAME_ICONS = Object.freeze({
        dockerfile: 'devops/file-type-docker.svg',
        'docker-compose.yml': 'devops/file-type-docker.svg',
        'docker-compose.yaml': 'devops/file-type-docker.svg',
        'compose.yml': 'devops/file-type-docker.svg',
        'compose.yaml': 'devops/file-type-docker.svg',
        '.dockerignore': 'devops/file-type-docker.svg',
        '.gitignore': 'devops/file-type-git.svg',
        '.gitattributes': 'devops/file-type-git.svg',
        '.gitmodules': 'devops/file-type-git.svg',
        '.gitconfig': 'devops/file-type-git.svg',
        '.gitkeep': 'devops/file-type-git.svg',
        'go.mod': 'code/file-type-go.svg',
        'go.sum': 'code/file-type-go.svg',
        'rakefile': 'code/file-type-rb.svg',
        'gemfile': 'code/file-type-rb.svg',
        'vagrantfile': 'code/file-type-rb.svg',
        'readme': 'docs/file-type-md.svg',
        'license': 'docs/file-type-txt.svg',
        'notice': 'docs/file-type-txt.svg',
        'pipfile': 'data/file-type-toml.svg',
        'cargo.lock': 'data/file-type-toml.svg',
        '.bashrc': 'code/file-type-sh.svg',
        '.zshrc': 'code/file-type-sh.svg',
        '.bash_profile': 'code/file-type-sh.svg',
        '.profile': 'code/file-type-sh.svg',
        '.bash_aliases': 'code/file-type-sh.svg'
    });

    const MIME_ICONS = Object.freeze({
        'application/pdf': 'docs/file-type-pdf.svg',
        'application/json': 'data/file-type-json.svg',
        'application/ld+json': 'data/file-type-json.svg',
        'text/json': 'data/file-type-json.svg',
        'text/markdown': 'docs/file-type-md.svg',
        'text/x-markdown': 'docs/file-type-md.svg',
        'text/csv': 'data/file-type-csv.svg',
        'text/tab-separated-values': 'data/file-type-csv.svg',
        'application/xml': 'data/file-type-xml.svg',
        'text/xml': 'data/file-type-xml.svg',
        'text/html': 'web/file-type-html.svg',
        'application/xhtml+xml': 'web/file-type-html.svg',
        'text/css': 'web/file-type-css.svg',
        'text/javascript': 'code/file-type-js.svg',
        'application/javascript': 'code/file-type-js.svg',
        'application/x-javascript': 'code/file-type-js.svg',
        'application/typescript': 'code/file-type-ts.svg',
        'text/typescript': 'code/file-type-ts.svg',
        'application/sql': 'data/file-type-sql.svg',
        'text/sql': 'data/file-type-sql.svg',
        'application/graphql': 'api/file-type-graphql.svg',
        'application/x-yaml': 'data/file-type-yml.svg',
        'application/yaml': 'data/file-type-yml.svg',
        'text/yaml': 'data/file-type-yml.svg',
        'application/toml': 'data/file-type-toml.svg',
        'text/x-python': 'code/file-type-py.svg',
        'text/x-java-source': 'code/file-type-java.svg',
        'text/x-c': 'code/file-type-c.svg',
        'text/x-c++': 'code/file-type-cpp.svg',
        'text/x-csharp': 'code/file-type-cs.svg',
        'text/x-ruby': 'code/file-type-rb.svg',
        'text/x-php': 'code/file-type-php.svg',
        'text/x-shellscript': 'code/file-type-sh.svg',
        'application/x-sh': 'code/file-type-sh.svg',
        'image/jpeg': 'media/file-type-jpg.svg',
        'image/png': 'media/file-type-png.svg',
        'image/svg+xml': 'media/file-type-svg.svg'
    });

    const GENERIC_ICON_PATH = '../assets/icons/file.svg';

    function getFileName(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.name === 'string') return input.name;
        return '';
    }

    function getMimeType(input) {
        if (input && typeof input === 'object' && typeof input.type === 'string') {
            return input.type.toLowerCase();
        }
        return '';
    }

    function getBaseName(name) {
        return String(name || '').split(/[\\/]/).pop() || '';
    }

    function getExtension(name) {
        const base = getBaseName(name).toLowerCase();
        const dot = base.lastIndexOf('.');
        if (dot <= 0 || dot === base.length - 1) return '';
        return base.slice(dot + 1);
    }

    function getIconPath(input) {
        const name = getFileName(input);
        const base = getBaseName(name).toLowerCase();

        if (base) {
            if (FILENAME_ICONS[base]) {
                return ICON_ROOT + FILENAME_ICONS[base];
            }

            // .env, .env.local, .env.production, etc.
            if (base === '.env' || base.startsWith('.env.')) {
                return ICON_ROOT + 'devops/file-type-env.svg';
            }

            // Dockerfile.dev, docker-compose.override.yml, etc.
            if (base.startsWith('dockerfile.') || base.startsWith('docker-compose.') || base.startsWith('compose.')) {
                return ICON_ROOT + 'devops/file-type-docker.svg';
            }
        }

        const extension = getExtension(name);
        if (extension && EXTENSION_ICONS[extension]) {
            return ICON_ROOT + EXTENSION_ICONS[extension];
        }

        const mime = getMimeType(input);
        if (mime && MIME_ICONS[mime]) {
            return ICON_ROOT + MIME_ICONS[mime];
        }

        return null;
    }

    // Two-tone brand: hard split with a small blend (not a muddy gradient).
    const split = (a, b) => `linear-gradient(135deg, ${a} 46%, ${b} 54%)`;
    // Two-tone brand where a smooth gradient is accurate.
    const blend = (a, b) => `linear-gradient(135deg, ${a}, ${b})`;

    // dark = default theme, light = optional override for the light theme.
    // Keys are icon file names, so .js/.mjs/.cjs all share one entry.
    // Generic formats (txt, env, md, toml, ...) stay neutral via currentColor.
    const ICON_COLORS = Object.freeze({
        // Code
        'file-type-js':    { dark: '#F7DF1E', light: '#D9AE00' },
        'file-type-jsx':   { dark: '#61DAFB', light: '#1E9FC4' },
        'file-type-ts':    { dark: '#3178C6' },
        'file-type-tsx':   { dark: '#3178C6' },
        'file-type-py':    { dark: split('#3776AB', '#FFD43B'), light: split('#3776AB', '#E0B400') },
        'file-type-java':  { dark: '#E5322D' },
        'file-type-kt':    { dark: blend('#7F52FF', '#E44857') },
        'file-type-cs':    { dark: '#9B4F96' },
        'file-type-cpp':   { dark: '#4A8FD6', light: '#00599C' },
        'file-type-c':     { dark: '#6A8CC7', light: '#3F5FA3' },
        'file-type-go':    { dark: '#00ADD8' },
        'file-type-rs':    { dark: '#CE422B' },
        'file-type-rb':    { dark: '#CC342D' },
        'file-type-php':   { dark: '#777BB4' },
        'file-type-swift': { dark: '#F05138' },
        'file-type-dart':  { dark: blend('#00B4AB', '#0175C2') },
        'file-type-sh':    { dark: '#4EAA25' },

        // Web
        'file-type-html':   { dark: '#E34F26' },
        'file-type-css':    { dark: '#2965F1' },
        'file-type-vue':    { dark: split('#42B883', '#5B7A99'), light: split('#42B883', '#35495E') },
        'file-type-svelte': { dark: '#FF3E00' },

        // Data / API
        'file-type-json':    { dark: '#E8B339', light: '#C48A00' },
        'file-type-yml':     { dark: '#CB4B4B' },
        'file-type-xml':     { dark: '#3B8EDB' },
        'file-type-csv':     { dark: '#3FA34D' },
        'file-type-sql':     { dark: '#F29111' },
        'file-type-graphql': { dark: '#E10098' },

        // DevOps
        'file-type-docker': { dark: '#2496ED' },
        'file-type-git':    { dark: '#F05032' },

        // Docs
        'file-type-pdf': { dark: '#E5252A' },
        'file-type-doc': { dark: '#2B7BD6', light: '#2B579A' },
        'file-type-xls': { dark: '#2E9E5B', light: '#217346' },
        'file-type-ppt': { dark: '#D24726' },

        // Media
        'file-type-png': { dark: '#A074C4' },
        'file-type-jpg': { dark: '#A074C4' },
        'file-type-svg': { dark: '#FFB13B', light: '#E08A00' }
    });

    function getIconColors(path) {
        if (!path) return null;
        const key = String(path).split('/').pop().replace(/\.svg$/i, '');
        return ICON_COLORS[key] || null;
    }

    function getIconMarkup(input, extraClassName) {
        const path = getIconPath(input);
        const maskUrl = toAbsoluteUrl(path || GENERIC_ICON_PATH);
        const className = ['ai-file-type-icon', extraClassName]
            .filter(Boolean)
            .join(' ');

        const colors = getIconColors(path);
        const colorStyle = colors
            ? `;--file-icon-bg:${colors.dark}${colors.light ? `;--file-icon-bg-light:${colors.light}` : ''}`
            : '';

        return `<span class="${className}" style="--file-icon:url('${maskUrl}')${colorStyle}" aria-hidden="true"></span>`;
    }

    function toAbsoluteUrl(path) {
        if (typeof document !== 'undefined' && document.baseURI) {
            try {
                return new URL(path, document.baseURI).href;
            } catch (_) {
                return path;
            }
        }
        return path;
    }

    const FileIcons = {
        root: ICON_ROOT,
        getFileName,
        getExtension,
        getIconPath,
        getIconColors,
        getIconMarkup
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FileIcons;
    } else {
        global.FileIcons = FileIcons;
    }
})(typeof window !== 'undefined' ? window : globalThis);
