// The model layer, behind the two calls the turn runner makes.
//
// SPIKE. `chatStream` and `complete` keep exactly the signatures and return
// shapes of chat/ollama.js, so server.js changes one import and nothing else.
// Behind them, pi-ai (@earendil-works/pi-ai) does the talking:
//
//   - a model named "anthropic/<id>" goes to Anthropic, with ANTHROPIC_API_KEY
//   - a model named "claude-code/<alias>" goes through the person's own signed-in
//     Claude Code — the subscription route; see claude-code.js
//   - any other name is a local Ollama model, reached through Ollama's
//     OpenAI-compatible /v1 endpoint — or, unless REFUGIO_ENGINE_LIB=pi, through
//     the hand-rolled native client exactly as before
//
// The native client stays the default for local models because it is the one
// the eval scored and the one that reports `done_reason` and prompt counts
// straight from Ollama. The question this spike answers is whether pi-ai can
// replace it without losing either, not whether it can be made to.
//
// Messages arrive in the Ollama shape the turn runner already builds — a system
// message, user/assistant text, assistant `tool_calls`, and `tool` results
// matched by position — and are translated per call. Keeping the runner's
// shape means the history store, the tool budget and the modes are untouched.

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as native from "./ollama.js";
import * as claudeCode from "./claude-code.js";

const CLOUD = /^(anthropic)\/(.+)$/;

/** Whether a model name means leaving this machine. The server asks this
 *  before it runs a turn; the engine does not decide it. */
export function isCloudModel(name) {
  return CLOUD.test(String(name || "")) || claudeCode.isClaudeCodeModel(name);
}

/**
 * Why a turn may not use this model, or null if it may. Asked by the server
 * before anything is stored or sent.
 *
 * Two rules, and they are not the same rule. A cloud model is off until the
 * person switches it on (REFUGIO_CLAUDE_CODE=1 for now; a Settings switch with
 * the web-search warning later), because "nothing leaves your machine" is the
 * default this product is installed on. And a discussion mode never uses one,
 * switch or no switch: a mode promises the conversation stays here, and the
 * person in it chose the mode, not the model.
 */
export function cloudRefusal({ model, mode = null, env = process.env }) {
  if (!isCloudModel(model)) return null;
  if (mode) return "Discussion modes only use the model on this computer. Choose a local model to continue in this mode.";
  if (claudeCode.isClaudeCodeModel(model) && env.REFUGIO_CLAUDE_CODE !== "1") {
    return "Claude through Claude Code is switched off. It sends this conversation to Anthropic, so it has to be switched on first.";
  }
  return null;
}

function usePiForLocal() {
  return (process.env.REFUGIO_ENGINE_LIB || "").toLowerCase() === "pi";
}

// ── Providers ───────────────────────────────────────────────

let _models = null;
const _ollamaModels = new Map();

function registry() {
  if (_models) return _models;
  _models = createModels();
  // Only the two providers REFUGIO offers. builtinModels() would register
  // forty, and a provider that is registered is a provider a stray env var
  // can switch on.
  _models.setProvider(anthropicProvider());
  _models.setProvider(createProvider({
    id: "ollama",
    name: "Ollama",
    baseUrl: `${native.OLLAMA_BASE}/v1`,
    // Ollama ignores the key, but pi-ai's OpenAI-compatible client refuses to
    // send a request without one ("No API key for provider: ollama") — the
    // README's keyless example with `auth: {}` fails on 1.0.1.
    auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: { apiKey: "ollama" } }) } },
    // Ollama's models are whatever is installed, so they are described on
    // demand (ollamaModel) rather than listed here.
    models: [],
    api: openAICompletionsApi(),
  }));
  return _models;
}

/** pi-ai needs a model description; Ollama only has a name. The numbers are
 *  deliberately not guesses about the model: REFUGIO sends no context option
 *  today, so whatever Ollama defaults to is what runs, on either path. */
function ollamaModel(name) {
  if (_ollamaModels.has(name)) return _ollamaModels.get(name);
  const m = {
    id: name,
    name,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${native.OLLAMA_BASE}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  _ollamaModels.set(name, m);
  return m;
}

function resolve(name) {
  const cloud = CLOUD.exec(String(name || ""));
  if (!cloud) return ollamaModel(name);
  const m = registry().getModel(cloud[1], cloud[2]);
  if (!m) throw new Error(`Unknown model ${name}`);
  return m;
}

// ── Translation ─────────────────────────────────────────────

/** Ollama-shaped turn → pi-ai Context. Tool results carry no call id in the
 *  Ollama shape; they follow the assistant message that asked for them, in
 *  order, so ids are assigned here and paired back by position. */
export function toContext(messages, tools, model) {
  const system = [];
  const out = [];
  let pending = [];
  let n = 0;
  const ts = Date.now();

  for (const m of messages) {
    if (m.role === "system") { system.push(m.content); continue; }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "", timestamp: ts });
      continue;
    }
    if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      pending = [];
      for (const tc of m.tool_calls ?? []) {
        const id = `call_${n++}`;
        pending.push({ id, name: tc.function?.name });
        content.push({ type: "toolCall", id, name: tc.function?.name, arguments: tc.function?.arguments ?? {} });
      }
      out.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: pending.length ? "toolUse" : "stop",
        timestamp: ts,
      });
      continue;
    }
    if (m.role === "tool") {
      const call = pending.shift() ?? { id: `call_${n++}`, name: m.tool_name };
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: m.tool_name ?? call.name,
        content: [{ type: "text", text: m.content ?? "" }],
        isError: String(m.content ?? "").startsWith("Error"),
        timestamp: ts,
      });
    }
  }

  return {
    systemPrompt: system.join("\n\n") || undefined,
    messages: out,
    // MCP hands REFUGIO plain JSON Schema, which is what pi-ai sends anyway;
    // TypeBox is only how pi-ai's own callers write it.
    tools: (tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    })),
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

// pi-ai's stop reasons, in the words the turn runner and the eval already log.
// "toolUse" is "stop" because that is what Ollama says on a round that ends in
// tool calls, and the log line is compared across engines.
const DONE = { stop: "stop", toolUse: "stop", length: "length" };

// ── The two calls ───────────────────────────────────────────

export async function chatStream({ model, messages, tools, signal }, onToken, onThinking = () => {}) {
  if (claudeCode.isClaudeCodeModel(model)) {
    return claudeCode.chatStream({ model, messages, tools, signal }, onToken, onThinking);
  }
  if (!isCloudModel(model) && !usePiForLocal()) {
    return native.chatStream({ model, messages, tools, signal }, onToken, onThinking);
  }

  const m = resolve(model);
  const s = registry().stream(m, toContext(messages, tools, m), { signal });

  let full = "";
  for await (const evt of s) {
    if (evt.type === "text_delta") { full += evt.delta; onToken(evt.delta); }
    else if (evt.type === "thinking_delta") onThinking(evt.delta);
  }

  const msg = await s.result();
  if (msg.stopReason === "aborted") throw abortError(signal);
  if (msg.stopReason === "error") throw new Error(msg.errorMessage || `${m.provider} request failed`);

  const toolCalls = msg.content
    .filter((b) => b.type === "toolCall")
    .map((b) => ({ name: b.name, args: b.arguments ?? {} }));

  // pi-ai's `input` is the prompt MINUS what the server answered from its
  // cache, and Ollama reuses its KV cache across rounds — so `input` alone read
  // 1 and 3 tokens for prompts native reported as 158 and 205. What the log and
  // the eval mean by prompt tokens is how full the context was: all three.
  const u = msg.usage ?? {};
  const prompt = [u.input, u.cacheRead, u.cacheWrite].every(Number.isFinite)
    ? u.input + u.cacheRead + u.cacheWrite
    : null;

  return {
    text: full,
    toolCalls,
    usage: {
      promptTokens: prompt,
      evalTokens: Number.isFinite(msg.usage?.output) ? msg.usage.output : null,
      doneReason: DONE[msg.stopReason] ?? msg.stopReason ?? null,
    },
  };
}

export async function complete({ model, messages, signal }) {
  if (claudeCode.isClaudeCodeModel(model)) return claudeCode.complete({ model, messages, signal });
  if (!isCloudModel(model) && !usePiForLocal()) return native.complete({ model, messages, signal });
  const m = resolve(model);
  const msg = await registry().complete(m, toContext(messages, [], m), { signal });
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(msg.errorMessage || `${m.provider} request failed`);
  }
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function abortError(signal) {
  const e = new Error(signal?.reason?.message || "aborted");
  e.name = "AbortError";
  return e;
}
