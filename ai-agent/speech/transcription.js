import express from "express";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
    ["audio/webm", "webm"],
    ["audio/ogg", "ogg"],
    ["audio/mp4", "mp4"],
    ["audio/mpeg", "mp3"],
    ["audio/mp3", "mp3"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
]);

export class SpeechTranscriptionError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "SpeechTranscriptionError";
        this.status = status;
    }
}

export async function transcribeAudio({
    buffer,
    mimeType,
    language,
    apiKey = process.env.GROQ_API_KEY,
    model = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
    fetchImpl = globalThis.fetch,
} = {}) {
    const key = String(apiKey || "").trim();
    if (!key || key === "your_key_here" || key === "your_groq_key") {
        throw new SpeechTranscriptionError("Voice input requires a Groq API key. Add one in API key settings.", 503);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new SpeechTranscriptionError("No audio was received.", 400);
    }

    const contentType = String(mimeType || "").split(";")[0].trim().toLowerCase();
    const extension = MIME_EXTENSIONS.get(contentType);
    if (!extension) {
        throw new SpeechTranscriptionError("This audio format is not supported.", 415);
    }
    if (language && !/^[a-z]{2}$/i.test(language)) {
        throw new SpeechTranscriptionError("Language must be a two-letter language code.", 400);
    }

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentType }), `speech.${extension}`);
    form.append("model", String(model).trim() || "whisper-large-v3-turbo");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (language) form.append("language", language);

    let response;
    try {
        response = await fetchImpl(GROQ_TRANSCRIPTION_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.timeout(60_000),
        });
    } catch (error) {
        throw new SpeechTranscriptionError(
            error?.name === "TimeoutError"
                ? "Groq speech transcription timed out. Please try again."
                : "Could not reach Groq speech transcription. Check your connection and try again.",
            502
        );
    }

    if (!response.ok) {
        if (response.status === 429) {
            throw new SpeechTranscriptionError("Groq speech transcription is rate limited. Please try again shortly.", 429);
        }
        if (response.status === 413) {
            throw new SpeechTranscriptionError("The audio recording exceeds Groq's upload limit.", 413);
        }
        if (response.status === 401 || response.status === 403) {
            throw new SpeechTranscriptionError("Groq rejected the API key. Check it in API key settings.", 502);
        }
        throw new SpeechTranscriptionError(`Groq speech transcription failed (HTTP ${response.status}).`, 502);
    }

    let result;
    try {
        result = await response.json();
    } catch {
        throw new SpeechTranscriptionError("Groq returned an invalid transcription response.", 502);
    }

    if (typeof result?.text !== "string") {
        throw new SpeechTranscriptionError("Groq returned an invalid transcription response.", 502);
    }
    return result.text.trim();
}

export function createSpeechRouter({ transcribe = transcribeAudio } = {}) {
    const router = express.Router();

    router.post(
        "/transcribe",
        (req, res, next) => {
            express.raw({ type: "audio/*", limit: MAX_AUDIO_BYTES })(req, res, (error) => {
                if (!error) return next();
                if (error.status === 413 || error.type === "entity.too.large") {
                    return res.status(413).json({ error: "Audio recordings must be 25 MB or smaller." });
                }
                return res.status(400).json({ error: "The audio upload could not be read." });
            });
        },
        async (req, res) => {
            if (!req.is("audio/*")) {
                return res.status(415).json({ error: "Send audio using an audio content type." });
            }
            if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
                return res.status(400).json({ error: "No usable audio was received. Try recording for a little longer." });
            }

            try {
                const text = await transcribe({
                    buffer: req.body,
                    mimeType: req.get("content-type"),
                    language: typeof req.query.language === "string" ? req.query.language : undefined,
                });
                return res.json({ text });
            } catch (error) {
                if (error instanceof SpeechTranscriptionError) {
                    return res.status(error.status).json({ error: error.message });
                }
                console.error("[Speech transcription] Unexpected error:", error);
                return res.status(502).json({ error: "Speech transcription failed. Please try again." });
            }
        }
    );

    return router;
}
