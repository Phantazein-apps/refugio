import fetch from 'node-fetch';

export class SalesforceConnector {
  constructor(instanceUrl, username, password, securityToken) {
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.securityToken = securityToken || '';
    this.apiVersion = 'v62.0';
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  /**
   * Authenticate using the Salesforce Username-Password OAuth 2.0 flow.
   * Uses the SOAP login endpoint which doesn't require a Connected App.
   */
  async authenticate() {
    // Re-use token if we have one and it's less than 1 hour old
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return;
    }

    const loginUrl = `${this.instanceUrl}/services/oauth2/token`;
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: '3MVG9I9urWNgMpWNnRaBfMagVzfkW0UKoS5J0tKJ_gJ.I2lXjCh.BhpoMB.e4LGajFZxrqG0mbmZLTjEYPF0J', // Salesforce CLI default Connected App
      client_secret: '',
      username: this.username,
      password: this.password + this.securityToken,
    });

    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      let errorMsg;
      try {
        const parsed = JSON.parse(error);
        errorMsg = parsed.error_description || parsed.error || error;
      } catch {
        errorMsg = error;
      }
      throw new Error(`Salesforce authentication failed: ${errorMsg}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    // Token is valid for ~2 hours; refresh after 1 hour
    this.tokenExpiry = Date.now() + 60 * 60 * 1000;

    // Update instance URL if Salesforce redirects to a different pod
    if (data.instance_url) {
      this.instanceUrl = data.instance_url;
    }

    this.baseUrl = `${this.instanceUrl}/services/data/${this.apiVersion}`;
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    await this.authenticate();

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    // If we get a 401, clear token and retry once
    if (response.status === 401) {
      this.accessToken = null;
      this.tokenExpiry = 0;
      await this.authenticate();

      const retry = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : null,
      });

      if (!retry.ok) {
        const error = await retry.text();
        throw new Error(`Salesforce API error: ${retry.status} - ${error}`);
      }

      return retry.json();
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Salesforce API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async soqlQuery(query, limit = 50) {
    const limitedQuery = query.includes('LIMIT')
      ? query
      : `${query} LIMIT ${Math.min(limit, 200)}`;

    const data = await this.apiCall(`/query?q=${encodeURIComponent(limitedQuery)}`);

    return {
      total_size: data.totalSize,
      done: data.done,
      records: (data.records || []).map(r => {
        const { attributes, ...fields } = r;
        return {
          type: attributes?.type,
          url: attributes?.url,
          ...fields,
        };
      }),
    };
  }

  async getRecord(objectType, recordId, fields = null) {
    let endpoint = `/sobjects/${objectType}/${recordId}`;
    if (fields?.length) {
      endpoint += `?fields=${fields.join(',')}`;
    }

    const data = await this.apiCall(endpoint);
    const { attributes, ...fields_ } = data;

    return {
      type: attributes?.type,
      url: attributes?.url,
      ...fields_,
    };
  }

  async describeObject(objectType) {
    const data = await this.apiCall(`/sobjects/${objectType}/describe`);

    return {
      name: data.name,
      label: data.label,
      label_plural: data.labelPlural,
      key_prefix: data.keyPrefix,
      queryable: data.queryable,
      searchable: data.searchable,
      fields: data.fields?.map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length,
        required: !f.nillable && !f.defaultedOnCreate,
        updateable: f.updateable,
        reference_to: f.referenceTo?.length ? f.referenceTo : undefined,
      })) || [],
    };
  }

  async globalSearch(query, limit = 20) {
    const sosl = `FIND {${query}} IN ALL FIELDS RETURNING Account(Id,Name,Type,Industry LIMIT ${limit}), Contact(Id,Name,Email,Account.Name LIMIT ${limit}), Opportunity(Id,Name,StageName,Amount,CloseDate LIMIT ${limit}), Case(Id,CaseNumber,Subject,Status,Priority LIMIT ${limit}), Lead(Id,Name,Email,Company,Status LIMIT ${limit})`;

    const data = await this.apiCall(`/search?q=${encodeURIComponent(sosl)}`);

    const results = {};
    for (const group of data.searchRecords || []) {
      const type = group.attributes?.type;
      if (!results[type]) results[type] = [];
      const { attributes, ...fields } = group;
      results[type].push(fields);
    }

    return {
      query,
      results,
    };
  }

  async listObjects() {
    const data = await this.apiCall('/sobjects');

    return {
      objects: (data.sobjects || [])
        .filter(o => o.queryable && !o.deprecatedAndHidden)
        .map(o => ({
          name: o.name,
          label: o.label,
          key_prefix: o.keyPrefix,
          queryable: o.queryable,
          searchable: o.searchable,
          custom: o.custom,
        })),
    };
  }
}
