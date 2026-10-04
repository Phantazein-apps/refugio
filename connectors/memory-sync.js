/**
 * Orchestrates optional 1-way sync from GitHub memory to Google Docs and/or Notion.
 * Sync is non-blocking — failures are logged but never propagate to the caller.
 */

export class MemorySyncManager {
  constructor() {
    this.targets = [];
    this.notionConnector = null;
    this.notionPageId = null;
    this.googleDocsConnector = null;
    this.googleDocId = null;
  }

  async init() {
    // Notion sync: needs NOTION_TOKEN + NOTION_SYNC_PAGE_ID
    if (process.env.NOTION_TOKEN && process.env.NOTION_SYNC_PAGE_ID) {
      const { NotionConnector } = await import('./notion.js');
      this.notionConnector = new NotionConnector(process.env.NOTION_TOKEN);
      this.notionPageId = process.env.NOTION_SYNC_PAGE_ID;
      this.targets.push('notion');
    }

    // Google Docs sync: needs all four GOOGLE_* vars
    if (process.env.GOOGLE_DOC_ID && process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
      // googleapis is an optional dependency — ~200 MB that nothing else
      // needs, left out of REFUGIO.app. Without it, memory still works; only
      // this sync target is missing, and that is said rather than crashing
      // the memory server over it.
      try {
        const { GoogleDocsConnector } = await import('./google-docs.js');
        this.googleDocsConnector = new GoogleDocsConnector(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REFRESH_TOKEN
        );
        this.googleDocId = process.env.GOOGLE_DOC_ID;
        this.targets.push('google-docs');
      } catch (e) {
        console.error(`Google Docs sync is configured but unavailable (${e.message}). ` +
          'Install it with `npm install googleapis` in the REFUGIO directory.');
      }
    }
  }

  get enabled() {
    return this.targets.length > 0;
  }

  /**
   * Fire-and-forget sync to all configured targets.
   * Each target is independent — one failure doesn't affect the other.
   */
  async sync(content) {
    const promises = [];

    if (this.notionConnector) {
      promises.push(
        this.notionConnector.replacePageContent(this.notionPageId, content)
          .then(() => console.error('[sync] Notion: ok'))
          .catch(err => console.error('[sync] Notion: failed -', err.message))
      );
    }

    if (this.googleDocsConnector) {
      promises.push(
        this.googleDocsConnector.replaceContent(this.googleDocId, content)
          .then(() => console.error('[sync] Google Docs: ok'))
          .catch(err => console.error('[sync] Google Docs: failed -', err.message))
      );
    }

    await Promise.allSettled(promises);
  }
}
