import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NotionConnector {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.notion.com/v1';
    this.notionVersion = '2022-06-28';
    this.index = null;
    this.indexPath = path.join(__dirname, '..', 'notion_index.json');
  }

  // Load the index from disk (lazy loading with caching)
  loadIndex() {
    if (this.index) return this.index;
    
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        this.index = JSON.parse(data);
        return this.index;
      }
    } catch (error) {
      console.error('Failed to load Notion index:', error.message);
    }
    return null;
  }

  // Search the local index for instant lookups
  async searchIndex(query, customer = null, limit = 20) {
    const index = this.loadIndex();
    
    if (!index) {
      return {
        error: 'Index not available. Run notion_indexer.js to build the index.',
        results: [],
      };
    }

    const queryLower = query.toLowerCase();
    const customerLower = customer?.toLowerCase();
    const results = [];

    // Search through all pages
    for (const [pageId, page] of Object.entries(index.pages)) {
      const titleMatch = page.title?.toLowerCase().includes(queryLower);
      const pathMatch = page.path_string?.toLowerCase().includes(queryLower);
      
      if (titleMatch || pathMatch) {
        // If customer filter is specified, check if page is under that customer
        if (customerLower) {
          const inCustomerPath = page.path?.some(p => 
            p.toLowerCase().includes(customerLower)
          );
          if (!inCustomerPath) continue;
        }
        
        results.push({
          id: page.id,
          title: page.title,
          path: page.path_string,
          url: page.url,
          depth: page.depth,
          child_count: page.child_count,
        });
      }
    }

    // Sort by relevance (exact title match first, then by depth)
    results.sort((a, b) => {
      const aExact = a.title?.toLowerCase() === queryLower;
      const bExact = b.title?.toLowerCase() === queryLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return a.depth - b.depth;
    });

    return {
      query,
      customer: customer || null,
      total_found: results.length,
      index_date: index.metadata?.created_at,
      results: results.slice(0, limit),
    };
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': this.notionVersion,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Notion API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async search(query, filter = null) {
    const body = {
      query,
      page_size: 20,
    };

    if (filter) {
      body.filter = { property: 'object', value: filter };
    }

    const data = await this.apiCall('/search', 'POST', body);

    return {
      results: data.results?.map((result) => ({
        id: result.id,
        type: result.object,
        title: this.extractTitle(result),
        url: result.url,
        last_edited: result.last_edited_time,
        created: result.created_time,
      })) || [],
    };
  }

  async getPage(pageId) {
    const cleanId = pageId.replace(/-/g, '');

    const page = await this.apiCall(`/pages/${cleanId}`);
    const blocks = await this.apiCall(`/blocks/${cleanId}/children`);

    return {
      id: page.id,
      title: this.extractTitle(page),
      url: page.url,
      created: page.created_time,
      last_edited: page.last_edited_time,
      properties: page.properties,
      content: this.extractBlockContent(blocks.results),
    };
  }

  async getBlockChildren(blockId, recursive = false) {
    const cleanId = blockId.replace(/-/g, '');
    const data = await this.apiCall(`/blocks/${cleanId}/children`);
    
    const blocks = data.results || [];
    
    if (recursive) {
      for (const block of blocks) {
        if (block.has_children) {
          const childData = await this.getBlockChildren(block.id, true);
          block.children = childData.children;
        }
      }
    }
    
    return {
      block_id: blockId,
      children: blocks.map(b => this.mapBlock(b))
    };
  }

  // Helper method to map blocks with all relevant metadata
  mapBlock(block) {
    const mapped = {
      id: block.id,
      type: block.type,
      has_children: block.has_children,
      text: this.getBlockText(block),
    };

    // Add title for child_page blocks
    if (block.type === 'child_page' && block.child_page) {
      mapped.title = block.child_page.title;
    }

    // Add title for child_database blocks
    if (block.type === 'child_database' && block.child_database) {
      mapped.title = block.child_database.title;
    }

    // Add URL for bookmark blocks
    if (block.type === 'bookmark' && block.bookmark) {
      mapped.url = block.bookmark.url;
    }

    // Add URL for embed blocks
    if (block.type === 'embed' && block.embed) {
      mapped.url = block.embed.url;
    }

    // Add URL for link_preview blocks
    if (block.type === 'link_preview' && block.link_preview) {
      mapped.url = block.link_preview.url;
    }

    // Add file info for file blocks
    if (block.type === 'file' && block.file) {
      mapped.file = {
        type: block.file.type,
        url: block.file.type === 'external' ? block.file.external?.url : block.file.file?.url,
        name: block.file.name,
      };
    }

    // Add image info for image blocks
    if (block.type === 'image' && block.image) {
      mapped.image = {
        type: block.image.type,
        url: block.image.type === 'external' ? block.image.external?.url : block.image.file?.url,
      };
    }

    // Add children if they were recursively fetched
    if (block.children) {
      mapped.children = block.children;
    }

    return mapped;
  }

  async queryDatabase(databaseId, filter = null, sorts = null) {
    const cleanId = databaseId.replace(/-/g, '');

    // Notion paginates database queries. Fetch all pages (bounded to avoid runaway).
    const pageSize = 100;
    const maxPages = 50; // safety cap: up to 5000 rows

    let start_cursor = undefined;
    let pageCount = 0;
    const allResults = [];

    while (pageCount < maxPages) {
      const body = { page_size: pageSize };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (start_cursor) body.start_cursor = start_cursor;

      const data = await this.apiCall(`/databases/${cleanId}/query`, 'POST', body);

      const batch = (data.results || []).map((page) => ({
        id: page.id,
        url: page.url,
        properties: this.extractProperties(page.properties),
        created: page.created_time,
        last_edited: page.last_edited_time,
      }));

      allResults.push(...batch);
      pageCount += 1;

      if (!data.has_more) break;
      start_cursor = data.next_cursor;
      if (!start_cursor) break;
    }

    return {
      results: allResults,
      fetched_pages: pageCount,
      truncated: pageCount >= maxPages,
    };
  }

  extractTitle(page) {
    if (page.properties?.title?.title?.[0]?.plain_text) {
      return page.properties.title.title[0].plain_text;
    }
    if (page.properties?.Name?.title?.[0]?.plain_text) {
      return page.properties.Name.title[0].plain_text;
    }
    for (const prop of Object.values(page.properties || {})) {
      if (prop.type === 'title' && prop.title?.[0]?.plain_text) {
        return prop.title[0].plain_text;
      }
    }
    return 'Untitled';
  }

  extractProperties(properties) {
    const extracted = {};
    
    for (const [key, prop] of Object.entries(properties)) {
      switch (prop.type) {
        case 'title':
          extracted[key] = prop.title?.[0]?.plain_text || '';
          break;
        case 'rich_text':
          extracted[key] = prop.rich_text?.[0]?.plain_text || '';
          break;
        case 'number':
          extracted[key] = prop.number;
          break;
        case 'select':
          extracted[key] = prop.select?.name;
          break;
        case 'multi_select':
          extracted[key] = prop.multi_select?.map(s => s.name);
          break;
        case 'date':
          extracted[key] = prop.date?.start;
          break;
        case 'checkbox':
          extracted[key] = prop.checkbox;
          break;
        case 'url':
          extracted[key] = prop.url;
          break;
        case 'email':
          extracted[key] = prop.email;
          break;
        case 'phone_number':
          extracted[key] = prop.phone_number;
          break;
        case 'status':
          extracted[key] = prop.status?.name;
          break;
        default:
          extracted[key] = prop[prop.type];
      }
    }
    
    return extracted;
  }

  extractBlockContent(blocks) {
    const content = [];

    for (const block of blocks) {
      const text = this.getBlockText(block);
      if (text) {
        content.push({
          type: block.type,
          text,
        });
      }
    }

    return content;
  }

  // --- Write methods (for memory sync) ---

  async clearPageBlocks(pageId) {
    const cleanId = pageId.replace(/-/g, '');
    const data = await this.apiCall(`/blocks/${cleanId}/children`);
    const blocks = data.results || [];
    for (const block of blocks) {
      await this.apiCall(`/blocks/${block.id}`, 'DELETE');
    }
    return blocks.length;
  }

  async replacePageContent(pageId, markdownContent) {
    const deleted = await this.clearPageBlocks(pageId);
    const blocks = this.markdownToBlocks(markdownContent);
    const cleanId = pageId.replace(/-/g, '');

    // Notion API accepts max 100 blocks per request
    for (let i = 0; i < blocks.length; i += 100) {
      await this.apiCall(`/blocks/${cleanId}/children`, 'PATCH', {
        children: blocks.slice(i, i + 100),
      });
    }

    return { synced: true, pageId, blocksDeleted: deleted, blocksCreated: blocks.length };
  }

  markdownToBlocks(markdown) {
    const lines = markdown.split('\n');
    const blocks = [];
    let inCode = false;
    let codeLang = '';
    let codeLines = [];

    for (const line of lines) {
      // Code fence toggle
      if (line.startsWith('```')) {
        if (inCode) {
          blocks.push(this._codeBlock(codeLines.join('\n'), codeLang));
          inCode = false;
          codeLines = [];
          codeLang = '';
        } else {
          inCode = true;
          codeLang = line.slice(3).trim() || 'plain text';
        }
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        continue;
      }

      // Headings
      if (line.startsWith('### ')) {
        blocks.push(this._heading(3, line.slice(4)));
      } else if (line.startsWith('## ')) {
        blocks.push(this._heading(2, line.slice(3)));
      } else if (line.startsWith('# ')) {
        blocks.push(this._heading(1, line.slice(2)));
      }
      // Bullet list
      else if (/^[-*] /.test(line)) {
        blocks.push(this._bulletItem(line.slice(2)));
      }
      // Numbered list
      else if (/^\d+\. /.test(line)) {
        blocks.push(this._numberedItem(line.replace(/^\d+\. /, '')));
      }
      // Blank lines: skip
      else if (line.trim() === '') {
        continue;
      }
      // Default: paragraph
      else {
        blocks.push(this._paragraph(line));
      }
    }

    // Close unclosed code fence
    if (inCode && codeLines.length) {
      blocks.push(this._codeBlock(codeLines.join('\n'), codeLang));
    }

    return blocks;
  }

  _richText(text) {
    // Notion rich_text has a 2000-char limit per element
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) {
      chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
    }
    return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
  }

  _heading(level, text) {
    const key = `heading_${level}`;
    return { object: 'block', type: key, [key]: { rich_text: this._richText(text) } };
  }

  _paragraph(text) {
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: this._richText(text) } };
  }

  _bulletItem(text) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: this._richText(text) } };
  }

  _numberedItem(text) {
    return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: this._richText(text) } };
  }

  _codeBlock(text, language = 'plain text') {
    return { object: 'block', type: 'code', code: { rich_text: this._richText(text), language } };
  }

  getBlockText(block) {
    const blockType = block.type;
    const blockData = block[blockType];

    if (!blockData) return null;

    // Handle table_row blocks - cells is an array of arrays of rich_text
    if (blockType === 'table_row' && blockData.cells) {
      const cellTexts = blockData.cells.map(cell =>
        cell.map(rt => rt.plain_text || '').join('')
      );
      return cellTexts.join(' | ');
    }

    // Handle table blocks - return metadata about the table
    if (blockType === 'table') {
      return `[Table: ${blockData.table_width} columns]`;
    }

    if (blockData.rich_text) {
      return blockData.rich_text.map(rt => rt.plain_text).join('');
    }

    return null;
  }
}
