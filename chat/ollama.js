// Minimal Ollama client — just the two calls the chat UI needs.
//
// Deliberately hand-rolled over fetch rather than pulling a dependency: the
// surface is two endpoints, and staying dependency-free is the point of
// serving the UI from Node.

const BASE = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

/** Installed models, newest first. Empty array if Ollama isn't up. */
export async function listModels() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
    }));
  } catch {
    return [];
  }
}

export async function isUp() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stream a chat completion. Calls onToken(text) for each chunk as it arrives
 * and resolves with the full text.
 *
 * Streaming is non-negotiable here: a local model on modest hardware emits
 * tokens slowly enough that a request/response UI feels broken. This is the
 * main thing worth building that Open WebUI already had.
 */
export async function chatStream({ model, messages, tools, signal }, onToken) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools?.length ? { tools } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 200) || "no response body"}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Ollama emits newline-delimited JSON; a chunk can split a line, so keep
    // the trailing partial in the buffer.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }
      if (evt.error) throw new Error(evt.error);

      // Tool calls arrive inside the stream, usually on the final message.
      // Collect them rather than emitting as text.
      for (const tc of evt.message?.tool_calls ?? []) {
        if (tc?.function?.name) {
          toolCalls.push({
            name: tc.function.name,
            // The API documents `arguments` as an object, but some model
            // templates emit a JSON string — accept both.
            args: typeof tc.function.arguments === "string"
              ? safeParse(tc.function.arguments)
              : (tc.function.arguments || {}),
          });
        }
      }

      const piece = evt.message?.content;
      if (piece) { full += piece; onToken(piece); }
    }
  }
  return { text: full, toolCalls };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/** One-shot, non-streaming completion — used for conversation titles. */
export async function complete({ model, messages, signal }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.message?.content ?? "";
}

export const OLLAMA_BASE = BASE;
