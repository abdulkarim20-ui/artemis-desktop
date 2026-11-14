import test from "node:test";
import assert from "node:assert/strict";
import { imageLimits, pickVisionModel, supportsVision } from "../renderer/js/ai/vision-model.js";

const m = (id, provider, vision) => ({ id, provider, name: id, capabilities: { vision } });

test("supportsVision reads capabilities.vision only", () => {
    assert.equal(supportsVision(m("a", "groq", true)), true);
    assert.equal(supportsVision(m("a", "groq", false)), false);
    assert.equal(supportsVision(null), false);
    assert.equal(supportsVision({ id: "x" }), false);
});

test("imageLimits uses model values and falls back to defaults", () => {
    assert.equal(imageLimits({ imageLimits: { maxImages: 5 } }).maxImages, 5);
    assert.equal(imageLimits({}).maxImages, 3);
    assert.equal(imageLimits({ imageLimits: { maxImages: -1 } }).maxImages, 3);
});

test("pickVisionModel returns null when no model can see", () => {
    assert.equal(pickVisionModel([m("a", "groq", false)]), null);
    assert.equal(pickVisionModel([]), null);
});

test("pickVisionModel prefers a provider that has a saved key", () => {
    const models = [m("n", "nvidia", true), m("q", "groq", true)];
    assert.equal(pickVisionModel(models, { configured: { groq: true, nvidia: false } }).id, "q");
    assert.equal(pickVisionModel(models, { configured: { groq: false, nvidia: true } }).id, "n");
});

test("pickVisionModel keeps the current provider when nothing else differs", () => {
    const models = [m("n", "nvidia", true), m("q", "groq", true)];
    assert.equal(pickVisionModel(models, { current: m("g", "groq", false) }).id, "q");
});

test("pickVisionModel prefers the vision model used last", () => {
    const models = [m("n", "nvidia", true), m("q", "groq", true)];
    assert.equal(pickVisionModel(models, { preferId: "n", current: m("g", "groq", false) }).id, "n");
});

test("unknown key status never removes a model", () => {
    const models = [m("n", "nvidia", true)];
    assert.equal(pickVisionModel(models, { configured: { nvidia: false } }).id, "n");
});
