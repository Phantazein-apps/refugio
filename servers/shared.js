import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import http from 'http';
import { homedir } from 'os';
import { join } from 'path';

// Load shared env
dotenv.config({ path: join(homedir(), '.refugio.env'), override: true });

/**
 * Create and run a standalone MCP server.
 * @param {object} opts
 * @param {string} opts.name - Server name (e.g. 'refugio-slack')
 * @param {Array} opts.tools - Tool definitions array
 * @param {function} opts.handler - async (name, args) => result object
 * @param {number} [opts.defaultPort] - HTTP/SSE port (default 3001)
 */
export async function createMCPServer({ name, tools, handler, defaultPort = 3001 }) {
  const port = process.env.MCP_SSE_PORT || defaultPort;

  // Retry listen with back-off when the port is still held by a dying process
  function listenWithRetry(server, retries = 5, delay = 1000) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        server.listen(port, () => resolve());
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && n > 0) {
            console.error(`[${name}] Port ${port} busy, retrying in ${delay}ms (${n} left)…`);
            setTimeout(() => { server.removeAllListeners('error'); attempt(n - 1); }, delay);
          } else {
            reject(err);
          }
        });
      };
      attempt(retries);
    });
  }

  // Graceful shutdown — release the port immediately so restarts don't EADDRINUSE
  function onShutdown(httpServer) {
    const shutdown = (signal) => {
      console.error(`[${name}] ${signal} received, shutting down…`);
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 3000); // force exit after 3s
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  function buildServer() {
    const server = new Server(
      { name, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name: toolName, arguments: args } = request.params;
        const result = await handler(toolName, args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const code = error.code || error.cause?.code || '';
        let errMsg;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
          errMsg = `Connection failed: Could not reach the service. Check that credentials are correct and the service is accessible.`;
        } else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
          errMsg = `Request timed out: The service took too long to respond. Try again or use a simpler query.`;
        } else if (error.message?.includes('401') || error.message?.includes('403') || error.message?.includes('invalid_auth')) {
          errMsg = `Authentication failed: The credentials for this service are invalid or expired. Re-run the installer or edit ~/.refugio.env to update them.`;
        } else {
          errMsg = error.message;
        }
        console.error(`[${name}] Tool error (${request.params.name}): ${error.message}`);
        return {
          content: [{ type: 'text', text: `Error: ${errMsg}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  const mode = process.argv[2];

  if (mode === '--http') {
    const sessions = {};
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: name, transport: 'streamable-http', port }));
        return;
      }

      if (req.url === '/mcp') {
        const sessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
            return;
          }
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => { sessions[sid] = transport; },
            enableJsonResponse: true,
          });
          transport.onclose = () => {
            const sid = Object.keys(sessions).find(k => sessions[k] === transport);
            if (sid) delete sessions[sid];
          };
          const server = buildServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } else if (req.method === 'GET') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No valid session. Send an initialize request first.' }));
          }
        } else if (req.method === 'DELETE') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
            delete sessions[sessionId];
          } else { res.writeHead(404); res.end('Session not found'); }
        } else { res.writeHead(405); res.end('Method not allowed'); }
      } else { res.writeHead(404); res.end('Not found'); }
    });

    await listenWithRetry(httpServer);
    onShutdown(httpServer);
    console.error(`${name} — Streamable HTTP on http://localhost:${port}/mcp`);

  } else if (mode === '--sse-only') {
    const sseServer = buildServer();
    const transports = {};
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        transports[transport.sessionId] = transport;
        res.on('close', () => { delete transports[transport.sessionId]; });
        await sseServer.connect(transport);
      } else if (req.url === '/messages' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const url = new URL(req.url, `http://localhost:${port}`);
          const sessionId = url.searchParams.get('sessionId');
          const transport = transports[sessionId];
          if (transport) {
            req.body = body;
            await transport.handlePostMessage(req, res);
          } else { res.writeHead(404); res.end('Session not found'); }
        });
      } else if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: name, transport: 'sse', port }));
      } else { res.writeHead(404); res.end('Not found'); }
    });

    await listenWithRetry(httpServer);
    onShutdown(httpServer);
    console.error(`${name} — SSE on http://localhost:${port}/sse`);

  } else {
    // stdio
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${name} — running on stdio`);
  }
}
