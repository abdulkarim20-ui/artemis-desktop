import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AIInputBox = require("../renderer/ai/components/input/ai-input.js");

function withMetrics(metrics) {
    globalThis.getComputedStyle = () => ({
        fontSize: "16px",
        paddingTop: "2px",
        paddingBottom: "2px",
        ...metrics,
    });
}

function boxWith(scrollHeight) {
    const textarea = { style: {}, scrollHeight };
    const box = Object.create(AIInputBox.prototype);
    box.el = { textarea };
    return { box, textarea };
}

test.after(() => {
    delete globalThis.getComputedStyle;
});

test("the composer stops growing at five lines and scrolls inside", () => {
    withMetrics({ lineHeight: "24px" });
    const { box, textarea } = boxWith(600);

    box.adjustHeight();

    assert.equal(textarea.style.height, "124px"); // 5 * 24 + 2 + 2
    assert.equal(textarea.style.overflowY, "auto");
});

test("exactly five lines still fits without a scrollbar", () => {
    withMetrics({ lineHeight: "24px" });
    const { box, textarea } = boxWith(124);

    box.adjustHeight();

    assert.equal(textarea.style.height, "124px");
    assert.equal(textarea.style.overflowY, "hidden");
});

test("shorter text keeps the natural height", () => {
    withMetrics({ lineHeight: "24px" });
    const { box, textarea } = boxWith(96);

    box.adjustHeight();

    assert.equal(textarea.style.height, "96px");
    assert.equal(textarea.style.overflowY, "hidden");
});

test("the docked font metrics produce the same five-line limit", () => {
    withMetrics({ fontSize: "15.2px", lineHeight: "22.8px", paddingTop: "3px", paddingBottom: "3px" });
    const { box, textarea } = boxWith(400);

    box.adjustHeight();

    assert.equal(textarea.style.height, "120px"); // 5 * 22.8 + 3 + 3
    assert.equal(textarea.style.overflowY, "auto");
});

test("with no computed styles, the fallback still caps the height", () => {
    delete globalThis.getComputedStyle;
    const { box, textarea } = boxWith(500);

    box.adjustHeight();

    assert.equal(textarea.style.height, "120px"); // 5 * (16 * 1.5)
    assert.equal(textarea.style.overflowY, "auto");
});
