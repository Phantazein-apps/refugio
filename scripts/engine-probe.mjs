// Spike probe: the same tool round and answer through each engine path, per
// model, so the two can be compared on the machine that will run them.
//
//   node scripts/engine-probe.mjs qwen2.5:3b qwen3:4b
//   ANTHROPIC_API_KEY=… node scripts/engine-probe.mjs anthropic/claude-haiku-4-5
import { chatStream, isCloudModel } from "../chat/engine.js";

const TOOL = { type: "function", function: {
  name: "reminders__list", description: "List the user's reminders due today",
  parameters: { type: "object", properties: { list: { type: "string", description: "List name" } } } } };

async function turn(model) {
  const messages = [
    { role: "system", content: "You are REFUGIO. Use tools when the user asks about their own data." },
    { role: "user", content: "What reminders do I have today?" },
  ];
  const t0 = Date.now();
  let first = null;
  let thinking = 0;
  const rounds = [];
  for (let r = 0; r < 3; r++) {
    const out = await chatStream({ model, messages, tools: [TOOL], signal: AbortSignal.timeout(240000) },
      () => { first ??= Date.now() - t0; }, () => { thinking++; });
    rounds.push({
      calls: out.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`),
      usage: out.usage,
      text: out.text.slice(0, 160),
    });
    if (!out.toolCalls.length) break;
    messages.push({ role: "assistant", content: out.text, tool_calls: out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
    for (const c of out.toolCalls) messages.push({ role: "tool", tool_name: c.name, content: "- Call the dentist (9:00)\n- Buy oat milk" });
  }
  return { ms: Date.now() - t0, firstTokenMs: first, thinkingChunks: thinking, rounds };
}

for (const model of process.argv.slice(2)) {
  for (const lib of isCloudModel(model) ? ["pi"] : ["native", "pi"]) {
    process.env.REFUGIO_ENGINE_LIB = lib === "pi" ? "pi" : "";
    try { console.log(JSON.stringify({ model, lib, ...(await turn(model)) })); }
    catch (e) { console.log(JSON.stringify({ model, lib, error: e.message })); }
  }
}
