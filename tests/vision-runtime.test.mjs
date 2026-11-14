import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    VisionError,
    assertVisionSupport,
    sanitizeImages,
    textOf,
    toProviderMessages,
} from "../ai-agent/runtime/vision.js";
import { IMAGE_RULES, buildSystemMessages } from "../ai-agent/runtime/system-prompts.js";
import { AI_EVENT_TYPES, sendEvent } from "../ai-agent/runtime/events.js";
import { AIRuntime, normalizeMessages } from "../ai-agent/runtime/ai-runtime.js";

const jpeg = (extra = 64) => "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]).toString("base64");
const png = () => "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");
const webp = () => "data:image/webp;base64," + Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]).toString("base64");
const image = (dataUrl, name = "a.jpg") => ({ id: name, name, mime: "image/jpeg", dataUrl, source: "attached" });

const seeing = { id: "v", provider: "groq", model: "v", name: "Seer", capabilities: { vision: true }, imageLimits: { maxImages: 2, maxImageBytes: 5000, maxTotalImageBytes: 9000 } };
const blind = { id: "b", provider: "groq", model: "b", name: "Blind", capabilities: { vision: false } };

test("sanitizeImages accepts jpeg, png and webp", () => {
    const out = sanitizeImages([{ name: "a", dataUrl: jpeg() }, { name: "b", dataUrl: png() }, { name: "c", dataUrl: webp() }]);
    assert.deepEqual(out.map((i) => i.mime), ["image/jpeg", "image/png", "image/webp"]);
    assert.equal(out[0].source, "attached");
});

test("sanitizeImages rejects bad input with a stable code", () => {
    const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
    assert.equal(code(() => sanitizeImages([{ name: "a", dataUrl: "http://x/y.png" }])), "imageInvalid");
    assert.equal(code(() => sanitizeImages([{ name: "a", dataUrl: "data:image/svg+xml;base64,AAAA" }])), "imageInvalid");
    assert.equal(code(() => sanitizeImages([{ name: "a", dataUrl: "data:image/png;base64," + Buffer.from("not a png at all!").toString("base64") }])), "imageInvalid");
    assert.equal(code(() => sanitizeImages([{ name: "a", dataUrl: jpeg(3000) }], { maxBytes: 1000 })), "imageTooLarge");
    assert.equal(code(() => sanitizeImages([1, 2, 3, 4].map((n) => ({ name: String(n), dataUrl: jpeg() })))), "tooManyImages");
    assert.deepEqual(sanitizeImages(undefined), []);
});

test("assertVisionSupport refuses a text-only model for the newest message", () => {
    const messages = [{ role: "user", content: "x", images: [image(jpeg())] }];
    assert.throws(() => assertVisionSupport(messages, blind), (e) => e instanceof VisionError && e.code === "visionUnsupported");
    assert.doesNotThrow(() => assertVisionSupport(messages, seeing));
});

test("assertVisionSupport ignores images that only live in older history", () => {
    const messages = [
        { role: "user", content: "old", images: [image(jpeg())] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new" },
    ];
    assert.doesNotThrow(() => assertVisionSupport(messages, blind));
});

test("toProviderMessages builds content parts for a vision model", () => {
    const [m] = toProviderMessages([{ role: "user", content: "look", images: [image(jpeg())] }], seeing);
    assert.equal(m.content[0].type, "text");
    assert.equal(m.content[0].text, "look");
    assert.equal(m.content[1].type, "image_url");
    assert.match(m.content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("toProviderMessages keeps the newest images within the model's count", () => {
    const messages = [
        { role: "user", content: "one", images: [image(jpeg(), "1.jpg"), image(jpeg(), "2.jpg")] },
        { role: "user", content: "two", images: [image(jpeg(), "3.jpg")] },
    ];
    const out = toProviderMessages(messages, seeing); // maxImages: 2
    assert.equal(out[1].content.length, 2);        // text + 1 image
    assert.equal(out[0].content.length, 2);        // text + 1 image (the newest of the older message)
    assert.match(textOf(out[0].content), /1 image not shown/);
});

test("toProviderMessages strips images for a text-only model and says so", () => {
    const [m] = toProviderMessages([{ role: "user", content: "look", images: [image(jpeg())] }], blind);
    assert.equal(typeof m.content, "string");
    assert.match(m.content, /cannot view images/);
});

test("a saved image note without bytes gets an honest note", () => {
    const [m] = toProviderMessages([{ role: "user", content: 'hi\n<attached_images count="1"></attached_images>' }], seeing);
    assert.match(m.content, /not included in this request/);
});

test("plain messages pass through untouched", () => {
    const out = toProviderMessages([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }], seeing);
    assert.deepEqual(out, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
});

test("system prompt adds image rules only when images are present", () => {
    const withImages = buildSystemMessages([{ role: "user", content: "x", images: [image(jpeg())] }])[0].content;
    const without = buildSystemMessages([{ role: "user", content: "x" }])[0].content;
    assert.match(withImages, /IMAGES\./);
    assert.doesNotMatch(without, /IMAGES\./);
});

test("registry: vision models declare sane image limits", async () => {
    const registry = JSON.parse(await readFile(new URL("../ai-agent/config/model-registry.json", import.meta.url), "utf8"));
    const visionModels = registry.models.filter((model) => model.capabilities?.vision);
    assert.ok(visionModels.length >= 1);
    assert.ok(visionModels.some((model) => model.id === "groq:qwen/qwen3.8-27b"), "Qwen should be marked as vision");
    for (const model of visionModels) {
        assert.ok(Number.isInteger(model.imageLimits?.maxImages) && model.imageLimits.maxImages > 0, `${model.id} needs imageLimits.maxImages`);
    }
});

/* ------------------------------------------------------------------ */
/* runtime wiring                                                      */
/* ------------------------------------------------------------------ */

async function runTurn({ model, messages }) {
    const runtime = new AIRuntime();
    runtime.registry = { resolve: async () => ({ request: {}, ...model }) };
    runtime.rag = { retrieveContext: async () => { throw new Error("retrieval must not run"); } };

    let calls = 0;
    let providerMessages = null;
    runtime.providers = {
        groq: {
            async streamChat(args, res) {
                calls += 1;
                providerMessages = args.messages;
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_START });
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_DELTA, text: "ok" });
                sendEvent(res, { type: AI_EVENT_TYPES.RESPONSE_END });
                sendEvent(res, { type: AI_EVENT_TYPES.DONE });
            },
        },
    };

    const written = [];
    const response = {
        writableEnded: false,
        destroyed: false,
        writable: true,
        write: (chunk) => written.push(chunk),
    };
    await runtime.executeChat({ messages, model }, response);

    return {
        events: written.map((frame) => JSON.parse(frame.slice(6))),
        calls,
        providerMessages,
    };
}

test("normalizeMessages keeps images on user messages and drops them from assistant messages", () => {
    const normalized = normalizeMessages({
        messages: [
            { role: "user", content: "look", images: [image(jpeg())] },
            { role: "assistant", content: "ok", images: [image(jpeg())] },
        ],
    });

    assert.equal(normalized[0].images.length, 1);
    assert.equal(normalized[0].images[0].mime, "image/jpeg");
    assert.ok(!("images" in normalized[1]));
});

test("an image message with greeting text is not treated as small talk", async () => {
    const { providerMessages } = await runTurn({
        model: seeing,
        messages: [{ role: "user", content: "hi", images: [image(jpeg())] }],
    });

    const system = providerMessages[0];
    assert.equal(system.role, "system");
    assert.ok(system.content.includes(IMAGE_RULES));
});

test("a text-only model plus an image emits visionUnsupported and never calls the provider", async () => {
    const { events, calls } = await runTurn({
        model: blind,
        messages: [{ role: "user", content: "what is this?", images: [image(jpeg())] }],
    });

    const error = events.find((event) => event.type === AI_EVENT_TYPES.ERROR);
    assert.equal(error.code, "visionUnsupported");
    assert.equal(calls, 0);
});

test("the provider receives a content array for a vision model", async () => {
    const { providerMessages } = await runTurn({
        model: seeing,
        messages: [{ role: "user", content: "what is this?", images: [image(jpeg())] }],
    });

    const lastUser = [...providerMessages].reverse().find((message) => message.role === "user");
    assert.ok(Array.isArray(lastUser.content));
    assert.equal(lastUser.content[0].type, "text");
    assert.equal(lastUser.content[1].type, "image_url");
});
