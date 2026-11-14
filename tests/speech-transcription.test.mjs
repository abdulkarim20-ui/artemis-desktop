import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  createSpeechRouter,
  SpeechTranscriptionError,
  transcribeAudio,
} from "../ai-agent/speech/transcription.js";
import { VoiceRecorder } from "../renderer/js/ai/voice-recorder.js";

const express = createRequire(new URL("../package.json", import.meta.url))("express");

async function withServer(router, run) {
  const app = express();
  app.use("/api/speech", router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/speech`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("transcription sends audio to Groq with the server-side key and configured model", async () => {
  let request;
  const text = await transcribeAudio({
    buffer: Buffer.alloc(1200, 7),
    mimeType: "audio/webm;codecs=opus",
    language: "en",
    apiKey: "test-groq-key",
    model: "whisper-test",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return new Response(JSON.stringify({ text: "  hello there  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(text, "hello there");
  assert.equal(request.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(request.headers.Authorization, "Bearer test-groq-key");
  assert.equal(request.body.get("model"), "whisper-test");
  assert.equal(request.body.get("language"), "en");
  assert.equal(request.body.get("file").name, "speech.webm");
});

test("transcription rejects missing keys and unsupported audio types explicitly", async () => {
  await assert.rejects(
    transcribeAudio({ buffer: Buffer.alloc(1200), mimeType: "audio/webm", apiKey: "" }),
    (error) => error instanceof SpeechTranscriptionError && error.status === 503
  );
  await assert.rejects(
    transcribeAudio({ buffer: Buffer.alloc(1200), mimeType: "audio/unknown", apiKey: "key" }),
    (error) => error instanceof SpeechTranscriptionError && error.status === 415
  );
});

test("a Groq rate limit is reported with a retryable status", async () => {
  await assert.rejects(
    transcribeAudio({
      buffer: Buffer.alloc(1200),
      mimeType: "audio/wav",
      apiKey: "key",
      fetchImpl: async () => new Response("", { status: 429 }),
    }),
    (error) => error instanceof SpeechTranscriptionError && error.status === 429
  );
});

test("speech route forwards audio and returns the transcription", async () => {
  let received;
  const router = createSpeechRouter({
    transcribe: async (input) => {
      received = input;
      return "recognized words";
    },
  });

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/transcribe?language=en`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: Buffer.alloc(1200, 7),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "recognized words" });
    assert.equal(received.mimeType, "audio/webm;codecs=opus");
    assert.equal(received.language, "en");
    assert.equal(received.buffer.length, 1200);
  });
});

test("speech route rejects unsupported and too-short uploads", async () => {
  await withServer(createSpeechRouter(), async (baseUrl) => {
    const unsupported = await fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(1200),
    });
    assert.equal(unsupported.status, 415);

    const tooShort = await fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: Buffer.alloc(100),
    });
    assert.equal(tooShort.status, 400);
  });
});

test("voice recorder captures a clip, transcribes it, and releases the microphone", async () => {
  const states = [];
  let transcript = "";
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  class FakeMediaRecorder {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.state = "inactive";
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob([Buffer.alloc(1200)], { type: this.mimeType }) });
      this.onstop();
    }
  }

  const recorder = new VoiceRecorder({
    apiBase: "http://127.0.0.1:3000",
    mediaDevices: { getUserMedia: async () => stream },
    MediaRecorder: FakeMediaRecorder,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:3000/api/speech/transcribe");
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ text: "spoken words" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    onState(state) {
      states.push(state);
      if (state === "idle" && states.includes("transcribing")) resolveIdle();
    },
    onText(text) { transcript = text; },
  });

  await recorder.toggle();
  assert.equal(recorder.state, "recording");
  await recorder.toggle();
  await idle;

  assert.equal(transcript, "spoken words");
  assert.deepEqual(states, ["requesting", "recording", "transcribing", "idle"]);
  assert.equal(track.stopped, true);
  recorder.destroy();
});

test("cancelling while microphone permission is pending releases a late stream", async () => {
  let resolveStream;
  const streamPromise = new Promise((resolve) => { resolveStream = resolve; });
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const recorder = new VoiceRecorder({
    mediaDevices: { getUserMedia: () => streamPromise },
    MediaRecorder: class {},
  });

  const start = recorder.start();
  assert.equal(recorder.state, "requesting");
  assert.equal(recorder.cancel(), true);
  assert.equal(recorder.state, "idle");

  resolveStream(stream);
  await start;
  assert.equal(track.stopped, true);
  recorder.destroy();
});
