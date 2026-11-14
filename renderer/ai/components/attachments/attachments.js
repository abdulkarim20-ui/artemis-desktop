/**
 * ============================================================================
 * ATTACHMENTS COMPONENT LOGIC (components/attachments/attachments.js)
 * Compact tray (never grows) + expandable files panel.
 *
 * Public API is unchanged: addFiles, removeFile, getFiles, getCount, clear,
 * onChange, onRemove, mount.
 * ============================================================================
 */

class AIAttachments {
    static IGNORED_DIRS = new Set([
        'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
        '.cache', '.parcel-cache', '__pycache__', '.pytest_cache', 'venv', '.venv',
        'coverage', '.idea', '.gradle', 'vendor', 'bower_components', '.turbo'
    ]);

    static IGNORED_FILES = new Set([
        '.ds_store', 'thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'composer.lock', 'cargo.lock', 'poetry.lock', 'gemfile.lock'
    ]);

    /**
     * Files Artemis never reads. Office documents and text-based PDFs must NOT be
     * added here: the local converter turns them into Markdown, and folder uploads
     * would silently drop them (the format list lives in renderer/js/ai/file-context.js,
     * sourced from shared/document-formats.js).
     * This only decides what a FOLDER upload keeps; hand-picked files are always kept.
     */
    static BINARY_EXT = new Set([
        'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
        'zip', 'rar', '7z',
        'tar', 'gz', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'eot',
        'mp3', 'mp4', 'mov', 'avi', 'wav', 'webm', 'bin',
        'class', 'jar', 'pyc', 'map'
    ]);

    static X_ICON = '<span class="icon icon-close" aria-hidden="true"></span>';

    static FILE_ICON = '<span class="icon icon-file ai-attachment-icon" aria-hidden="true"></span>';

    /**
     * @param {HTMLElement|string} target
     * @param {Object} [options]
     * @param {Function} [options.onChange]
     * @param {Function} [options.onRemove]
     * @param {number} [options.maxFiles=100]          hard cap per message
     * @param {number} [options.maxVisibleDocs=6]      file chips shown in the tray
     * @param {number} [options.maxVisibleImages=4]    thumbnails shown in the tray
     * @param {number} [options.filterThreshold=12]    show the filter box above this count
     */
    constructor(target, options = {}) {
        this.container = typeof target === 'string' ? document.querySelector(target) : target;
        this.options = {
            onChange: options.onChange || null,
            onRemove: options.onRemove || null,
            maxFiles: 100,
            maxVisibleDocs: 6,
            maxVisibleImages: 4,
            filterThreshold: 12,
            ...options
        };

        this.attachments = [];
        this.keys = new Set();
        this.notice = '';
        this.noticeTimer = null;

        this.panel = null;
        this.panelOpen = false;
        this.panelFilter = '';

        this.element = this.container || document.createElement('div');
        this.element.classList.add('ai-attachments-preview');

        this._onDocClick = this._onDocClick.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onPanelResize = this._onPanelResize.bind(this);

        // One delegated listener for the tray (no per-render listeners).
        this.element.addEventListener('click', (e) => {
            const rm = e.target.closest('.ai-attachment-remove, .ai-attachment-img-remove');
            if (rm) {
                e.stopPropagation();
                this.removeFile(parseInt(rm.dataset.idx, 10));
                return;
            }
            if (e.target.closest('[data-action="open-panel"]')) {
                e.stopPropagation();
                this.togglePanel();
            }
        });

        this.render();
    }

    /* ----------------------------------------------------------------------
       Data
       ---------------------------------------------------------------------- */

    fileKey(file) {
        return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
    }

    shouldIgnore(file) {
        // Only folder uploads are filtered. Files the user picked by hand are kept.
        const rel = file.webkitRelativePath;
        if (!rel) return false;

        const parts = rel.split('/');
        const name = parts[parts.length - 1].toLowerCase();

        if (parts.slice(0, -1).some((p) => AIAttachments.IGNORED_DIRS.has(p.toLowerCase()))) return true;
        if (AIAttachments.IGNORED_FILES.has(name)) return true;
        if (name.endsWith('.min.js') || name.endsWith('.min.css')) return true;

        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot + 1) : '';

        // Documents are readable via the local converter, so a folder upload must
        // never drop them. The format list is owned by file-context.js (shared
        // with the agent); if that module has not loaded, the binary list below
        // already excludes document formats, so keeping this check optional is safe.
        if (window.ArtemisFileContext?.DOCUMENT_EXT?.has(ext)) return false;

        return AIAttachments.BINARY_EXT.has(ext);
    }

    addFiles(files) {
        if (!files || files.length === 0) return;
        const list = Array.isArray(files) ? files : Array.from(files);
        const stats = { added: 0, duplicates: 0, ignored: 0, overLimit: 0 };

        for (const file of list) {
            if (this.shouldIgnore(file)) { stats.ignored += 1; continue; }

            const key = this.fileKey(file);
            if (this.keys.has(key)) { stats.duplicates += 1; continue; }

            if (this.attachments.length >= this.options.maxFiles) { stats.overLimit += 1; continue; }

            if (file.type && file.type.startsWith('image/') && !file._previewUrl) {
                file._previewUrl = URL.createObjectURL(file);
            }
            file._key = key;
            this.attachments.push(file);
            this.keys.add(key);
            stats.added += 1;
        }

        this.setNotice(stats);
        this.render();

        if (stats.added > 0 && typeof this.options.onChange === 'function') {
            this.options.onChange(this.getFiles());
        }
    }

    removeFile(index) {
        if (index < 0 || index >= this.attachments.length) return;
        const removed = this.attachments.splice(index, 1)[0];

        if (removed) {
            this.keys.delete(removed._key);
            if (removed._previewUrl) URL.revokeObjectURL(removed._previewUrl);
        }

        this.render();

        if (typeof this.options.onRemove === 'function') this.options.onRemove(removed, index);
        if (typeof this.options.onChange === 'function') this.options.onChange(this.getFiles());
    }

    getFiles() { return [...this.attachments]; }

    getCount() { return this.attachments.length; }

    clear() {
        this.attachments.forEach((file) => {
            if (file._previewUrl) URL.revokeObjectURL(file._previewUrl);
        });
        this.attachments = [];
        this.keys.clear();
        this.notice = '';
        this.render();

        if (typeof this.options.onChange === 'function') this.options.onChange(this.getFiles());
    }

    setNotice(stats) {
        const parts = [];
        if (stats.ignored) parts.push(`Skipped ${stats.ignored} unneeded file${stats.ignored === 1 ? '' : 's'} (node_modules, .git, binaries, lock files)`);
        if (stats.duplicates) parts.push(`${stats.duplicates} duplicate${stats.duplicates === 1 ? '' : 's'} ignored`);
        if (stats.overLimit) parts.push(`Limit is ${this.options.maxFiles} files, ${stats.overLimit} not added`);

        this.notice = parts.join(' · ');
        clearTimeout(this.noticeTimer);
        if (this.notice) {
            this.noticeTimer = setTimeout(() => {
                this.notice = '';
                this.render();
            }, 7000);
        }
    }

    /* ----------------------------------------------------------------------
       Tray
       ---------------------------------------------------------------------- */

    _partition() {
        const images = [];
        const docs = [];
        this.attachments.forEach((file, idx) => {
            const isImg = file.type && file.type.startsWith('image/') && file._previewUrl;
            (isImg ? images : docs).push({ file, idx });
        });
        return { images, docs };
    }

    _iconFor(file, cls) {
        return typeof FileIcons !== 'undefined'
            ? FileIcons.getIconMarkup(file, cls)
            : AIAttachments.FILE_ICON;
    }

    render() {
        if (this.attachments.length === 0) {
            this.element.classList.add('ai-hidden');
            this.element.innerHTML = '';
            this.closePanel();
            return;
        }

        this.element.classList.remove('ai-hidden');

        const { images, docs } = this._partition();
        const maxI = this.options.maxVisibleImages;
        const maxD = this.options.maxVisibleDocs;

        // Never show a pointless "+1": if only one item would be hidden, show it.
        const visibleImgCount = images.length <= maxI + 1 ? images.length : maxI;
        const visibleDocCount = docs.length <= maxD + 1 ? docs.length : maxD;
        const hiddenImages = images.length - visibleImgCount;
        const hiddenDocs = docs.length - visibleDocCount;
        const total = this.attachments.length;

        let html = '';

        images.slice(0, visibleImgCount).forEach(({ file, idx }) => {
            const name = this.escapeHtml(file.name || 'image');
            html += `
                <div class="ai-attachment-image-card" data-idx="${idx}">
                    <img src="${file._previewUrl}" alt="${name}" class="ai-attachment-img" />
                    <button type="button" class="ai-attachment-img-remove" data-idx="${idx}" title="Remove image" aria-label="Remove ${name}">
                        <span class="icon icon-close" aria-hidden="true"></span>
                    </button>
                    <div class="ai-attachment-tooltip">${name}</div>
                </div>`;
        });

        if (hiddenImages > 0) {
            html += `<button type="button" class="ai-attachment-more-tile" data-action="open-panel" aria-label="Show all ${total} attached files">+${hiddenImages}</button>`;
        }

        docs.slice(0, visibleDocCount).forEach(({ file, idx }) => {
            const name = this.escapeHtml(file.name || 'file');
            html += `
                <div class="ai-attachment-tag" data-idx="${idx}">
                    <span class="ai-attachment-content">
                        ${this._iconFor(file, 'ai-attachment-icon')}
                        <span class="ai-attachment-name">${name}</span>
                    </span>
                    <button type="button" class="ai-attachment-remove" data-idx="${idx}" title="Remove file" aria-label="Remove ${name}">${AIAttachments.X_ICON}</button>
                    <div class="ai-attachment-tooltip">${name}</div>
                </div>`;
        });

        if (hiddenDocs > 0) {
            html += `
                <button type="button" class="ai-attachment-more" data-action="open-panel" aria-expanded="${this.panelOpen}" aria-label="Show all ${total} attached files">
                    ${AIAttachments.FILE_ICON}
                    <span>+${hiddenDocs} more</span>
                </button>`;
        }

        if (this.notice) {
            html += `<div class="ai-attachments-notice" role="status">${this.escapeHtml(this.notice)}</div>`;
        }

        this.element.innerHTML = html;

        if (this.panelOpen) this._refreshPanel();
    }

    /* ----------------------------------------------------------------------
       Files panel
       ---------------------------------------------------------------------- */

    _ensurePanel() {
        if (this.panel) return this.panel;

        const host = this.element.closest('.ai-input-component') || this.element.parentElement;
        const panel = document.createElement('div');
        panel.className = 'ai-attachments-panel ai-hidden';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Attached files');
        panel.innerHTML = `
            <div class="ai-ap-header">
                <div class="ai-ap-title">
                    <span class="ai-ap-count" data-ref="count"></span>
                    <span class="ai-ap-size" data-ref="size"></span>
                </div>
                <div class="ai-ap-actions">
                    <button type="button" class="ai-ap-btn" data-panel-clear>Clear all</button>
                    <button type="button" class="ai-ap-icon-btn" data-panel-close aria-label="Close">${AIAttachments.X_ICON}</button>
                </div>
            </div>
            <div class="ai-ap-search ai-hidden" data-ref="searchWrap">
                <input type="search" class="ai-ap-search-input" placeholder="Filter files…" aria-label="Filter files" autocomplete="off" spellcheck="false" />
            </div>
            <div class="ai-ap-meter ai-hidden" data-ref="meter"></div>
            <div class="ai-ap-list" data-ref="list" role="list"></div>
        `;

        panel.addEventListener('click', (e) => {
            const rm = e.target.closest('[data-panel-remove]');
            if (rm) {
                this.removeFile(parseInt(rm.dataset.panelRemove, 10));
                return;
            }
            if (e.target.closest('[data-panel-clear]')) { this.clear(); return; }
            if (e.target.closest('[data-panel-close]')) { this.closePanel(); }
        });

        panel.addEventListener('input', (e) => {
            if (e.target.matches('.ai-ap-search-input')) {
                this.panelFilter = e.target.value;
                this._renderPanelList();
            }
        });

        host.appendChild(panel);
        this.panel = panel;
        return panel;
    }

    togglePanel() {
        if (this.panelOpen) this.closePanel();
        else this.openPanel();
    }

    openPanel() {
        if (this.attachments.length === 0) return;
        const panel = this._ensurePanel();

        this.panelOpen = true;
        this.panelFilter = '';
        const input = panel.querySelector('.ai-ap-search-input');
        if (input) input.value = '';

        panel.classList.remove('ai-hidden');
        this._refreshPanel();

        document.addEventListener('click', this._onDocClick);
        document.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('resize', this._onPanelResize);

        const more = this.element.querySelector('.ai-attachment-more');
        if (more) more.setAttribute('aria-expanded', 'true');
    }

    closePanel() {
        if (!this.panelOpen && !this.panel) return;
        this.panelOpen = false;

        if (this.panel) this.panel.classList.add('ai-hidden');

        document.removeEventListener('click', this._onDocClick);
        document.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('resize', this._onPanelResize);

        const more = this.element.querySelector('.ai-attachment-more');
        if (more) more.setAttribute('aria-expanded', 'false');
    }

    /**
     * Keep the panel inside the app shell. When the window is short there may
     * not be enough room above the input, so the panel shrinks or opens below.
     */
    _fitPanel() {
        const panel = this.panel;
        if (!panel || panel.classList.contains('ai-hidden')) return;

        // Measure with the default CSS position first.
        panel.style.top = '';
        panel.style.bottom = '';
        panel.style.maxHeight = '';

        const host = panel.parentElement;
        if (!host) return;

        const boundary = host.closest('.ai-app-shell') || document.documentElement;
        const hostRect = host.getBoundingClientRect();
        const bounds = boundary.getBoundingClientRect();
        const gap = 8;
        const inset = 12;
        const preferred = 360;

        const spaceAbove = hostRect.top - bounds.top - gap - inset;
        const spaceBelow = bounds.bottom - hostRect.bottom - gap - inset;
        const openBelow = spaceAbove < 240 && spaceBelow > spaceAbove;
        const available = openBelow ? spaceBelow : spaceAbove;

        if (openBelow) {
            panel.style.top = `calc(100% + ${gap}px)`;
            panel.style.bottom = 'auto';
        } else {
            panel.style.top = 'auto';
            panel.style.bottom = `calc(100% + ${gap}px)`;
        }

        panel.style.maxHeight = `${Math.max(80, Math.min(preferred, Math.floor(available)))}px`;
    }

    _onPanelResize() {
        this._fitPanel();
    }

    _onDocClick(e) {
        if (!this.panel) return;
        if (this.panel.contains(e.target) || this.element.contains(e.target)) return;
        this.closePanel();
    }

    _onKeyDown(e) {
        if (e.key === 'Escape') this.closePanel();
    }

    _refreshPanel() {
        if (!this.panel) return;
        const total = this.attachments.length;
        const bytes = this.attachments.reduce((sum, f) => sum + (f.size || 0), 0);

        this.panel.querySelector('[data-ref="count"]').textContent = `${total} file${total === 1 ? '' : 's'}`;
        this.panel.querySelector('[data-ref="size"]').textContent = `· ${this.formatSize(bytes)}`;

        this.panel.querySelector('[data-ref="searchWrap"]')
            .classList.toggle('ai-hidden', total <= this.options.filterThreshold);

        this._renderMeter();
        this._renderPanelList();
        this._fitPanel();
    }

    _renderMeter() {
        const el = this.panel.querySelector('[data-ref="meter"]');
        const api = typeof window !== 'undefined' ? window.ArtemisFileContext : null;

        if (!api || typeof api.estimateBudget !== 'function') {
            el.classList.add('ai-hidden');
            return;
        }

        let est = null;
        try { est = api.estimateBudget(this.attachments); } catch (_) { est = null; }
        if (!est || est.readable === 0) {
            el.classList.add('ai-hidden');
            return;
        }

        const pct = Math.min(100, Math.round((est.demand / est.budget) * 100));
        const warn = !est.fits;
        let text = est.fits
            ? 'All files fit in the AI’s context.'
            : `Too large to fit fully. ${est.partial} of ${est.readable} readable files will be shortened.`;
        if (est.skipped) text += ` ${est.skipped} can’t be read (images or binary).`;

        el.classList.remove('ai-hidden');
        el.classList.toggle('is-warn', warn);
        el.innerHTML = `
            <div class="ai-ap-bar"><span style="width:${pct}%"></span></div>
            <div class="ai-ap-meter-text">${this.escapeHtml(text)}</div>
        `;
    }

    _renderPanelList() {
        const list = this.panel.querySelector('[data-ref="list"]');
        const q = this.panelFilter.trim().toLowerCase();

        const rows = [];
        this.attachments.forEach((file, idx) => {
            const path = (file.webkitRelativePath || file.name || '').toLowerCase();
            if (!q || path.includes(q)) rows.push(this._rowHtml(file, idx));
        });

        list.innerHTML = rows.length
            ? rows.join('')
            : '<div class="ai-ap-empty">No files match.</div>';
    }

    _rowHtml(file, idx) {
        const rel = file.webkitRelativePath || file.name || 'file';
        const slash = rel.lastIndexOf('/');
        const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
        const base = slash >= 0 ? rel.slice(slash + 1) : rel;

        return `
            <div class="ai-ap-row" role="listitem" title="${this.escapeHtml(rel)}">
                ${this._iconFor(file, 'ai-attachment-icon')}
                <span class="ai-ap-name">
                    ${dir ? `<span class="ai-ap-dir">${this.escapeHtml(dir)}</span>` : ''}<span class="ai-ap-base">${this.escapeHtml(base)}</span>
                </span>
                <span class="ai-ap-meta">${this.formatSize(file.size)}</span>
                <button type="button" class="ai-ap-remove" data-panel-remove="${idx}" aria-label="Remove ${this.escapeHtml(base)}">${AIAttachments.X_ICON}</button>
            </div>`;
    }

    /* ----------------------------------------------------------------------
       Helpers
       ---------------------------------------------------------------------- */

    formatSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
        return `${(n / 1048576).toFixed(1)} MB`;
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    mount(target) {
        if (target) target.appendChild(this.element);
    }

    destroy() {
        clearTimeout(this.noticeTimer);
        this.closePanel();
        if (this.panel) this.panel.remove();
        this.panel = null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AIAttachments;
} else {
    window.AIAttachments = AIAttachments;
}
