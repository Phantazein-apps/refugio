import fetch from 'node-fetch';

export class ServiceNowConnector {
  constructor(instance, username, password) {
    this.instance = instance;
    this.baseUrl = `https://${instance}/api/now`;
    this.auth = Buffer.from(`${username}:${password}`).toString('base64');
  }

  async apiCall(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ServiceNow API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async queryTable(table, query = null, fields = null, limit = 10) {
    const params = {
      sysparm_limit: Math.min(limit, 100),
    };

    if (query) params.sysparm_query = query;

    // Default to common fields to avoid 60KB+ responses that blow out LLM context windows
    if (fields?.length) {
      params.sysparm_fields = fields.join(',');
    } else {
      params.sysparm_fields = 'number,short_description,priority,state,assigned_to,opened_at,sys_updated_on,category';
    }

    const data = await this.apiCall(`/table/${table}`, params);

    return {
      table,
      count: data.result?.length || 0,
      records: data.result || [],
    };
  }

  async getRecord(table, sysId) {
    const data = await this.apiCall(`/table/${table}/${sysId}`);

    return {
      table,
      record: data.result || null,
    };
  }

  async listTables(limit = 50) {
    const data = await this.apiCall('/table/sys_db_object', {
      sysparm_query: 'super_class.name=task^ORsuper_class.name=cmdb_ci^ORname=incident^ORname=problem^ORname=change_request^ORname=sc_request^ORname=sc_req_item^ORname=kb_knowledge',
      sysparm_fields: 'name,label,super_class',
      sysparm_limit: Math.min(limit, 200),
    });

    return {
      tables: (data.result || []).map(t => ({
        name: t.name,
        label: t.label,
        super_class: t.super_class?.value,
      })),
    };
  }
}
