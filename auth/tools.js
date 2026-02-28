/**
 * Authentication-related tools for the Outlook MCP server
 * 
 * Updated to support cloud deployment — the authenticate tool now returns
 * a URL based on the configured BASE_URL (which points to the Railway domain
 * in cloud mode, or localhost in local mode).
 */
const config = require('../config');
const tokenManager = require('./token-manager');

/**
 * About tool handler
 * @returns {object} - MCP response
 */
async function handleAbout() {
  const mode = config.IS_CLOUD ? 'cloud (HTTP/SSE)' : 'local (stdio)';
  return {
    content: [{
      type: "text",
      text: `📧 Outlook Assistant MCP Server v${config.SERVER_VERSION} 📧\n\n` +
            `Mode: ${mode}\n` +
            `Provides access to Microsoft Outlook email, calendar, and contacts ` +
            `through Microsoft Graph API.`
    }]
  };
}

/**
 * Authentication tool handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleAuthenticate(args) {
  const force = args && args.force === true;
  
  // For test mode, create a test token
  if (config.USE_TEST_MODE) {
    tokenManager.createTestTokens();
    return {
      content: [{
        type: "text",
        text: 'Successfully authenticated with Microsoft Graph API (test mode)'
      }]
    };
  }
  
  // Build the auth URL using the configured base URL (works for both local and cloud)
  const authUrl = `${config.BASE_URL}/auth`;
  
  return {
    content: [{
      type: "text",
      text: `Authentication required. Please visit the following URL to authenticate ` +
            `with Microsoft:\n\n${authUrl}\n\n` +
            `After authentication, you will be redirected back and your tokens will be ` +
            `stored securely.`
    }]
  };
}

/**
 * Check authentication status tool handler
 * @returns {object} - MCP response
 */
async function handleCheckAuthStatus() {
  console.error('[CHECK-AUTH-STATUS] Starting authentication status check');

  // In cloud mode, try the async path first
  if (config.IS_CLOUD && global.__pgTokenStorage) {
    try {
      const accessToken = await global.__pgTokenStorage.getValidAccessToken();
      if (accessToken) {
        const expiresAt = global.__pgTokenStorage.getExpiryTime();
        const expiryDate = new Date(expiresAt);
        return {
          content: [{ 
            type: "text", 
            text: `Authenticated and ready. Token expires at: ${expiryDate.toISOString()}`
          }]
        };
      }
    } catch (err) {
      console.error('[CHECK-AUTH-STATUS] Cloud token check error:', err.message);
    }
    return {
      content: [{ 
        type: "text", 
        text: `Not authenticated. Please visit ${config.BASE_URL}/auth to sign in.`
      }]
    };
  }

  // Local mode — synchronous file-based check
  const tokens = tokenManager.loadTokenCache();
  
  if (!tokens || !tokens.access_token) {
    return {
      content: [{ type: "text", text: "Not authenticated" }]
    };
  }
  
  return {
    content: [{ type: "text", text: "Authenticated and ready" }]
  };
}

// Tool definitions
const authTools = [
  {
    name: "about",
    description: "Returns information about this Outlook Assistant server",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    handler: handleAbout
  },
  {
    name: "authenticate",
    description: "Authenticate with Microsoft Graph API to access Outlook data",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force re-authentication even if already authenticated"
        }
      },
      required: []
    },
    handler: handleAuthenticate
  },
  {
    name: "check-auth-status",
    description: "Check the current authentication status with Microsoft Graph API",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    handler: handleCheckAuthStatus
  }
];

module.exports = {
  authTools,
  handleAbout,
  handleAuthenticate,
  handleCheckAuthStatus
};
