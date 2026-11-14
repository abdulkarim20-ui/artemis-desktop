/**
 * Controls hover, focus, click, and positioning behaviour for source panels.
 */
(function (global) {
    'use strict';

    const OPEN_DELAY_MS = 90;
    const CLOSE_DELAY_MS = 160;
    const EDGE_GAP_PX = 16;

    function attach({ root, trigger, panel }) {
        let openTimer = null;
        let closeTimer = null;
        let pinned = false;

        const isOpen = () => root.classList.contains('is-open');
        const clearTimers = () => {
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
        };

        const place = () => {
            root.classList.remove('is-below');
            const room = trigger.getBoundingClientRect().top;
            if (room < panel.offsetHeight + EDGE_GAP_PX) root.classList.add('is-below');
        };

        const open = () => {
            clearTimers();
            if (isOpen()) return;
            place();
            root.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
        };

        const close = () => {
            clearTimers();
            pinned = false;
            root.classList.remove('is-open');
            trigger.setAttribute('aria-expanded', 'false');
        };

        const onEnter = () => {
            clearTimers();
            openTimer = setTimeout(open, OPEN_DELAY_MS);
        };

        const onLeave = () => {
            clearTimers();
            if (pinned) return;
            closeTimer = setTimeout(close, CLOSE_DELAY_MS);
        };

        const onClick = () => {
            if (pinned) {
                close();
                return;
            }
            open();
            pinned = true;
        };

        const onFocusIn = () => {
            if (trigger.matches(':focus-visible')) open();
        };

        const onFocusOut = (event) => {
            if (!root.contains(event.relatedTarget)) close();
        };

        const onKeydown = (event) => {
            if (event.key !== 'Escape' || !isOpen()) return;
            event.stopPropagation();
            close();
            trigger.focus();
        };

        const onOutside = (event) => {
            if (isOpen() && !root.contains(event.target)) close();
        };

        root.addEventListener('mouseenter', onEnter);
        root.addEventListener('mouseleave', onLeave);
        root.addEventListener('focusin', onFocusIn);
        root.addEventListener('focusout', onFocusOut);
        root.addEventListener('keydown', onKeydown);
        trigger.addEventListener('click', onClick);
        document.addEventListener('pointerdown', onOutside, true);

        return function detach() {
            clearTimers();
            root.removeEventListener('mouseenter', onEnter);
            root.removeEventListener('mouseleave', onLeave);
            root.removeEventListener('focusin', onFocusIn);
            root.removeEventListener('focusout', onFocusOut);
            root.removeEventListener('keydown', onKeydown);
            trigger.removeEventListener('click', onClick);
            document.removeEventListener('pointerdown', onOutside, true);
        };
    }

    global.SourcesPopover = { attach };
})(typeof window !== 'undefined' ? window : globalThis);
