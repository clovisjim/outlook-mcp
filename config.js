/**
 * Configuration for Outlook MCP Server
 * 
 * Supports both local (stdio) and cloud (HTTP/SSE) deployment modes.
 * Cloud-specific settings are driven by environment variables that Railway
 * and the Dockerfile provide.
 */
const path = require('path');
const os = require('os');

// Ensure we have a home directory path even if process.env.HOME is undefined
const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || '/tmp';

// Base URL for the server — used to construct redirect URIs in cloud mode.
// Railway exposes the app at a *.up.railway.app domain; set BASE_URL in env vars.
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3333').replace(/\/+$/, '');

module.exports = {
  // Server information
  SERVER_NAME: "outlook-assistant",
  SERVER_VERSION: "1.1.0",
  
  // Test mode setting
  USE_TEST_MODE: process.env.USE_TEST_MODE === 'true',

  // Deployment mode: 'cloud' when DATABASE_URL is present, otherwise 'local'
  IS_CLOUD: !!process.env.DATABASE_URL,
  
  // Base URL (used by auth tools to generate the correct OAuth start link)
  BASE_URL,

  // Authentication configuration
  AUTH_CONFIG: {
    clientId: process.env.OUTLOOK_CLIENT_ID || process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET || process.env.MS_CLIENT_SECRET || '',
    // In cloud mode the redirect URI points to the Railway public URL;
    // in local mode it falls back to localhost:3333.
    redirectUri: process.env.MS_REDIRECT_URI || `${BASE_URL}/auth/callback`,
    scopes: [
      'offline_access',
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'User.Read',
      'Calendars.Read',
      'Calendars.ReadWrite',
    ],
    // File-based token path is only used in local/stdio mode
    tokenStorePath: path.join(homeDir, '.outlook-mcp-tokens.json'),
    authServerUrl: BASE_URL,
  },
  
  // Microsoft Graph API
  GRAPH_API_ENDPOINT: 'https://graph.microsoft.com/v1.0/',
  
  // Calendar constants
  CALENDAR_SELECT_FIELDS: 'id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,isCancelled',

  // Email constants
  EMAIL_SELECT_FIELDS: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,importance,isRead',
  EMAIL_DETAIL_FIELDS: 'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,hasAttachments,importance,isRead,internetMessageHeaders',
  
  // Pagination
  DEFAULT_PAGE_SIZE: 25,
  MAX_RESULT_COUNT: 50,

  // Timezone
  DEFAULT_TIMEZONE: "Mountain Standard Time",
};
