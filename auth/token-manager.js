/**
 * Token management for Microsoft Graph API authentication
 * 
 * This module provides a unified interface for token management that works in
 * both local (file-based) and cloud (Postgres-backed) modes.
 * 
 * In cloud mode (DATABASE_URL is set), it delegates to the PgTokenStorage
 * singleton that is created by http-server.js and stored on global.__pgTokenStorage.
 * 
 * In local mode, it uses the original synchronous file-based approach.
 */
const fs = require('fs');
const config = require('../config');

// Global variable to store tokens (local mode only)
let cachedTokens = null;

// ---------------------------------------------------------------------------
// Cloud mode helpers
// ---------------------------------------------------------------------------

/**
 * Returns the PgTokenStorage instance if running in cloud mode.
 * @returns {PgTokenStorage|null}
 */
function getPgStorage() {
  if (config.IS_CLOUD && global.__pgTokenStorage) {
    return global.__pgTokenStorage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token cache operations
// ---------------------------------------------------------------------------

/**
 * Loads authentication tokens from the token file (local) or Postgres (cloud).
 * @returns {object|null} - The loaded tokens or null if not available
 */
function loadTokenCache() {
  const pg = getPgStorage();
  if (pg) {
    // In cloud mode, return the in-memory cache from PgTokenStorage.
    // The async load happens during getAccessToken() / getValidAccessToken().
    if (pg.tokens && pg.tokens.access_token) {
      const now = Date.now();
      if (now < (pg.tokens.expires_at || 0)) {
        cachedTokens = pg.tokens;
        return pg.tokens;
      }
    }
    return null;
  }

  // --- Local / file-based mode ---
  try {
    const tokenPath = config.AUTH_CONFIG.tokenStorePath;
    console.error(`[DEBUG] Attempting to load tokens from: ${tokenPath}`);
    
    if (!fs.existsSync(tokenPath)) {
      console.error('[DEBUG] Token file does not exist');
      return null;
    }
    
    const tokenData = fs.readFileSync(tokenPath, 'utf8');
    
    try {
      const tokens = JSON.parse(tokenData);
      
      if (!tokens.access_token) {
        console.error('[DEBUG] No access_token found in tokens');
        return null;
      }
      
      const now = Date.now();
      const expiresAt = tokens.expires_at || 0;
      
      if (now > expiresAt) {
        console.error('[DEBUG] Token has expired');
        return null;
      }
      
      cachedTokens = tokens;
      return tokens;
    } catch (parseError) {
      console.error('[DEBUG] Error parsing token JSON:', parseError);
      return null;
    }
  } catch (error) {
    console.error('[DEBUG] Error loading token cache:', error);
    return null;
  }
}

/**
 * Saves authentication tokens to the token file (local) or Postgres (cloud).
 * @param {object} tokens - The tokens to save
 * @returns {boolean} - Whether the save was successful
 */
function saveTokenCache(tokens) {
  const pg = getPgStorage();
  if (pg) {
    // In cloud mode, update the in-memory tokens on PgTokenStorage.
    // The actual DB persist happens via exchangeCodeForTokens / refreshAccessToken.
    pg.tokens = tokens;
    cachedTokens = tokens;
    // Fire-and-forget async save to DB
    pg._saveTokensToDb().catch((err) => {
      console.error('Error persisting tokens to Postgres:', err.message);
    });
    return true;
  }

  // --- Local / file-based mode ---
  try {
    const tokenPath = config.AUTH_CONFIG.tokenStorePath;
    console.error(`Saving tokens to: ${tokenPath}`);
    
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    console.error('Tokens saved successfully');
    
    cachedTokens = tokens;
    return true;
  } catch (error) {
    console.error('Error saving token cache:', error);
    return false;
  }
}

/**
 * Gets the current access token, loading from cache if necessary.
 * 
 * In cloud mode, this also triggers an async token refresh if the token is
 * expired and a refresh token is available.
 * 
 * @returns {string|null} - The access token or null if not available
 */
function getAccessToken() {
  const pg = getPgStorage();
  if (pg) {
    // If we have a valid in-memory token, return it immediately
    if (pg.tokens && pg.tokens.access_token) {
      const now = Date.now();
      const buffer = 5 * 60 * 1000; // 5 min buffer
      if (now < ((pg.tokens.expires_at || 0) - buffer)) {
        return pg.tokens.access_token;
      }
      // Token expired or about to expire — trigger background refresh
      // but still return the current token (it may still be valid for a few minutes)
      pg.getValidAccessToken().catch((err) => {
        console.error('Background token refresh failed:', err.message);
      });
      return pg.tokens.access_token;
    }
    // No in-memory token — try loading from DB (async, fire-and-forget)
    pg.getTokens().catch(() => {});
    return null;
  }

  // --- Local / file-based mode ---
  if (cachedTokens && cachedTokens.access_token) {
    return cachedTokens.access_token;
  }
  
  const tokens = loadTokenCache();
  return tokens ? tokens.access_token : null;
}

/**
 * Creates a test access token for use in test mode.
 * @returns {object} - The test tokens
 */
function createTestTokens() {
  const testTokens = {
    access_token: "test_access_token_" + Date.now(),
    refresh_token: "test_refresh_token_" + Date.now(),
    expires_at: Date.now() + (3600 * 1000), // 1 hour
  };
  
  saveTokenCache(testTokens);
  return testTokens;
}

module.exports = {
  loadTokenCache,
  saveTokenCache,
  getAccessToken,
  createTestTokens,
};
