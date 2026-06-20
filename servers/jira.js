#!/usr/bin/env node

import { createMCPServer } from './shared.js';
import { JiraConnector } from '../connectors/jira.js';

const jira = new JiraConnector(
  process.env.JIRA_DOMAIN,
  process.env.JIRA_EMAIL,
  process.env.JIRA_API_TOKEN
);

await createMCPServer({
  name: 'refugio-jira',
  defaultPort: 3003,
  tools: [
    {
      name: 'search_issues',
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
      name: 'get_issue',
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
      name: 'get_projects',
      description: 'List accessible Jira projects.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'search_issues': return jira.searchIssues(args.jql, args.max_results);
      case 'get_issue': return jira.getIssue(args.issue_key);
      case 'get_projects': return jira.getProjects();
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
