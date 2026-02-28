/**
 * Authentication module for Outlook MCP server
 * 
 * Provides a unified ensureAuthenticated() function that works in both
 * local (file-based) and cloud (Postgres-backed) modes.
 */
const config = require('../config');
const tokenManager = require('./token-manager');
const { authTools } = require('./tools');

/**
 * Ensures the user is authenticated and returns an access token.
 * 
 * In cloud mode (DATABASE_URL set), this performs an async lookup against
 * PgTokenStorage, including automatic token refresh if needed.
 * 
 * In local mode, it reads from the file-based token cache.
 * 
 * @param {boolean} forceNew - Whether to force a new authentication
 * @returns {Promise<string>} - Access token
 * @throws {Error} - If authentication fails
 */
async function ensureAuthenticated(forceNew = false) {
  if (forceNew) {
    throw new Error('Authentication required');
  }

  // Cloud mode — use PgTokenStorage for async token retrieval + auto-refresh
  if (config.IS_CLOUD && global.__pgTokenStorage) {
    const accessToken = await global.__pgTokenStorage.getValidAccessToken();
    if (!accessToken) {
      throw new Error('Authentication required');
    }
    return accessToken;
  }
  
  // Local mode — synchronous file-based check
  const accessToken = tokenManager.getAccessToken();
  if (!accessToken) {
    throw new Error('Authentication required');
  }
  
  return accessToken;
}

module.exports = {
  tokenManager,
  authTools,
  ensureAuthenticated
};
