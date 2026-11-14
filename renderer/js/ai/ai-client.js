/**
 * ============================================================================
 * AI CLIENT (renderer/js/ai/ai-client.js)
 * ============================================================================
 * Small ES-module wrapper around the local AI agent HTTP API.
 *
 * - Talks to the bundled ai-agent on 127.0.0.1 (never localhost, which can
 *   resolve to IPv6 while the agent listens on IPv4). The port comes from the
 *   main process via the preload bridge; 3000 is only the fallback.
 * - Parses SSE independently of chunk boundaries.
 * - Supports AbortController cancellation for the chat view.
 * ============================================================================
 */

const AGENT_PORT = Number(globalThis.appConfig?.agentPort) || 3000;
export const DEFAULT_AI_BASE_URL = `http://127.0.0.1:${AGENT_PORT}`;

const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");

async function readError(response) {
  if (response.status === 413) {
    return 'The message is too large to send. Try fewer or smaller images.';
  }
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      return json.error || json.message || `HTTP ${response.status}`;
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Fetch the model registry.
 * @param {{ baseUrl?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ models: Array<object>, defaultModel?: string }>}
 */
export async function getModels(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const response = await fetch(`${baseUrl}/api/models`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json();
}

/**
 * Poll the health endpoint until the local agent is up.
 * @param {{ baseUrl?: string, attempts?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForBackend(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const attempts = options.attempts ?? 30;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) return false;
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: options.signal,
      });
      if (response.ok) return true;
    } catch {
      // Agent not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

/**
 * Parse an SSE byte stream and invoke onEvent for every JSON event.
 * Exported for tests and for reuse by other views.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {(event: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function consumeEventStream(stream, onEvent, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushEvent = (block) => {
    // A single SSE event block can contain multiple `data:` lines; the spec
    // joins them with newlines. The agent only emits one, but handling both
    // makes the parser resilient to proxies and future backends.
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine.startsWith("data:")) continue;
      dataLines.push(rawLine.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;

    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;

    try {
      onEvent(JSON.parse(payload));
    } catch {
      // Ignore keep-alives or malformed fragments rather than killing the
      // whole stream on a single bad event.
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        const separatorLength = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
        buffer = buffer.slice(boundary + separatorLength);
        flushEvent(block);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) flushEvent(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

/**
 * Stream a chat completion.
 *
 * @param {{
 *   baseUrl?: string,
 *   messages: Array<{role: string, content: string, images?: object[]}>,
 *   model?: object|null,
 *   rag?: { enabled?: boolean, collection?: string, topK?: number }|null,
 *   signal?: AbortSignal,
 *   onEvent?: (event: object) => void
 * }} options
 *   `rag` asks the agent to search a knowledge base and inject the passages it
 *   finds into the newest user turn before the model sees it. Omitting it (or
 *   passing enabled: false) leaves the request exactly as it was before
 *   retrieval existed.
 * @returns {Promise<{ text: string, reasoning: string, events: object[] }>}
 */
export async function streamChat(options) {
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_AI_BASE_URL);
  const onEvent = options.onEvent || (() => {});
  const events = [];
  let text = "";
  let reasoning = "";

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      messages: options.messages,
      model: options.model || null,
      rag: options.rag || null,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  if (!response.body) {
    throw new Error("The AI agent returned an empty stream.");
  }

  await consumeEventStream(response.body, (event) => {
    events.push(event);

    if (event.type === "response.delta") {
      text += event.text || "";
    } else if (event.type === "reasoning.delta") {
      reasoning += event.text || "";
    }

    onEvent(event);
  }, options.signal);

  return { text, reasoning, events };
}
