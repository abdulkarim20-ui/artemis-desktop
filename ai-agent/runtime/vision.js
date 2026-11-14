/**
 * ============================================================================
 * VISION (runtime/vision.js)
 * ============================================================================
 * Everything the agent needs to know about images in chat:
 *   - sanitizeImages      validate what the browser sent
 *   - assertVisionSupport refuse (never silently switch) when the model cannot see
 *   - toProviderMessages  the ONLY place string content becomes content parts
 *
 * Message content stays a string everywhere else (store, titles, small talk,
 * retrieval, system prompts). Images ride in a separate `images` array.
 * ============================================================================
 */
import { IMAGE_LIMITS, dataUrlBytes } from "../../shared/image-formats.js";

export class VisionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "VisionError";
        this.code = code;
    }
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,/;
const IMAGES_BLOCK = /<attached_images\b/i;

export const ATTACH_IMAGES_ONLY_NOTE = "(The user attached image(s) without a message.)";
const NOT_INCLUDED_NOTE = "[The image(s) mentioned above are not included in this request.]";

export const modelSupportsVision = (model) => Boolean(model?.capabilities?.vision);

export function imageLimitsFor(model) {
    const read = (key, fallback) => {
        const value = Number(model?.imageLimits?.[key]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        maxImages: Math.floor(read("maxImages", IMAGE_LIMITS.MAX_IMAGES_PER_MESSAGE)),
        maxImageBytes: read("maxImageBytes", IMAGE_LIMITS.MAX_ENCODED_BYTES),
        maxTotalImageBytes: read("maxTotalImageBytes", IMAGE_LIMITS.MAX_TOTAL_ENCODED_BYTES),
    };
}

/** Plain text of a message whose content may be a string or content parts. */
export function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((part) => part && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");
    }
    return "";
}

/** Look at the real bytes: the declared mime type must match them. */
function sniffMime(head) {
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
    if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return null;
}

/**
 * Validate the `images` array of ONE message. Throws VisionError with a stable
 * code and a sentence a human can read: a rejected image must never turn into
 * a silently missing image.
 */
export function sanitizeImages(raw, {
    maxImages = IMAGE_LIMITS.MAX_IMAGES_PER_MESSAGE,
    maxBytes = IMAGE_LIMITS.MAX_ENCODED_BYTES,
} = {}) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        throw new VisionError("imageInvalid", "Images must be sent as a list.");
    }
    if (raw.length > maxImages) {
        throw new VisionError("tooManyImages", `A message can include at most ${maxImages} images.`);
    }

    return raw.map((item, index) => {
        const label = typeof item?.name === "string" && item.name ? item.name.slice(0, 200) : `image ${index + 1}`;
        const dataUrl = typeof item?.dataUrl === "string" ? item.dataUrl : "";
        const match = DATA_URL.exec(dataUrl);
        if (!match) {
            throw new VisionError("imageInvalid", `${label} is not a supported image (use PNG, JPEG or WebP).`);
        }

        const bytes = dataUrlBytes(dataUrl);
        if (bytes > maxBytes) {
            throw new VisionError("imageTooLarge", `${label} is too large to send (${Math.round(bytes / 1024)} KB).`);
        }

        const head = Buffer.from(dataUrl.slice(match[0].length, match[0].length + 16), "base64");
        if (sniffMime(head) !== match[1]) {
            throw new VisionError("imageInvalid", `${label} does not look like a real ${match[1]} file.`);
        }

        return {
            id: typeof item.id === "string" && item.id ? item.id.slice(0, 64) : `img${index}`,
            name: label,
            mime: match[1],
            dataUrl,
            source: item.source === "retrieved" ? "retrieved" : "attached",
        };
    });
}

/**
 * The newest user message carries this turn's images. If the chosen model
 * cannot see, say so with a code. The agent NEVER swaps models by itself; the
 * renderer switches visibly before sending (see renderer/js/ai/vision-guard.js).
 */
export function assertVisionSupport(messages, model) {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const images = Array.isArray(lastUser?.images) ? lastUser.images : [];
    if (images.length === 0) return;

    if (!modelSupportsVision(model)) {
        throw new VisionError(
            "visionUnsupported",
            `${model?.name || "This model"} cannot view images. Pick a model marked "Vision" and send the message again.`
        );
    }

    const { maxImages, maxImageBytes } = imageLimitsFor(model);
    if (images.length > maxImages) {
        throw new VisionError("tooManyImages", `${model.name} accepts up to ${maxImages} images per message.`);
    }
    for (const image of images) {
        if (dataUrlBytes(image.dataUrl) > maxImageBytes) {
            throw new VisionError("imageTooLarge", `${image.name} is too large for ${model.name}.`);
        }
    }
}

/**
 * Convert normalized messages into what the provider SDK expects.
 *
 *  - Vision model: user messages with images become
 *    [{ type: "text" }, { type: "image_url" }, ...]. Newest images win when the
 *    model's count or byte budget is exceeded; older ones become a text note.
 *  - Non-vision model: every image is dropped and replaced by a text note, so a
 *    follow-up question after the user switched models stays honest.
 *  - A saved <attached_images> block whose bytes are absent gets a note too.
 */
export function toProviderMessages(messages, model) {
    const vision = modelSupportsVision(model);
    const { maxImages, maxTotalImageBytes } = imageLimitsFor(model);

    const keep = messages.map((message) => new Array(Array.isArray(message.images) ? message.images.length : 0).fill(false));
    let countBudget = vision ? maxImages : 0;
    let byteBudget = vision ? maxTotalImageBytes : 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const images = Array.isArray(messages[i].images) ? messages[i].images : [];
        for (let j = images.length - 1; j >= 0; j -= 1) {
            const size = dataUrlBytes(images[j].dataUrl);
            if (countBudget > 0 && size <= byteBudget) {
                keep[i][j] = true;
                countBudget -= 1;
                byteBudget -= size;
            }
        }
    }

    return messages.map((message, index) => {
        const images = Array.isArray(message.images) ? message.images : [];
        const text = textOf(message.content);

        if (images.length === 0) {
            const missing = message.role === "user" && IMAGES_BLOCK.test(text);
            return { role: message.role, content: missing ? `${text}\n\n${NOT_INCLUDED_NOTE}` : text };
        }

        const shown = images.filter((_, j) => keep[index][j]);
        const hidden = images.length - shown.length;
        let body = text;
        if (hidden > 0) {
            const reason = vision ? "the model's image limit was reached" : "this model cannot view images";
            body += `\n\n[${hidden} image${hidden === 1 ? "" : "s"} not shown: ${reason}.]`;
        }
        if (shown.length === 0) {
            return { role: message.role, content: body };
        }
        return {
            role: message.role,
            content: [
                { type: "text", text: body },
                ...shown.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
            ],
        };
    });
}
