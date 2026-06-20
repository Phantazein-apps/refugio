#!/usr/bin/env node

import { createMCPServer } from './shared.js';
import { SalesforceConnector } from '../connectors/salesforce.js';

const sf = new SalesforceConnector(
  process.env.SALESFORCE_INSTANCE_URL,
  process.env.SALESFORCE_USERNAME,
  process.env.SALESFORCE_PASSWORD,
  process.env.SALESFORCE_SECURITY_TOKEN
);

await createMCPServer({
  name: 'refugio-salesforce',
  defaultPort: 3007,
  tools: [
    {
      name: 'soql_query',
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
      name: 'get_record',
      description: 'Get a Salesforce record by object type and ID.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: { type: 'string', description: 'e.g. Account, Contact, Opportunity' },
          record_id: { type: 'string', description: 'Salesforce record ID' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Specific fields to return' },
        },
        required: ['object_type', 'record_id'],
      },
    },
    {
      name: 'search',
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
      name: 'describe_object',
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
      name: 'list_objects',
      description: 'List available Salesforce objects.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'soql_query': return sf.soqlQuery(args.query, args.limit);
      case 'get_record': return sf.getRecord(args.object_type, args.record_id, args.fields);
      case 'search': return sf.globalSearch(args.query, args.limit);
      case 'describe_object': return sf.describeObject(args.object_type);
      case 'list_objects': return sf.listObjects();
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
