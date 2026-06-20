#!/usr/bin/env node

import { createMCPServer } from './shared.js';
import { NotionConnector } from '../connectors/notion.js';

const notion = new NotionConnector(process.env.NOTION_TOKEN);

await createMCPServer({
  name: 'refugio-notion',
  defaultPort: 3002,
  tools: [
    {
      name: 'search',
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
      name: 'get_page',
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
      name: 'get_block_children',
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
      name: 'query_database',
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
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'search': return notion.search(args.query, args.filter);
      case 'get_page': return notion.getPage(args.page_id);
      case 'get_block_children': return notion.getBlockChildren(args.block_id, args.recursive);
      case 'query_database': return notion.queryDatabase(args.database_id, args.filter, args.sorts);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
