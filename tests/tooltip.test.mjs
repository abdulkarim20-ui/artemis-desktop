import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFile(path.join(here, "..", rel), "utf8");

test("the app tooltip adopts titles and supports keyboard, placement, and dismissal", async () => {
    const source = await read("renderer/js/components/tooltip.js");

    assert.match(source, /element\.dataset\.tooltip = native\.trim\(\)/);
    assert.match(source, /element\.removeAttribute\('title'\)/);
    assert.match(source, /dataset\.tooltipKbd/);
    assert.match(source, /dataset\.tooltipSide/);
    assert.match(source, /dataset\.tooltipWhen === 'collapsed'/);
    assert.match(source, /setAttribute\('aria-describedby', tip\.id\)/);
    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /doc\.addEventListener\('scroll', close, true\)/);
});

test("tooltips are loaded once and attached to the relevant controls", async () => {
    const app = await read("renderer/js/app.js");
    const html = await read("renderer/index.html");
    const sidebar = await read("renderer/js/components/sidebar.js");
    const titlebar = await read("renderer/js/components/titlebar.js");
    const input = await read("renderer/ai/components/input/ai-input.js");
    const styles = await read("renderer/styles/tooltip.css");

    assert.match(app, /theme\.init\(config\.defaults\.theme\);\s*initTooltips\(\);/);
    assert.match(html, /styles\/tooltip\.css/);
    assert.match(sidebar, /data-tooltip-when="collapsed"/);
    assert.match(titlebar, /data-tooltip-side="bottom"/);
    assert.match(input, /data-tooltip-kbd="Enter"/);
    assert.match(styles, /\.tooltip \{[\s\S]*z-index: 1000/);
    assert.match(styles, /prefers-reduced-motion: reduce/);
});
