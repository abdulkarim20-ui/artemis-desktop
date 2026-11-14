/**
 * ============================================================================
 * TITLE UTILITIES (chats/title-utils.js)
 * ============================================================================
 * Pure string helpers for chat titles. No I/O, so every rule here is covered
 * by a plain unit test.
 * ============================================================================
 */
export const DEFAULT_TITLE = "New chat";
export const MAX_TITLE_CHARS = 60;

/**
 * Turn raw model output (or user input) into a tidy one-line title.
 *
 * Models wrap titles in quotes, prefix them with "Title:", add markdown, or
 * leak a <think> block. All of that is removed here so the sidebar never shows
 * it. Returns "" when nothing usable is left.
 */
export function cleanTitle(raw, { maxChars = MAX_TITLE_CHARS } = {}) {
    let title = String(raw ?? "");

    title = title.replace(/<think>[\s\S]*?<\/think>/gi, " ");
    title = title.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";

    title = title.replace(/^(?:chat\s+)?(?:title|subject|name)\s*[:\-\u2013\u2014]\s*/i, "");
    title = title.replace(/[*`~]+/g, "").replace(/^#+\s*/, "");
    // Wrapping quotes, straight or typographic.
    title = title.replace(/^["'\u201c\u201d\u2018\u2019\u00ab\u00bb\s]+|["'\u201c\u201d\u2018\u2019\u00ab\u00bb\s]+$/g, "");
    title = title.replace(/[.,;:!\s]+$/g, "");
    title = title.replace(/\s+/g, " ").trim();

    if (title.length > maxChars) {
        const cut = title.slice(0, maxChars);
        const lastSpace = cut.lastIndexOf(" ");
        title = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!\s]+$/g, "");
    }

    return title;
}

/** Reject output that parsed fine but is not a real title. */
export function isUsableTitle(title) {
    if (typeof title !== "string") return false;
    if (title.length < 2) return false;
    // GroqProvider answers with a canned demo reply when no key is configured.
    if (/^demo response for/i.test(title)) return false;
    return true;
}

/**
 * A title built locally from the first message. Used instantly (so the sidebar
 * never shows a blank row) and whenever the model call fails.
 *
 * @param {{ text?: string, files?: Array<{ name?: string }> }} input
 */
export function fallbackTitle({ text = "", files = [], maxWords = 7, maxChars = 48 } = {}) {
    const plain = String(text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/```\w*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (plain) {
        let title = plain.split(" ").slice(0, maxWords).join(" ");
        if (title.length > maxChars) {
            const cut = title.slice(0, maxChars);
            const lastSpace = cut.lastIndexOf(" ");
            title = lastSpace > 12 ? cut.slice(0, lastSpace) : cut;
        }
        title = title.replace(/[.,;:!\s]+$/g, "");
        if (title) return title.charAt(0).toUpperCase() + title.slice(1);
    }

    const names = (files || []).map((file) => String(file?.name || "").trim()).filter(Boolean);
    if (names.length) {
        return cleanTitle(names.length > 1 ? `${names[0]} +${names.length - 1} more` : names[0]) || DEFAULT_TITLE;
    }

    return DEFAULT_TITLE;
}
