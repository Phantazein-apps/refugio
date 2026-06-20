#!/usr/bin/env node

/**
 * Notion Page Indexer
 *
 * Recursively crawls Notion pages and builds a searchable JSON index.
 * Root pages are configured in notion_roots.json (not committed to git).
 *
 * Usage:
 *   node notion_indexer.js [options] [page-ids...]
 *
 * Options:
 *   --all           Index all configured root pages
 *   --incremental   Only index pages modified since last run
 *   --list          List all configured root pages
 *   --init          Create a starter notion_roots.json
 *   --help          Show this help message
 *
 * Examples:
 *   node notion_indexer.js --init                     # Create config file
 *   node notion_indexer.js --all                      # Index all root pages
 *   node notion_indexer.js 2a0215fa8a724c61...        # Index specific page(s)
 *   node notion_indexer.js --incremental              # Update recently modified
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

dotenv.config({ path: join(homedir(), '.refugio.env'), override: true });

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_DELAY = 350;
const INDEX_FILE = 'notion_index.json';
const ROOTS_FILE = 'notion_roots.json';

// Load root pages from config file
function loadRootPages() {
  if (!existsSync(ROOTS_FILE)) {
    return [];
  }
  try {
    const data = readFileSync(ROOTS_FILE, 'utf-8');
    const config = JSON.parse(data);
    return config.root_pages || [];
  } catch (e) {
    console.error(`Failed to load ${ROOTS_FILE}:`, e.message);
    return [];
  }
}

const ALL_ROOT_PAGES = loadRootPages();

// Index storage
let index = {
  metadata: {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_pages: [],
    total_pages: 0,
    max_depth: 0,
  },
  pages: {},
  by_title: {},
  by_path: {},
  hierarchy: {},
};

let stats = {
  pages_crawled: 0,
  api_calls: 0,
  errors: [],
  start_time: null,
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiCall(endpoint) {
  stats.api_calls++;

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Notion API error: ${response.status} - ${error}`);
  }

  await sleep(RATE_LIMIT_DELAY);
  return response.json();
}

async function getPageTitle(pageId) {
  try {
    const page = await apiCall(`/pages/${pageId}`);
    return extractTitle(page);
  } catch (e) {
    return null;
  }
}

function extractTitle(page) {
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

async function crawlPage(pageId, parentId, path, depth, rootName) {
  const cleanId = pageId.replace(/-/g, '');

  console.log(`[CRAWL] depth=${depth} id=${cleanId.substring(0,8)}...`);

  if (index.hierarchy[cleanId]) {
    console.log(`  [SKIP] Already crawled`);
    return;
  }

  try {
    console.log(`  [API ${stats.api_calls + 1}] Fetching children...`);
    const data = await apiCall(`/blocks/${cleanId}/children?page_size=100`);
    const childPages = data.results?.filter(b => b.type === 'child_page') || [];
    console.log(`  [FOUND] ${childPages.length} child pages`);

    let title = rootName;
    if (!title) {
      const configured = ALL_ROOT_PAGES.find(r => r.id.replace(/-/g, '') === cleanId);
      title = configured?.name || await getPageTitle(cleanId) || `Page ${cleanId.substring(0, 8)}`;
    }

    const currentPath = [...path, title];
    console.log(`  [TITLE] ${title}`);

    index.pages[cleanId] = {
      id: cleanId,
      title: title,
      path: currentPath,
      path_string: currentPath.join(' > '),
      parent_id: parentId,
      depth: depth,
      child_count: childPages.length,
      url: `https://www.notion.so/${cleanId}`,
      indexed_at: new Date().toISOString(),
    };

    const titleLower = title.toLowerCase();
    if (!index.by_title[titleLower]) {
      index.by_title[titleLower] = [];
    }
    if (!index.by_title[titleLower].includes(cleanId)) {
      index.by_title[titleLower].push(cleanId);
    }

    index.by_path[currentPath.join(' > ')] = cleanId;

    index.hierarchy[cleanId] = {
      parent_id: parentId,
      children: childPages.map(c => c.id.replace(/-/g, '')),
    };

    stats.pages_crawled++;
    index.metadata.total_pages = Object.keys(index.pages).length;
    index.metadata.max_depth = Math.max(index.metadata.max_depth, depth);

    for (const child of childPages) {
      const childId = child.id.replace(/-/g, '');
      const childTitle = child.child_page?.title || 'Untitled';
      await crawlPage(childId, cleanId, currentPath, depth + 1, childTitle);
    }

  } catch (error) {
    stats.errors.push({
      page_id: cleanId,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    console.error(`  Error crawling ${cleanId}: ${error.message}`);
  }
}

function loadExistingIndex() {
  try {
    if (existsSync(INDEX_FILE)) {
      const data = readFileSync(INDEX_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load existing index:', e.message);
  }
  return null;
}

async function saveIndex() {
  index.metadata.updated_at = new Date().toISOString();
  index.metadata.total_pages = Object.keys(index.pages).length;
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

function createStarterConfig() {
  if (existsSync(ROOTS_FILE)) {
    console.log(`${ROOTS_FILE} already exists. Delete it first if you want to start over.`);
    return;
  }

  const starter = {
    root_pages: [
      { id: 'paste-your-notion-page-id-here', name: 'My First Root Page' },
      { id: 'another-page-id', name: 'Another Root Page' },
    ],
  };

  writeFileSync(ROOTS_FILE, JSON.stringify(starter, null, 2));
  console.log(`Created ${ROOTS_FILE} — edit it with your Notion page IDs and names.`);
  console.log('');
  console.log('To find a Notion page ID:');
  console.log('  1. Open the page in Notion');
  console.log('  2. Click "Share" → "Copy link"');
  console.log('  3. The ID is the 32-character hex string at the end of the URL');
  console.log('');
  console.log('Example URL: https://www.notion.so/workspace/My-Page-abc123def456...');
  console.log('Page ID:     abc123def456...');
}

function showHelp() {
  console.log(`
Notion Page Indexer

Builds a searchable JSON index of your Notion workspace by crawling
pages recursively from configured root pages.

Usage:
  node notion_indexer.js [options] [page-ids...]

Options:
  --init          Create a starter ${ROOTS_FILE} config file
  --all           Index all configured root pages (${ALL_ROOT_PAGES.length} pages)
  --incremental   Only update the index (merge with existing)
  --list          List all configured root pages
  --help          Show this help message

Setup:
  1. Run: node notion_indexer.js --init
  2. Edit ${ROOTS_FILE} with your Notion page IDs
  3. Run: node notion_indexer.js --all

Examples:
  node notion_indexer.js --all
  node notion_indexer.js --all --incremental
  node notion_indexer.js abc123def456789...
`);
}

function listRoots() {
  if (ALL_ROOT_PAGES.length === 0) {
    console.log(`\nNo root pages configured. Run 'node notion_indexer.js --init' to create ${ROOTS_FILE}\n`);
    return;
  }
  console.log('\nConfigured Root Pages:\n');
  for (const root of ALL_ROOT_PAGES) {
    console.log(`  ${root.id}  ${root.name}`);
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--init')) {
    createStarterConfig();
    process.exit(0);
  }

  if (args.includes('--list')) {
    listRoots();
    process.exit(0);
  }

  if (!NOTION_TOKEN) {
    console.error('Error: NOTION_TOKEN environment variable is required');
    console.error('Add it to ~/.refugio.env');
    process.exit(1);
  }

  const useAll = args.includes('--all');
  const incremental = args.includes('--incremental');
  const pageIds = args.filter(a => !a.startsWith('--'));

  let rootsToCrawl = [];

  if (useAll) {
    if (ALL_ROOT_PAGES.length === 0) {
      console.error(`No root pages configured. Run 'node notion_indexer.js --init' to create ${ROOTS_FILE}`);
      process.exit(1);
    }
    rootsToCrawl = ALL_ROOT_PAGES;
  } else if (pageIds.length > 0) {
    rootsToCrawl = pageIds.map(id => {
      const cleanId = id.replace(/-/g, '');
      const configured = ALL_ROOT_PAGES.find(r => r.id.replace(/-/g, '') === cleanId);
      return configured || { id: cleanId, name: null };
    });
  } else {
    showHelp();
    process.exit(1);
  }

  if (incremental) {
    const existing = loadExistingIndex();
    if (existing) {
      console.log(`Loaded existing index with ${Object.keys(existing.pages).length} pages`);
      index = existing;
      index.hierarchy = {};
    }
  }

  index.metadata.root_pages = rootsToCrawl;
  stats.start_time = Date.now();

  console.log('');
  console.log('='.repeat(60));
  console.log('NOTION PAGE INDEXER');
  console.log('='.repeat(60));
  console.log(`Root pages to crawl: ${rootsToCrawl.length}`);
  console.log(`Mode: ${incremental ? 'Incremental' : 'Full'}`);
  console.log('');

  for (const root of rootsToCrawl) {
    console.log(`\n>> Crawling: ${root.name || root.id}`);
    await crawlPage(root.id, null, [], 0, root.name);
  }

  await saveIndex();

  const duration = ((Date.now() - stats.start_time) / 1000).toFixed(1);

  console.log('');
  console.log('='.repeat(60));
  console.log('INDEXING COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total pages indexed: ${Object.keys(index.pages).length}`);
  console.log(`API calls made: ${stats.api_calls}`);
  console.log(`Time elapsed: ${duration}s`);
  console.log(`Errors: ${stats.errors.length}`);
  console.log(`\nSaved: ${INDEX_FILE}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors encountered:');
    for (const err of stats.errors.slice(0, 10)) {
      console.log(`  - ${err.page_id}: ${err.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`  ... and ${stats.errors.length - 10} more`);
    }
  }
}

main().catch(console.error);
