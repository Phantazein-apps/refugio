#!/usr/bin/env node

/**
 * One-time OAuth2 setup for Google Docs memory sync.
 *
 * Prerequisites:
 *   1. Go to console.cloud.google.com
 *   2. Create a project (or use an existing one)
 *   3. Enable the Google Docs API
 *   4. Go to Credentials → Create Credentials → OAuth client ID
 *   5. Application type: Desktop app
 *   6. Copy the Client ID and Client Secret
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.js
 *
 * The script opens a browser auth flow, then prints the refresh token
 * to add to ~/.refugio.env.
 */

import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 3000;

if (!clientId || !clientSecret) {
  console.error('Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET');
  console.error('');
  console.error('Usage:');
  console.error('  GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.js');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  clientId,
  clientSecret,
  `http://localhost:${PORT}/callback`
);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/documents'],
  prompt: 'consent',
});

console.log('Opening browser for Google authorization...\n');
console.log('If the browser does not open, visit this URL:\n');
console.log(authUrl);
console.log('');

// Open browser (best effort)
import('child_process').then(({ exec }) => {
  const cmd = process.platform === 'darwin' ? 'open' :
              process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${authUrl}"`);
});

// Start temporary server to capture the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization denied.</h2><p>You can close this tab.</p>');
      console.error(`\nAuthorization denied: ${error}`);
      server.close();
      process.exit(1);
    }

    try {
      const { tokens } = await oauth2.getToken(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Success!</h2><p>You can close this tab and return to the terminal.</p>');

      console.log('\n✅ Authorization successful!\n');
      console.log('Add these to ~/.refugio.env:\n');
      console.log(`GOOGLE_CLIENT_ID=${clientId}`);
      console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log(`GOOGLE_DOC_ID=<your-google-doc-id>`);
      console.log('\nGet the doc ID from the Google Docs URL:');
      console.log('https://docs.google.com/document/d/<DOC_ID>/edit');
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Error</h2><p>Failed to get tokens. Check the terminal.</p>');
      console.error('\nFailed to exchange code for tokens:', err.message);
    }

    server.close();
    process.exit(0);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Waiting for callback on http://localhost:${PORT}/callback ...\n`);
});
