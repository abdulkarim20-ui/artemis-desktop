/**
 * Shared image constants. Used by the renderer (resizing, validation) and the
 * agent (re-validation). Keep this file dependency-free.
 */

export const IMAGE_LIMITS = Object.freeze({
    MAX_IMAGES_PER_MESSAGE: 3,
    MAX_SOURCE_BYTES: 25 * 1024 * 1024,   // refuse to even decode bigger source files
    MAX_DIMENSION: 1568,                  // longest side after resizing
    FALLBACK_DIMENSIONS: Object.freeze([1280, 1024, 768]),
    MAX_ENCODED_BYTES: 1_000_000,         // one image, decoded bytes
    MAX_TOTAL_ENCODED_BYTES: 3_000_000,   // all images in one request, decoded bytes
    JPEG_QUALITIES: Object.freeze([0.85, 0.75, 0.65, 0.55]),
});

/** Formats the renderer can decode. SVG and ICO are deliberately excluded. */
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp|gif|bmp)$/;

const extOf = (name) => {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
    return match ? match[1].toLowerCase() : "";
};

/** Works for File objects and plain { name, type } objects. */
export function isImageFile(file) {
    if (!file) return false;
    const type = String(file.type || "").toLowerCase();
    if (IMAGE_MIME.test(type)) return true;
    if (type && type !== "application/octet-stream") return false;
    return IMAGE_EXT.has(extOf(file.name));
}

/** Decoded size of a base64 data URL, without decoding it. */
export function dataUrlBytes(dataUrl) {
    const comma = String(dataUrl || "").indexOf(",");
    if (comma < 0) return 0;
    const base64 = dataUrl.slice(comma + 1);
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
