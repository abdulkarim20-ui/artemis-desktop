import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ModelSelector = require("../renderer/ai/components/model-selector/model-selector.js");

function renderModel(model) {
    const selector = Object.create(ModelSelector.prototype);
    selector.state = { selectedModel: model.id };
    return selector.renderModel(model);
}

test("models use their vendor mark in the selector without a vendor name", () => {
    const cases = [
        [{ id: "groq:openai/gpt-oss-120b", model: "openai/gpt-oss-120b", family: "GPT OSS", name: "GPT OSS 120B" }, "icon-brand-openai"],
        [{ id: "groq:qwen/qwen3.8-27b", model: "qwen/qwen3.8-27b", family: "Qwen", name: "Qwen 3.8 27B" }, "icon-brand-qwen"],
        [{ id: "nvidia:nvidia/nemotron-test", model: "nvidia/nemotron-test", family: "Nemotron", name: "Nemotron" }, "icon-brand-nvidia"]
    ];

    for (const [model, iconClass] of cases) {
        const markup = renderModel({ ...model, provider: "groq" });
        assert.match(markup, new RegExp(`class="icon ${iconClass} ai-model-provider-icon"`));
        assert.doesNotMatch(markup, /ai-model-provider[^-]/);
    }
});

test("unknown vendors fall back to the neutral mark", () => {
    const markup = renderModel({
        id: "groq:meta/llama",
        model: "meta/llama",
        provider: "groq",
        providerLabel: "Groq",
        name: "Llama"
    });

    assert.match(markup, /class="icon icon-model ai-model-provider-icon"/);
});

test("the selected model updates the input badge icon", () => {
    const icon = { className: "icon ai-model-current-icon", hidden: true };
    const badge = {
        setAttribute() {},
        removeAttribute() {},
        querySelector: selector => selector === "[data-ref='modelIcon']" ? icon : null
    };
    const selector = Object.create(ModelSelector.prototype);
    selector.container = {
        querySelector: name => name === "[data-ref='modelBadge']" ? badge : null
    };

    selector.updateModelBadge({
        id: "nvidia:nvidia/nemotron-test",
        model: "nvidia/nemotron-test",
        provider: "nvidia"
    });

    assert.equal(icon.className, "icon ai-model-current-icon icon-brand-nvidia");
    assert.equal(icon.hidden, false);
});

test("selectModel can switch without saving the user's default model", () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, value),
        removeItem: (key) => store.delete(key),
    };
    const picked = [];
    const selector = Object.create(ModelSelector.prototype);
    selector.state = { selectedModel: "a", models: [{ id: "a" }, { id: "b" }] };
    selector.options = { onSelect: (model) => picked.push(model.id) };
    selector.updateSelectionUI = () => {};
    selector.close = () => {};

    selector.selectModel("b", { persist: false });
    assert.equal(store.size, 0);
    assert.deepEqual(picked, ["b"]);

    selector.selectModel("a");
    assert.ok(store.size > 0, "the default call must still persist");
});

test("vision models get a Vision pill, others do not", () => {
    const base = { id: "x", model: "x", provider: "groq", name: "X" };
    assert.match(renderModel({ ...base, capabilities: { vision: true } }), /ai-model-cap/);
    assert.doesNotMatch(renderModel({ ...base, capabilities: { vision: false } }), /ai-model-cap/);
});

test("model marks are registered and their SVGs are present", async () => {
    const iconsCss = await readFile(new URL("../renderer/styles/icons.css", import.meta.url), "utf8");

    assert.match(iconsCss, /\.icon-model[^}]*assets\/icons\/model\.svg/);
    for (const name of ["brand-openai", "nvidia", "qwen"]) {
        const svg = await readFile(new URL(`../assets/model-icons/${name}.svg`, import.meta.url), "utf8");
        assert.match(iconsCss, new RegExp(`\\.icon-brand-${name === "brand-openai" ? "openai" : name}[^}]*assets\\/model-icons\\/${name}\\.svg`));
        assert.match(svg, /<svg\b/);
    }
});
