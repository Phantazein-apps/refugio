// An MCP server that does what Hermeneia does when its input closes: nothing.
// It keeps running until it is signalled, and writes its pid where
// STUBBORN_PID_FILE says, so test/shutdown.test.js can check it is gone.
import { writeFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

writeFileSync(process.env.STUBBORN_PID_FILE, String(process.pid));
const server = new Server({ name: "stubborn", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }],
}));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => {});          // input closed: ignored, on purpose
setInterval(() => {}, 1000);                 // and stay up
