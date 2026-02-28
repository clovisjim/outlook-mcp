/**
 * Postgres-backed Token Storage with AES-256-GCM Encryption
 * 
 * Replaces the file-based token storage (~/.outlook-mcp-tokens.json) with a
 * PostgreSQL-backed store suitable for cloud deployment on Railway.
 * 
 * Tokens are encrypted at rest using AES-256-GCM with a key derived from the
 * TOKEN_ENCRYPTION_KEY environment variable (64-character hex string = 32 bytes).
 * 
 * Schema (see schema.sql):
 *   CREATE TABLE IF NOT EXISTS tokens (
 *     id            SERIAL PRIMARY KEY,
 *     user_id       VARCHAR(255) NOT NULL DEFAULT 'default' UNIQUE,
 *     encrypted_data TEXT NOT NULL,
 *     iv            VARCHAR(32)  NOT NULL,
 *     auth_tag      VARCHAR(32)  NOT NULL,
 *     created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
 *     updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
 *   );
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

/**
 * Derives the 32-byte encryption key from the hex-encoded environment variable.
 * @returns {Buffer} 32-byte key
 */
function getEncryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string} plaintext - The JSON string to encrypt
 * @returns {{ ciphertext: string, iv: string, authTag: string }}
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypts ciphertext produced by encrypt().
 * @param {string} ciphertext - Hex-encoded ciphertext
 * @param {string} ivHex      - Hex-encoded IV
 * @param {string} authTagHex - Hex-encoded GCM auth tag
 * @returns {string} The original plaintext
 */
function decrypt(ciphertext, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ---------------------------------------------------------------------------
// PgTokenStorage class
// ---------------------------------------------------------------------------

class PgTokenStorage {
  /**
   * @param {object} config - Configuration overrides
   * @param {string} config.clientId       - Microsoft OAuth client ID
   * @param {string} config.clientSecret   - Microsoft OAuth client secret
   * @param {string} config.redirectUri    - OAuth redirect URI
   * @param {string[]} config.scopes       - OAuth scopes
   * @param {string} config.tokenEndpoint  - Microsoft token endpoint
   * @param {number} config.refreshTokenBuffer - ms before expiry to trigger refresh
   */
  constructor(config = {}) {
    this.config = {
      clientId: process.env.MS_CLIENT_ID || '',
      clientSecret: process.env.MS_CLIENT_SECRET || '',
      redirectUri: process.env.MS_REDIRECT_URI || 'http://localhost:3333/auth/callback',
      scopes: (process.env.MS_SCOPES || 'offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.Read Calendars.ReadWrite').split(' '),
      tokenEndpoint: process.env.MS_TOKEN_ENDPOINT || 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      refreshTokenBuffer: 5 * 60 * 1000, // 5 minutes
      ...config,
    };

    // In-memory cache of decrypted tokens
    this.tokens = null;
    this._loadPromise = null;
    this._refreshPromise = null;

    // User ID for single-user personal MCP server
    this.userId = 'default';

    // PostgreSQL connection pool (lazy-initialised)
    this._pool = null;

    if (!this.config.clientId || !this.config.clientSecret) {
      console.warn(
        'PgTokenStorage: MS_CLIENT_ID or MS_CLIENT_SECRET not configured. ' +
        'Token operations may fail.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Database helpers
  // -------------------------------------------------------------------------

  /**
   * Returns (and lazily creates) the pg Pool, and ensures the tokens table exists.
   * @returns {Pool}
   */
  async _getPool() {
    if (this._pool) return this._pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for Postgres token storage.');
    }

    this._pool = new Pool({
      connectionString,
      ssl: process.env.PG_SSL === 'false'
        ? false
        : { rejectUnauthorized: false }, // Railway Postgres uses self-signed certs
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Ensure the tokens table exists on first connection
    await this._ensureTable();

    return this._pool;
  }

  /**
   * Creates the tokens table if it does not already exist.
   */
  async _ensureTable() {
    const createSQL = `
      CREATE TABLE IF NOT EXISTS tokens (
        id             SERIAL PRIMARY KEY,
        user_id        VARCHAR(255) NOT NULL DEFAULT 'default' UNIQUE,
        encrypted_data TEXT         NOT NULL,
        iv             VARCHAR(32)  NOT NULL,
        auth_tag       VARCHAR(32)  NOT NULL,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `;
    const pool = this._pool;
    try {
      await pool.query(createSQL);
      console.log('PgTokenStorage: tokens table ensured.');
    } catch (err) {
      console.error('PgTokenStorage: failed to ensure tokens table:', err.message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Core CRUD (encrypted)
  // -------------------------------------------------------------------------

  /**
   * Loads tokens from Postgres, decrypts, and caches in memory.
   * @returns {object|null}
   */
  async _loadTokensFromDb() {
    try {
      const pool = await this._getPool();
      const result = await pool.query(
        'SELECT encrypted_data, iv, auth_tag FROM tokens WHERE user_id = $1',
        [this.userId]
      );

      if (result.rows.length === 0) {
        console.log('PgTokenStorage: no token row found for user:', this.userId);
        this.tokens = null;
        return null;
      }

      const row = result.rows[0];
      const plaintext = decrypt(row.encrypted_data, row.iv, row.auth_tag);
      this.tokens = JSON.parse(plaintext);
      console.log('PgTokenStorage: tokens loaded and decrypted from Postgres.');
      return this.tokens;
    } catch (err) {
      console.error('PgTokenStorage: error loading tokens from DB:', err.message);
      this.tokens = null;
      return null;
    }
  }

  /**
   * Encrypts and upserts the current in-memory tokens into Postgres.
   */
  async _saveTokensToDb() {
    if (!this.tokens) {
      console.warn('PgTokenStorage: no tokens to save.');
      return;
    }

    const plaintext = JSON.stringify(this.tokens);
    const { ciphertext, iv, authTag } = encrypt(plaintext);

    const pool = await this._getPool();
    const upsertSQL = `
      INSERT INTO tokens (user_id, encrypted_data, iv, auth_tag, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        updated_at     = NOW();
    `;

    try {
      await pool.query(upsertSQL, [this.userId, ciphertext, iv, authTag]);
      console.log('PgTokenStorage: tokens encrypted and saved to Postgres.');
    } catch (err) {
      console.error('PgTokenStorage: error saving tokens to DB:', err.message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Public API (compatible with the original TokenStorage interface)
  // -------------------------------------------------------------------------

  /**
   * Returns the current tokens, loading from DB if necessary.
   * @returns {Promise<object|null>}
   */
  async getTokens() {
    if (this.tokens) return this.tokens;

    if (!this._loadPromise) {
      this._loadPromise = this._loadTokensFromDb().finally(() => {
        this._loadPromise = null;
      });
    }
    return this._loadPromise;
  }

  /**
   * Returns the token expiry timestamp (ms since epoch), or 0.
   * @returns {number}
   */
  getExpiryTime() {
    return this.tokens && this.tokens.expires_at ? this.tokens.expires_at : 0;
  }

  /**
   * Checks whether the access token is expired or about to expire.
   * @returns {boolean}
   */
  isTokenExpired() {
    if (!this.tokens || !this.tokens.expires_at) return true;
    return Date.now() >= (this.tokens.expires_at - this.config.refreshTokenBuffer);
  }

  /**
   * Returns a valid access token, refreshing if necessary.
   * @returns {Promise<string|null>}
   */
  async getValidAccessToken() {
    await this.getTokens();

    if (!this.tokens || !this.tokens.access_token) {
      console.log('PgTokenStorage: no access token available.');
      return null;
    }

    if (this.isTokenExpired()) {
      console.log('PgTokenStorage: access token expired or nearing expiration.');
      if (this.tokens.refresh_token) {
        try {
          return await this.refreshAccessToken();
        } catch (err) {
          console.error('PgTokenStorage: refresh failed:', err.message);
          this.tokens = null;
          await this._saveTokensToDb();
          return null;
        }
      } else {
        console.warn('PgTokenStorage: no refresh token available.');
        this.tokens = null;
        await this._saveTokensToDb();
        return null;
      }
    }

    return this.tokens.access_token;
  }

  /**
   * Refreshes the access token using the stored refresh token.
   * Prevents concurrent refresh attempts.
   * @returns {Promise<string>} The new access token
   */
  async refreshAccessToken() {
    if (!this.tokens || !this.tokens.refresh_token) {
      throw new Error('No refresh token available.');
    }

    if (this._refreshPromise) {
      console.log('PgTokenStorage: refresh already in progress, awaiting.');
      return this._refreshPromise.then(t => t.access_token);
    }

    console.log('PgTokenStorage: refreshing access token...');

    const postData = querystring.stringify({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      scope: this.config.scopes.join(' '),
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    this._refreshPromise = new Promise((resolve, reject) => {
      const req = https.request(this.config.tokenEndpoint, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const body = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.tokens.access_token = body.access_token;
              if (body.refresh_token) {
                this.tokens.refresh_token = body.refresh_token;
              }
              this.tokens.expires_in = body.expires_in;
              this.tokens.expires_at = Date.now() + (body.expires_in * 1000);

              await this._saveTokensToDb();
              console.log('PgTokenStorage: access token refreshed and persisted.');
              resolve(this.tokens);
            } else {
              console.error('PgTokenStorage: refresh error response:', body);
              reject(new Error(body.error_description || `Refresh failed (HTTP ${res.statusCode})`));
            }
          } catch (e) {
            reject(e);
          } finally {
            this._refreshPromise = null;
          }
        });
      });

      req.on('error', (err) => {
        console.error('PgTokenStorage: HTTP error during refresh:', err.message);
        reject(err);
        this._refreshPromise = null;
      });

      req.write(postData);
      req.end();
    });

    return this._refreshPromise.then(t => t.access_token);
  }

  /**
   * Exchanges an OAuth authorization code for tokens and persists them.
   * @param {string} authCode - The authorization code from the OAuth callback
   * @returns {Promise<object>} The token set
   */
  async exchangeCodeForTokens(authCode) {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error('Client ID or Client Secret not configured.');
    }

    console.log('PgTokenStorage: exchanging authorization code for tokens...');

    const postData = querystring.stringify({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(this.config.tokenEndpoint, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const body = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.tokens = {
                access_token: body.access_token,
                refresh_token: body.refresh_token,
                expires_in: body.expires_in,
                expires_at: Date.now() + (body.expires_in * 1000),
                scope: body.scope,
                token_type: body.token_type,
              };

              await this._saveTokensToDb();
              console.log('PgTokenStorage: tokens exchanged and persisted.');
              resolve(this.tokens);
            } else {
              console.error('PgTokenStorage: code exchange error:', body);
              reject(new Error(body.error_description || `Exchange failed (HTTP ${res.statusCode})`));
            }
          } catch (e) {
            console.error('PgTokenStorage: error processing exchange response:', e.message);
            reject(e);
          }
        });
      });

      req.on('error', (err) => {
        console.error('PgTokenStorage: HTTP error during code exchange:', err.message);
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Clears all stored tokens (in memory and in Postgres).
   */
  async clearTokens() {
    this.tokens = null;
    try {
      const pool = await this._getPool();
      await pool.query('DELETE FROM tokens WHERE user_id = $1', [this.userId]);
      console.log('PgTokenStorage: tokens cleared from Postgres.');
    } catch (err) {
      console.error('PgTokenStorage: error clearing tokens:', err.message);
    }
  }

  /**
   * Gracefully shuts down the connection pool.
   */
  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
      console.log('PgTokenStorage: connection pool closed.');
    }
  }
}

module.exports = PgTokenStorage;
