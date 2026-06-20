import { google } from 'googleapis';

export class GoogleDocsConnector {
  constructor(clientId, clientSecret, refreshToken) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are required');
    }
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    this.docs = google.docs({ version: 'v1', auth });
  }

  /**
   * Replace entire document body with markdown content (as plain text).
   * Strategy: get endIndex → delete body → insert new text.
   */
  async replaceContent(documentId, markdownContent) {
    // Get current doc to find body endIndex
    const doc = await this.docs.documents.get({ documentId });
    const endIndex = doc.data.body.content.at(-1)?.endIndex || 1;

    const requests = [];

    // Delete existing content (if any beyond the trailing newline)
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1 },
        },
      });
    }

    // Insert new content at position 1
    requests.push({
      insertText: {
        location: { index: 1 },
        text: markdownContent,
      },
    });

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    return { synced: true, documentId };
  }
}
