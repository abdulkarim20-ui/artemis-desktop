import test from "node:test";
import assert from "node:assert/strict";
import {
    buildImageNote,
    compactHistoryImages,
    partitionAttachments,
    prepareImages,
} from "../renderer/js/ai/image-pipeline.js";

const file = (name, type, size = 10) => ({ name, type, size });
const fakeEncoder = async (f) => ({ id: `id-${f.name}`, mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA", width: 10, height: 10, bytes: 3 });

test("partitionAttachments separates images from other files", () => {
    const { images, others } = partitionAttachments([
        file("a.png", "image/png"),
        file("b.pdf", "application/pdf"),
        file("c.svg", "image/svg+xml"),
        file("d.JPG", ""),
    ]);
    assert.deepEqual(images.map((f) => f.name), ["a.png", "d.JPG"]);
    assert.deepEqual(others.map((f) => f.name), ["b.pdf", "c.svg"]);
});

test("prepareImages encodes, labels source and caps the count with warnings", async () => {
    const files = ["1.png", "2.png", "3.png", "4.png"].map((n) => file(n, "image/png"));
    const { images, warnings } = await prepareImages(files, { encoder: fakeEncoder, maxImages: 3 });
    assert.equal(images.length, 3);
    assert.equal(images[0].source, "attached");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /4\.png: not sent/);
});

test("prepareImages turns an encoder failure into a warning, not an exception", async () => {
    const failing = async () => { throw new Error("the image could not be opened"); };
    const { images, warnings } = await prepareImages([file("x.png", "image/png")], { encoder: failing });
    assert.equal(images.length, 0);
    assert.match(warnings[0], /x\.png: skipped, the image could not be opened/);
});

test("prepareImages skips empty files (a restored placeholder)", async () => {
    const { images, warnings } = await prepareImages([file("x.png", "image/png", 0)], { encoder: fakeEncoder });
    assert.equal(images.length, 0);
    assert.match(warnings[0], /empty/);
});

test("buildImageNote escapes file names", () => {
    const note = buildImageNote([{ id: "1", name: 'a"b<c>.png' }]);
    assert.match(note, /&quot;/);
    assert.match(note, /&lt;/);
    assert.doesNotMatch(note, /<c>/);
    assert.equal(buildImageNote([]), "");
});

test("compactHistoryImages keeps the newest images only", () => {
    const img = (n) => ({ id: String(n) });
    const history = [
        { role: "user", content: "a", images: [img(1), img(2)] },
        { role: "user", content: "b", images: [img(3), img(4)] },
        { role: "user", content: "c", images: [img(5)] },
    ];
    compactHistoryImages(history, { keep: 3 });
    assert.equal(history[0].images, undefined);
    assert.deepEqual(history[1].images.map((i) => i.id), ["3", "4"]);
    assert.deepEqual(history[2].images.map((i) => i.id), ["5"]);
});

test("compactHistoryImages trims inside one message when needed", () => {
    const img = (n) => ({ id: String(n) });
    const history = [
        { role: "user", content: "a", images: [img(1), img(2), img(3)] },
        { role: "user", content: "b", images: [img(4)] },
    ];
    compactHistoryImages(history, { keep: 3 });
    assert.deepEqual(history[0].images.map((i) => i.id), ["2", "3"]);
});
