// Try the Claude Code engine against the real `claude`, outside the chat window.
//
//   node scripts/claude-code-probe.mjs            # sonnet, one tool round
//   node scripts/claude-code-probe.mjs haiku      # another alias
//
// Needs Claude Code installed and signed in (run `claude` once and sign in).
// Uses your subscription: one short conversation per run. The tool is a fake
// reminders list answered here, so none of your data is read or sent.
import { chatStream } from "../chat/claude-code.js";

const model = `claude-code/${process.argv[2] || "sonnet"}`;
const TOOL = { type: "function", function: {
  name: "reminders__list", description: "List the user's reminders due today",
  parameters: { type: "object", properties: { list: { type: "string", description: "List name" } } } } };

const env = { ...process.env, REFUGIO_CLAUDE_FIRST_EVENT_MS: process.env.REFUGIO_CLAUDE_FIRST_EVENT_MS || "30000" };
const messages = [
  { role: "system", content: "You are REFUGIO, a private assistant. Use tools when the person asks about their own data." },
  { role: "user", content: "What reminders do I have today?" },
];
const ac = new AbortController();
const t0 = Date.now();
try {
  for (let round = 1; round <= 3; round++) {
    process.stdout.write(`\n[round ${round}] `);
    const out = await chatStream({ model, messages, tools: [TOOL], signal: ac.signal },
      (t) => process.stdout.write(t), () => process.stdout.write("·"), env);
    console.log(`\n  usage ${JSON.stringify(out.usage)} · calls ${JSON.stringify(out.toolCalls)}`);
    if (!out.toolCalls.length) break;
    messages.push({ role: "assistant", content: out.text, tool_calls: out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
    for (const c of out.toolCalls) messages.push({ role: "tool", tool_name: c.name, content: "- Call the dentist (9:00)\n- Buy oat milk" });
  }
  console.log(`\nok in ${Date.now() - t0} ms`);
} catch (e) {
  console.log(`\nfailed after ${Date.now() - t0} ms: ${e.message}`);
  process.exitCode = 1;
} finally {
  ac.abort();
}
