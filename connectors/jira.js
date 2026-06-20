import fetch from 'node-fetch';

export class JiraConnector {
  constructor(domain, email, apiToken) {
    this.domain = domain;
    this.email = email;
    this.apiToken = apiToken;
    this.baseUrl = `https://${domain}/rest/api/3`;
    
    this.auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${this.auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jira API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async searchIssues(jql, maxResults = 50) {
    const data = await this.apiCall('/search/jql', 'POST', {
      jql,
      maxResults: Math.min(maxResults, 100),
      fields: [
        'summary',
        'status',
        'priority',
        'assignee',
        'reporter',
        'created',
        'updated',
        'description',
        'labels',
        'components',
        'fixVersions',
      ],
    });

    return {
      total: data.total,
      issues: data.issues?.map((issue) => ({
        key: issue.key,
        id: issue.id,
        summary: issue.fields.summary,
        status: issue.fields.status?.name,
        priority: issue.fields.priority?.name,
        assignee: issue.fields.assignee?.displayName,
        reporter: issue.fields.reporter?.displayName,
        created: issue.fields.created,
        updated: issue.fields.updated,
        labels: issue.fields.labels,
        components: issue.fields.components?.map(c => c.name),
        fix_versions: issue.fields.fixVersions?.map(v => v.name),
        url: `https://${this.domain}/browse/${issue.key}`,
      })) || [],
    };
  }

  async getIssue(issueKey) {
    const issue = await this.apiCall(`/issue/${issueKey}`);

    let comments = [];
    try {
      const commentData = await this.apiCall(`/issue/${issueKey}/comment`);
      comments = commentData.comments?.map(c => ({
        author: c.author?.displayName,
        body: c.body?.content?.map(p => 
          p.content?.map(t => t.text).join(' ')
        ).join('\n'),
        created: c.created,
        updated: c.updated,
      })) || [];
    } catch (e) {
      // Comments might not be accessible
    }

    return {
      key: issue.key,
      id: issue.id,
      summary: issue.fields.summary,
      description: this.extractDescription(issue.fields.description),
      status: issue.fields.status?.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName,
      reporter: issue.fields.reporter?.displayName,
      created: issue.fields.created,
      updated: issue.fields.updated,
      labels: issue.fields.labels,
      components: issue.fields.components?.map(c => c.name),
      fix_versions: issue.fields.fixVersions?.map(v => v.name),
      comments,
      url: `https://${this.domain}/browse/${issue.key}`,
    };
  }

  async getProjects() {
    const data = await this.apiCall('/project/search');

    return {
      projects: data.values?.map((project) => ({
        key: project.key,
        name: project.name,
        id: project.id,
        project_type: project.projectTypeKey,
        lead: project.lead?.displayName,
        url: `https://${this.domain}/browse/${project.key}`,
      })) || [],
    };
  }

  extractDescription(description) {
    if (!description) return '';

    if (description.content) {
      return description.content.map(node => {
        if (node.type === 'paragraph' && node.content) {
          return node.content.map(t => t.text || '').join('');
        }
        return '';
      }).filter(Boolean).join('\n');
    }

    return description;
  }
}
