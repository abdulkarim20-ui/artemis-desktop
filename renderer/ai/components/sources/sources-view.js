/**
 * Builds the source chip and its read-only passage panel.
 */
(function (global) {
    'use strict';

    const MAX_STACK = 3;
    let uid = 0;

    const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const BOOK_ICON = '<span class="icon icon-book ai-sources-book" aria-hidden="true"></span>';

    const fileIcon = (path) =>
        typeof FileIcons !== 'undefined' ? FileIcons.getIconMarkup(path) : '';

    const tile = (path, className) => {
        const node = make('span', className);
        node.innerHTML = fileIcon(path);
        return node;
    };

    function buildChip(files, panelId, label) {
        const chip = make('button', 'ai-sources-chip');
        chip.type = 'button';
        chip.setAttribute('aria-haspopup', 'true');
        chip.setAttribute('aria-expanded', 'false');
        chip.setAttribute('aria-controls', panelId);
        chip.setAttribute(
            'aria-label',
            `${label}: ${files.map((file) => file.name).join(', ')}`
        );

        const stack = make('span', 'ai-sources-stack');
        files.slice(0, MAX_STACK).forEach((file, index) => {
            const item = tile(file.path, 'ai-sources-tile');
            item.style.zIndex = String(MAX_STACK - index);
            stack.appendChild(item);
        });
        chip.appendChild(stack);

        chip.appendChild(make('span', 'ai-sources-name', files[0].name));
        if (files.length > 1) {
            chip.appendChild(make('span', 'ai-sources-more', `+${files.length - 1} more`));
        }
        return chip;
    }

    function buildItem(file) {
        const item = make('div', 'ai-sources-item');
        item.appendChild(tile(file.path, 'ai-sources-item-tile'));

        const body = make('div', 'ai-sources-item-body');
        const title = make('div', 'ai-sources-item-title');
        title.appendChild(make('span', 'ai-sources-item-name', file.name));
        if (file.ext) title.appendChild(make('span', 'ai-sources-tag', file.ext));
        body.appendChild(title);

        if (file.sections.length) {
            body.appendChild(make('div', 'ai-sources-item-meta', file.sections.join('  ·  ')));
        }
        if (file.excerpt) body.appendChild(make('p', 'ai-sources-excerpt', file.excerpt));

        item.appendChild(body);
        return item;
    }

    function buildPanel(files, panelId, label) {
        const outer = make('div', 'ai-sources-panel');
        outer.id = panelId;
        outer.setAttribute('role', 'group');
        outer.setAttribute('aria-label', label);

        const surface = make('div', 'ai-sources-surface');

        const head = make('div', 'ai-sources-head');
        head.insertAdjacentHTML('afterbegin', BOOK_ICON);
        head.append(make('span', '', label), make('span', 'ai-sources-count', String(files.length)));
        surface.appendChild(head);

        const list = make('div', 'ai-sources-list');
        files.forEach((file) => list.appendChild(buildItem(file)));
        surface.appendChild(list);

        outer.appendChild(surface);
        return outer;
    }

    function render(files, { label = 'Sources' } = {}) {
        if (!Array.isArray(files) || files.length === 0) return null;

        const box = make('section', 'ai-sources');
        box.setAttribute('aria-label', label);

        const root = make('div', 'ai-sources-pop');
        const panelId = `ai-sources-panel-${++uid}`;
        const chip = buildChip(files, panelId, label);
        const panel = buildPanel(files, panelId, label);

        root.append(chip, panel);
        box.appendChild(root);

        if (typeof SourcesPopover !== 'undefined') {
            SourcesPopover.attach({ root, trigger: chip, panel });
        }
        return box;
    }

    function renderNote(text, modifier) {
        const suffix = modifier ? ` ai-sources-note--${modifier}` : '';
        return make('div', `ai-sources-note${suffix}`, text);
    }

    global.SourcesView = { render, renderNote };
})(typeof window !== 'undefined' ? window : globalThis);
