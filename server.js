#!/usr/bin/env node

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
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SlackConnector } from './connectors/slack.js';
import { NotionConnector } from './connectors/notion.js';
import { JiraConnector } from './connectors/jira.js';
import { GitHubConnector } from './connectors/github.js';
import { ServiceNowConnector } from './connectors/servicenow.js';
import { SalesforceConnector } from './connectors/salesforce.js';
import { MemorySyncManager } from './connectors/memory-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Load secrets from ~/.refugio.env (outside workspace to prevent AI exposure)
import { homedir } from 'os';
dotenv.config({ path: join(homedir(), '.refugio.env'), override: true });

const SSE_PORT = process.env.MCP_SSE_PORT || 3001;

class RefugioMCPServer {
  constructor() {
    // Initialize each connector independently so one failure doesn't crash the rest
    try {
      const slackToken = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN;
      this.slack = new SlackConnector(slackToken, slackToken);
    } catch (e) {
      console.error('Slack connector failed to initialize:', e.message);
      this.slack = null;
    }

    try {
      this.notion = new NotionConnector(process.env.NOTION_TOKEN);
    } catch (e) {
      console.error('Notion connector failed to initialize:', e.message);
      this.notion = null;
    }

    try {
      this.jira = new JiraConnector(
        process.env.JIRA_DOMAIN,
        process.env.JIRA_EMAIL,
        process.env.JIRA_API_TOKEN
      );
    } catch (e) {
      console.error('Jira connector failed to initialize:', e.message);
      this.jira = null;
    }

    try {
      this.github = new GitHubConnector(
        process.env.GITHUB_TOKEN,
        process.env.GITHUB_OWNER,
        process.env.GITHUB_REPO,
        process.env.GITHUB_MEMORY_PATH || 'MEMORY.md'
      );
    } catch (e) {
      console.error('GitHub connector failed to initialize:', e.message);
      this.github = null;
    }

    try {
      this.servicenow = new ServiceNowConnector(
        process.env.SERVICENOW_INSTANCE,
        process.env.SERVICENOW_USERNAME,
        process.env.SERVICENOW_PASSWORD
      );
    } catch (e) {
      console.error('ServiceNow connector failed to initialize:', e.message);
      this.servicenow = null;
    }

    try {
      this.salesforce = new SalesforceConnector(
        process.env.SALESFORCE_INSTANCE_URL,
        process.env.SALESFORCE_USERNAME,
        process.env.SALESFORCE_PASSWORD,
        process.env.SALESFORCE_SECURITY_TOKEN
      );
    } catch (e) {
      console.error('Salesforce connector failed to initialize:', e.message);
      this.salesforce = null;
    }

    this.sync = null;
  }

  async initSync() {
    this.sync = new MemorySyncManager();
    await this.sync.init();
    if (this.sync.enabled) {
      console.error(`[memory] Sync targets: ${this.sync.targets.join(', ')}`);
    }
  }

  createServer() {
    const server = new Server(
      {
        name: 'refugio-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers(server);
    return server;
  }

  setupHandlers(server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // SLACK
        {
          name: 'slack_search_messages',
          description: 'Search Slack messages across all channels.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              count: { type: 'number', description: 'Results to return (max 100)', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'slack_get_channel_history',
          description: 'Get recent messages from a Slack channel.',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'string', description: 'Channel ID' },
              limit: { type: 'number', description: 'Message count (max 100)', default: 50 },
            },
            required: ['channel_id'],
          },
        },
        {
          name: 'slack_list_channels',
          description: 'List Slack channels and their IDs.',
          inputSchema: {
            type: 'object',
            properties: {
              types: { type: 'string', description: 'public_channel, private_channel, im, mpim', default: 'public_channel' },
            },
          },
        },
        {
          name: 'slack_get_thread',
          description: 'Get all replies in a Slack thread.',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'string' },
              thread_ts: { type: 'string', description: 'Parent message timestamp' },
            },
            required: ['channel_id', 'thread_ts'],
          },
        },

        // NOTION
        {
          name: 'notion_search',
          description: 'Search Notion pages and databases.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              filter: { type: 'string', enum: ['page', 'database'] },
            },
            required: ['query'],
          },
        },
        {
          name: 'notion_get_page',
          description: 'Get a Notion page with all content.',
          inputSchema: {
            type: 'object',
            properties: {
              page_id: { type: 'string' },
            },
            required: ['page_id'],
          },
        },
        {
          name: 'notion_get_block_children',
          description: 'Get child blocks of a Notion block or page.',
          inputSchema: {
            type: 'object',
            properties: {
              block_id: { type: 'string' },
              recursive: { type: 'boolean', default: false },
            },
            required: ['block_id'],
          },
        },
        {
          name: 'notion_query_database',
          description: 'Query a Notion database with filters and sorting.',
          inputSchema: {
            type: 'object',
            properties: {
              database_id: { type: 'string' },
              filter: { type: 'object', description: 'Notion filter object' },
              sorts: { type: 'array', description: 'Sort config array' },
            },
            required: ['database_id'],
          },
        },

        // JIRA
        {
          name: 'jira_search_issues',
          description: 'Search Jira issues using JQL.',
          inputSchema: {
            type: 'object',
            properties: {
              jql: { type: 'string', description: 'JQL query' },
              max_results: { type: 'number', default: 50 },
            },
            required: ['jql'],
          },
        },
        {
          name: 'jira_get_issue',
          description: 'Get details of a Jira issue.',
          inputSchema: {
            type: 'object',
            properties: {
              issue_key: { type: 'string', description: 'e.g. PROJ-1234' },
            },
            required: ['issue_key'],
          },
        },
        {
          name: 'jira_get_projects',
          description: 'List accessible Jira projects.',
          inputSchema: { type: 'object', properties: {} },
        },

        // MEMORY (GitHub-backed)
        {
          name: 'memory_get',
          description: 'Get persistent memory contents (markdown).',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'memory_update',
          description: 'Replace persistent memory with new markdown content.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Full markdown content' },
              message: { type: 'string', description: 'Commit message' },
            },
            required: ['content'],
          },
        },

        // SERVICENOW
        {
          name: 'servicenow_query_table',
          description: 'Query a ServiceNow table with optional filters.',
          inputSchema: {
            type: 'object',
            properties: {
              table: { type: 'string', description: 'e.g. incident, sys_user, cmdb_ci' },
              query: { type: 'string', description: 'Encoded query string' },
              fields: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number', default: 10 },
            },
            required: ['table'],
          },
        },
        {
          name: 'servicenow_get_record',
          description: 'Get a ServiceNow record by sys_id.',
          inputSchema: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              sys_id: { type: 'string' },
            },
            required: ['table', 'sys_id'],
          },
        },
        {
          name: 'servicenow_list_tables',
          description: 'List common ServiceNow tables.',
          inputSchema: { type: 'object', properties: {} },
        },

        // SALESFORCE
        {
          name: 'salesforce_soql_query',
          description: 'Run a SOQL query against Salesforce.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'SOQL query string' },
              limit: { type: 'number', default: 50 },
            },
            required: ['query'],
          },
        },
        {
          name: 'salesforce_get_record',
          description: 'Get a Salesforce record by object type and ID.',
          inputSchema: {
            type: 'object',
            properties: {
              object_type: { type: 'string', description: 'e.g. Account, Contact, Opportunity' },
              record_id: { type: 'string', description: 'Salesforce record ID' },
              fields: { type: 'array', items: { type: 'string' } },
            },
            required: ['object_type', 'record_id'],
          },
        },
        {
          name: 'salesforce_search',
          description: 'Global search across Salesforce objects (Accounts, Contacts, Opportunities, Cases, Leads).',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term' },
              limit: { type: 'number', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'salesforce_describe_object',
          description: 'Get the schema/fields of a Salesforce object.',
          inputSchema: {
            type: 'object',
            properties: {
              object_type: { type: 'string', description: 'e.g. Account, Contact, Opportunity' },
            },
            required: ['object_type'],
          },
        },
        {
          name: 'salesforce_list_objects',
          description: 'List available Salesforce objects.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        // SLACK HANDLERS
        if (name.startsWith('slack_')) {
          if (!this.slack) throw new Error('Slack connector not available. Check SLACK_TOKEN env var.');
          if (name === 'slack_search_messages') {
            const results = await this.slack.searchMessages(args.query, args.count);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'slack_get_channel_history') {
            const results = await this.slack.getChannelHistory(args.channel_id, args.limit);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'slack_list_channels') {
            const results = await this.slack.listChannels(args.types);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'slack_get_thread') {
            const results = await this.slack.getThread(args.channel_id, args.thread_ts);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        // NOTION HANDLERS
        if (name.startsWith('notion_')) {
          if (!this.notion) throw new Error('Notion connector not available. Check NOTION_TOKEN env var.');
          if (name === 'notion_search') {
            const results = await this.notion.search(args.query, args.filter);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'notion_get_page') {
            const results = await this.notion.getPage(args.page_id);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'notion_get_block_children') {
            const results = await this.notion.getBlockChildren(args.block_id, args.recursive);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'notion_query_database') {
            const results = await this.notion.queryDatabase(args.database_id, args.filter, args.sorts);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        // JIRA HANDLERS
        if (name.startsWith('jira_')) {
          if (!this.jira) throw new Error('Jira connector not available. Check JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars.');
          if (name === 'jira_search_issues') {
            const results = await this.jira.searchIssues(args.jql, args.max_results);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'jira_get_issue') {
            const results = await this.jira.getIssue(args.issue_key);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'jira_get_projects') {
            const results = await this.jira.getProjects();
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        // MEMORY HANDLERS (GitHub-backed)
        if (name.startsWith('memory_')) {
          if (!this.github) throw new Error('GitHub connector not available. Check GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO env vars.');
          if (name === 'memory_get') {
            const results = await this.github.getMemory();
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'memory_update') {
            const results = await this.github.updateMemory(args.content, args.message);
            if (this.sync?.enabled) {
              this.sync.sync(args.content).catch(() => {});
            }
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        // SERVICENOW HANDLERS
        if (name.startsWith('servicenow_')) {
          if (!this.servicenow) throw new Error('ServiceNow connector not available. Check SERVICENOW_INSTANCE, SERVICENOW_USERNAME, SERVICENOW_PASSWORD env vars.');
          if (name === 'servicenow_query_table') {
            const results = await this.servicenow.queryTable(args.table, args.query, args.fields, args.limit);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'servicenow_get_record') {
            const results = await this.servicenow.getRecord(args.table, args.sys_id);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'servicenow_list_tables') {
            const results = await this.servicenow.listTables();
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        // SALESFORCE HANDLERS
        if (name.startsWith('salesforce_')) {
          if (!this.salesforce) throw new Error('Salesforce connector not available. Check SALESFORCE_INSTANCE_URL, SALESFORCE_USERNAME, SALESFORCE_PASSWORD, SALESFORCE_SECURITY_TOKEN env vars.');
          if (name === 'salesforce_soql_query') {
            const results = await this.salesforce.soqlQuery(args.query, args.limit);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'salesforce_get_record') {
            const results = await this.salesforce.getRecord(args.object_type, args.record_id, args.fields);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'salesforce_search') {
            const results = await this.salesforce.globalSearch(args.query, args.limit);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'salesforce_describe_object') {
            const results = await this.salesforce.describeObject(args.object_type);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
          if (name === 'salesforce_list_objects') {
            const results = await this.salesforce.listObjects();
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          }
        }

        throw new Error(`Unknown tool: ${name}`);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  async run() {
    await this.initSync();
    const mode = process.argv[2];

    if (mode === '--http') {
      await this.startStreamableHTTP();
    } else if (mode === '--sse-only') {
      await this.startSSE();
    } else {
      const stdioServer = this.createServer();
      const transport = new StdioServerTransport();
      await stdioServer.connect(transport);
      console.error('REFUGIO MCP Server running on stdio');
    }
  }

  async startStreamableHTTP() {
    const sessions = {};

    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', port: SSE_PORT }));
        return;
      }

      if (req.url === '/mcp') {
        const sessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST') {
          if (sessionId && sessions[sessionId]) {
            const transport = sessions[sessionId];
            await transport.handleRequest(req, res);
            return;
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              sessions[sid] = transport;
            },
          });

          transport.onclose = () => {
            const sid = Object.keys(sessions).find(k => sessions[k] === transport);
            if (sid) delete sessions[sid];
          };

          const server = this.createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);

        } else if (req.method === 'GET') {
          if (sessionId && sessions[sessionId]) {
            const transport = sessions[sessionId];
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No valid session. Send an initialize request first.' }));
          }

        } else if (req.method === 'DELETE') {
          if (sessionId && sessions[sessionId]) {
            const transport = sessions[sessionId];
            await transport.handleRequest(req, res);
            delete sessions[sessionId];
          } else {
            res.writeHead(404);
            res.end('Session not found');
          }

        } else {
          res.writeHead(405);
          res.end('Method not allowed');
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(SSE_PORT, () => {
      console.error(`REFUGIO MCP Streamable HTTP listening on http://localhost:${SSE_PORT}/mcp`);
    });
  }

  async startSSE() {
    const sseServer = this.createServer();
    const transports = {};

    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        transports[transport.sessionId] = transport;
        res.on('close', () => { delete transports[transport.sessionId]; });
        await sseServer.connect(transport);
      } else if (req.url === '/messages' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const url = new URL(req.url, `http://localhost:${SSE_PORT}`);
          const sessionId = url.searchParams.get('sessionId');
          const transport = transports[sessionId];
          if (transport) {
            req.body = body;
            await transport.handlePostMessage(req, res);
          } else {
            res.writeHead(404);
            res.end('Session not found');
          }
        });
      } else if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'sse', port: SSE_PORT }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(SSE_PORT, () => {
      console.error(`REFUGIO MCP SSE listening on http://localhost:${SSE_PORT}/sse`);
    });
  }
}

const server = new RefugioMCPServer();
server.run().catch(console.error);
