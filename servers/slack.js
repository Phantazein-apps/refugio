#!/usr/bin/env node

import { createMCPServer } from './shared.js';
import { SlackConnector } from '../connectors/slack.js';

const token = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN;
const slack = new SlackConnector(token, token);

await createMCPServer({
  name: 'refugio-slack',
  defaultPort: 3001,
  tools: [
    {
      name: 'search_messages',
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
      name: 'get_channel_history',
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
      name: 'list_channels',
      description: 'List Slack channels and their IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          types: { type: 'string', description: 'public_channel, private_channel, im, mpim', default: 'public_channel' },
        },
      },
    },
    {
      name: 'get_thread',
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
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'search_messages': return slack.searchMessages(args.query, args.count);
      case 'get_channel_history': return slack.getChannelHistory(args.channel_id, args.limit);
      case 'list_channels': return slack.listChannels(args.types);
      case 'get_thread': return slack.getThread(args.channel_id, args.thread_ts);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
