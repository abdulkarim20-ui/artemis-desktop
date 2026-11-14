import test from "node:test";
import assert from "node:assert/strict";
import { createVisionGuard } from "../renderer/js/ai/vision-guard.js";

const model = (id, provider, vision, extra = {}) => ({ id, provider, name: id, capabilities: { vision }, ...extra });
const png = (name = "a.png") => ({ name, type: "image/png", size: 10 });
const txt = () => ({ name: "a.txt", type: "text/plain", size: 10 });

function harness({ current, models, providers = null }) {
    const state = { model: current };
    const notices = [];
    const selected = [];
    let cleared = 0;
    const guard = createVisionGuard({
        getModels: () => models,
        getModel: () => state.model,
        selectModel: (id, options) => {
            selected.push({ id, options });
            state.model = models.find((item) => item.id === id);
        },
        notify: (text, options) => notices.push({ text, options }),
        clearNotice: () => { cleared += 1; },
        getProviderStatus: providers ? async () => ({ providers }) : null,
    });
    return { guard, state, notices, selected, cleared: () => cleared };
}

test("no images: nothing happens", () => {
    const h = harness({ current: model("g", "groq", false), models: [model("g", "groq", false), model("q", "groq", true)] });
    assert.deepEqual(h.guard.beforeSend({ attachments: [txt()] }), { allow: true, switched: false });
    assert.equal(h.selected.length, 0);
});

test("image + text-only model: switches without persisting, keeps the attachment", () => {
    const models = [model("g", "groq", false), model("q", "groq", true)];
    const h = harness({ current: models[0], models });
    const attachments = [png()];
    const verdict = h.guard.beforeSend({ attachments });
    assert.equal(verdict.allow, true);
    assert.equal(verdict.switched, true);
    assert.deepEqual(h.selected, [{ id: "q", options: { persist: false } }]);
    assert.equal(attachments.length, 1);
    assert.match(h.notices[0].text, /Switched to q/);
});

test("image + vision model: no switch", () => {
    const models = [model("q", "groq", true)];
    const h = harness({ current: models[0], models });
    assert.equal(h.guard.beforeSend({ attachments: [png()] }).switched, false);
    assert.equal(h.selected.length, 0);
});

test("switch prefers the provider that has a key", async () => {
    const models = [model("g", "groq", false), model("n", "nvidia", true), model("q", "groq", true)];
    const h = harness({ current: models[0], models, providers: { groq: { configured: false }, nvidia: { configured: true } } });
    await h.guard.refreshConfigured();
    h.guard.beforeSend({ attachments: [png()] });
    assert.equal(h.selected[0].id, "n");
});

test("no vision model at all: send is blocked with a clear message", () => {
    const models = [model("g", "groq", false)];
    const h = harness({ current: models[0], models });
    const verdict = h.guard.beforeSend({ attachments: [png()] });
    assert.equal(verdict.allow, false);
    assert.match(verdict.message, /None of the configured models/);
    assert.equal(h.selected.length, 0);
});

test("models not loaded yet: attach is silent, send is blocked", () => {
    const h = harness({ current: model("g", "groq", false), models: [] });
    h.guard.onAttachmentsChanged([png()]);
    assert.equal(h.notices.length, 0);
    assert.equal(h.guard.beforeSend({ attachments: [png()] }).allow, false);
});

test("too many images for the model blocks the send", () => {
    const models = [model("q", "groq", true, { imageLimits: { maxImages: 2 } })];
    const h = harness({ current: models[0], models });
    const verdict = h.guard.beforeSend({ attachments: [png("1.png"), png("2.png"), png("3.png")] });
    assert.equal(verdict.allow, false);
    assert.match(verdict.message, /up to 2 images/);
});

test("the notice clears once the attachment problem is resolved", () => {
    const models = [model("q", "groq", true, { imageLimits: { maxImages: 2 } })];
    const h = harness({ current: models[0], models });
    h.guard.onAttachmentsChanged([png("1.png"), png("2.png"), png("3.png")]);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0].text, /up to 2 images/);

    h.guard.onAttachmentsChanged([png("1.png"), png("2.png")]);
    assert.equal(h.notices.length, 1, "no new notice");
    assert.ok(h.cleared() > 0, "the stale warning is cleared");

    const removed = h.cleared();
    h.guard.onAttachmentsChanged([]);
    assert.ok(h.cleared() > removed);
});

test("picking a text-only model while an image is attached warns once", () => {
    const models = [model("g", "groq", false), model("q", "groq", true)];
    const h = harness({ current: models[0], models });
    h.guard.onModelChanged([png()]);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0].text, /switch to a vision model/);
});
