import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("bundled artwork carries no third-party provenance metadata", async () => {
    for (const path of [
        "assets/brand/app_logo.svg",
        "assets/brand/icon.png",
        "assets/brand/icon.ico"
    ]) {
        const bytes = await readFile(new URL(`../${path}`, import.meta.url));
        assert.doesNotMatch(bytes.toString("latin1"), /caBX|<metadata/i, path);
    }
});

test("the thinking view has no rotating word dictionary or timer", async () => {
    const source = await read("renderer/ai/components/thinking/thinking-view.js");

    assert.match(source, /class ThinkingView/);
    assert.doesNotMatch(source, /DEFAULT_WORDS|wordTimer|runWordRotationLoop|gapPoolMs|AI_THINKING_WORDS/);
});

test("greetings come from one Artemis-owned data file", async () => {
    const data = await read("renderer/ai/data/greetings.js");
    const component = await read("renderer/ai/components/greeting/dynamic-greeting.js");

    assert.match(data, /ARTEMIS_GREETINGS/);
    assert.doesNotMatch(data, /AI_THINKING_WORDS|AI_GREETINGS/);
    assert.match(component, /artemis-dynamic-greeting/);
    assert.doesNotMatch(component, /greetings\.json|loadExternalGreetings/);
    assert.equal(existsSync(new URL("../renderer/ai/components/greeting/greetings.json", import.meta.url)), false);
});

test("only the registered model vendor artwork is bundled", () => {
    for (const name of ["brand-openai", "nvidia", "qwen"]) {
        assert.equal(existsSync(new URL(`../assets/model-icons/${name}.svg`, import.meta.url)), true, name);
    }
    assert.equal(existsSync(new URL("../build", import.meta.url)), false);
    assert.equal(existsSync(new URL("../assets/brand/icon.ico", import.meta.url)), true);
    assert.equal(existsSync(new URL("../assets/brand/icon.png", import.meta.url)), true);
});
