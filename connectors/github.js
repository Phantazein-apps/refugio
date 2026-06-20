import fetch from 'node-fetch';

export class GitHubConnector {
  constructor(token, owner, repo, memoryPath = 'MEMORY.md') {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    if (!owner) throw new Error('GITHUB_OWNER is required');
    if (!repo) throw new Error('GITHUB_REPO is required');
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.memoryPath = memoryPath;
    this.baseUrl = 'https://api.github.com';
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getMemory() {
    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${this.memoryPath}`
    );

    if (!data) {
      return { content: '', sha: null, last_modified: null };
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return {
      content,
      sha: data.sha,
      last_modified: data.last_modified || null,
    };
  }

  async updateMemory(content, message = 'Update memory') {
    // Get current SHA for optimistic concurrency
    const current = await this.getMemory();

    const body = {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    };

    // Include SHA if file already exists (required for updates)
    if (current.sha) {
      body.sha = current.sha;
    }

    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${this.memoryPath}`,
      'PUT',
      body
    );

    return {
      sha: data.content?.sha,
      commit_url: data.commit?.html_url,
    };
  }
}
