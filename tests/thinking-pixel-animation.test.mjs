import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ThinkingPixelAnimation = require("../renderer/ai/components/thinking/pixel-loader.js");

class FakeElement {
    constructor() {
        this.children = [];
        this.style = {
            values: new Map(),
            setProperty(name, value) {
                this.values.set(name, value);
            }
        };
        this.attributes = new Map();
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    remove() {
        this.removed = true;
    }
}

function withAnimationEnvironment(reducedMotion, run) {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame
    };
    const scheduledFrames = [];
    const cancelledFrames = [];

    globalThis.document = { createElement: () => new FakeElement() };
    globalThis.window = {
        matchMedia: () => ({ matches: reducedMotion })
    };
    globalThis.requestAnimationFrame = (callback) => {
        scheduledFrames.push(callback);
        return scheduledFrames.length;
    };
    globalThis.cancelAnimationFrame = (id) => cancelledFrames.push(id);

    try {
        run({ scheduledFrames, cancelledFrames });
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    }
}

test("thinking pixel animation renders nine cells and cancels its frame when stopped", () => {
    withAnimationEnvironment(false, ({ scheduledFrames, cancelledFrames }) => {
        const animation = new ThinkingPixelAnimation();

        assert.equal(animation.getElement().children.length, 9);
        animation.start();

        assert.equal(scheduledFrames.length, 1);
        assert.match(animation.element.style.values.get("--pixel-color"), /^rgb\(/);
        assert.ok(animation.cells.every((cell) => Number.isFinite(Number(cell.style.opacity))));

        animation.stop();
        assert.deepEqual(cancelledFrames, [1]);

        scheduledFrames[0](performance.now() + 100);
        assert.equal(scheduledFrames.length, 1, "stopped animation should not schedule another frame");
    });
});

test("thinking pixel animation renders one static frame for reduced motion", () => {
    withAnimationEnvironment(true, ({ scheduledFrames }) => {
        const animation = new ThinkingPixelAnimation();
        animation.start();

        assert.equal(scheduledFrames.length, 0);
        assert.match(animation.element.style.values.get("--pixel-color"), /^rgb\(/);
        assert.ok(animation.cells.some((cell) => Number(cell.style.opacity) > 0));
    });
});
