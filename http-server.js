#!/usr/bin/env node
/**
 * Outlook MCP Server — HTTP/SSE Transport for Cloud Deployment
 * 
 * This file replaces the stdio-based index.js entry point with an HTTP server
 * that exposes the MCP protocol over Server-Sent Events (SSE). It is designed
 * to run on Railway (or any cloud platform that provides a PORT env var).
 * 
 * Endpoints:
 *   GET  /sse           — SSE connection endpoint (MCP clients connect here)
 *   POST /messages      — JSON-RPC message endpoint (MCP clients post here)
 *   GET  /health        — Health check for Railway / load balancers
 *   GET  /auth          — Initiates Microsoft OAuth flow
 *   GET  /auth/callback — OAuth callback from Microsoft
 *   GET  /token-status  — Shows current token validity
 *   GET  /              — Landing page with status and instructions
 * 
 * Environment variables (see RAILWAY-DEPLOY.md for full list):
 *   PORT                 — HTTP port (Railway sets this automatically)
 *   BASE_URL             — Public URL of this server (e.g. https://your-app.up.railway.app)
 *   DATABASE_URL         — PostgreSQL connection string (Railway provides this)
 *   TOKEN_ENCRYPTION_KEY — 64-char hex string for AES-256-GCM token encryption
 *   MS_CLIENT_ID         — Microsoft Azure app client ID
 *   MS_CLIENT_SECRET     — Microsoft Azure app client secret
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

const config = require('./config');
const PgTokenStorage = require('./auth/pg-token-storage');
const { setupOAuthRoutes, createAuthConfig } = require('./auth/oauth-server');

// Import module tools
const { authTools } = require('./auth');
const { calendarTools } = require('./calendar');
const { emailTools } = require('./email');
const { folderTools } = require('./folder');
const { rulesTools } = require('./rules');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Combine all MCP tools
const TOOLS = [
  ...authTools,
  ...calendarTools,
  ...emailTools,
  ...folderTools,
  ...rulesTools,
];

// ---------------------------------------------------------------------------
// Shared token storage (Postgres-backed, used by both MCP tools and OAuth)
// ---------------------------------------------------------------------------

const tokenStorage = new PgTokenStorage({
  clientId: process.env.MS_CLIENT_ID || config.AUTH_CONFIG.clientId,
  clientSecret: process.env.MS_CLIENT_SECRET || config.AUTH_CONFIG.clientSecret,
  redirectUri: `${BASE_URL}/auth/callback`,
  scopes: config.AUTH_CONFIG.scopes.includes('offline_access')
    ? config.AUTH_CONFIG.scopes
    : ['offline_access', ...config.AUTH_CONFIG.scopes],
});

// Make the token storage globally accessible so that auth/token-manager.js
// and other modules can use it for cloud mode.
global.__pgTokenStorage = tokenStorage;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Parse JSON bodies for the /messages endpoint
app.use(express.json());

// CORS — allow MCP clients from any origin
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id'],
}));

// ---------------------------------------------------------------------------
// SSE transport management
// ---------------------------------------------------------------------------

// Map of sessionId → SSEServerTransport (supports multiple concurrent clients)
const transports = {};

/**
 * Creates a fresh MCP Server instance wired to the given transport.
 * Each SSE connection gets its own Server instance so that the fallback
 * request handler can operate independently per session.
 */
function createMcpServer() {
  const server = new Server(
    { name: config.SERVER_NAME, version: config.SERVER_VERSION },
    {
      capabilities: {
        tools: TOOLS.reduce((acc, tool) => {
          acc[tool.name] = {};
          return acc;
        }, {}),
      },
    }
  );

  // --- Fallback request handler (mirrors the logic from index.js) ----------

  server.fallbackRequestHandler = async (request) => {
    try {
      const { method, params, id } = request;
      console.error(`[SSE] REQUEST: ${method} [${id}]`);

      // Initialize
      if (method === 'initialize') {
        return {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: TOOLS.reduce((acc, tool) => {
              acc[tool.name] = {};
              return acc;
            }, {}),
          },
          serverInfo: { name: config.SERVER_NAME, version: config.SERVER_VERSION },
        };
      }

      // Tools list
      if (method === 'tools/list') {
        return {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      }

      // Empty capability responses
      if (method === 'resources/list') return { resources: [] };
      if (method === 'prompts/list') return { prompts: [] };

      // Tool call
      if (method === 'tools/call') {
        const { name, arguments: args = {} } = params || {};
        console.error(`[SSE] TOOL CALL: ${name}`);

        const tool = TOOLS.find((t) => t.name === name);
        if (tool && tool.handler) {
          return await tool.handler(args);
        }

        return {
          error: { code: -32601, message: `Tool not found: ${name}` },
        };
      }

      return {
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      console.error('[SSE] Error in fallbackRequestHandler:', err);
      return {
        error: { code: -32603, message: `Error: ${err.message}` },
      };
    }
  };

  return server;
}

// ---------------------------------------------------------------------------
// MCP SSE endpoints
// ---------------------------------------------------------------------------

/**
 * GET /sse — Client connects here to establish the SSE stream.
 * The SSEServerTransport constructor sends the `endpoint` event telling the
 * client where to POST messages.
 */
app.get('/sse', async (req, res) => {
  console.error('[SSE] New SSE connection request');

  try {
    // The second argument to SSEServerTransport is the *relative* path the
    // client should POST messages to.  The SDK appends ?sessionId=<id>.
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;

    console.error(`[SSE] Created transport session: ${sessionId}`);
    transports[sessionId] = transport;

    // Clean up on disconnect
    res.on('close', () => {
      console.error(`[SSE] Session ${sessionId} disconnected`);
      delete transports[sessionId];
    });

    // Create a dedicated MCP server for this session and connect
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    console.error(`[SSE] Session ${sessionId} connected and listening`);
  } catch (err) {
    console.error('[SSE] Error establishing SSE connection:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
  }
});

/**
 * POST /messages?sessionId=<id> — Client sends JSON-RPC messages here.
 */
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid sessionId query parameter' });
  }

  const transport = transports[sessionId];
  if (!transport) {
    return res.status(404).json({ error: `No active session: ${sessionId}` });
  }

  try {
    // The third argument passes the already-parsed body so the transport
    // does not try to re-parse the stream (which causes errors with Express).
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error(`[SSE] Error handling message for session ${sessionId}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error processing message' });
    }
  }
});

// ---------------------------------------------------------------------------
// OAuth routes (mounted from the existing auth/oauth-server.js module)
// ---------------------------------------------------------------------------

const authConfig = createAuthConfig('MS_');
// Override the redirect URI to use the cloud BASE_URL
authConfig.redirectUri = `${BASE_URL}/auth/callback`;

setupOAuthRoutes(app, tokenStorage, authConfig, 'MS_');

// ---------------------------------------------------------------------------
// Health & landing page
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  const status = {
    status: 'ok',
    server: config.SERVER_NAME,
    version: config.SERVER_VERSION,
    uptime: process.uptime(),
    activeSessions: Object.keys(transports).length,
    timestamp: new Date().toISOString(),
  };

  // Optionally check DB connectivity
  try {
    const pool = tokenStorage._pool;
    if (pool) {
      await pool.query('SELECT 1');
      status.database = 'connected';
    } else {
      status.database = 'not initialised yet';
    }
  } catch {
    status.database = 'error';
  }

  res.json(status);
});

app.get('/', (_req, res) => {
  const activeSessions = Object.keys(transports).length;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${config.SERVER_NAME} — MCP Server</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               max-width: 720px; margin: 40px auto; padding: 0 20px; color: #333; }
        h1 { color: #0078d4; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
        .card { background: #f8f9fa; border: 1px solid #e1e4e8; border-radius: 8px;
                padding: 16px 20px; margin: 16px 0; }
        .ok   { color: #28a745; }
        .warn { color: #e36209; }
        a { color: #0078d4; }
        table { border-collapse: collapse; width: 100%; margin-top: 8px; }
        td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e1e4e8; }
      </style>
    </head>
    <body>
      <h1>&#128231; ${config.SERVER_NAME} v${config.SERVER_VERSION}</h1>
      <div class="card">
        <p class="ok"><strong>Server is running.</strong></p>
        <p>Active SSE sessions: <strong>${activeSessions}</strong></p>
      </div>

      <h2>MCP Endpoints</h2>
      <table>
        <tr><th>Endpoint</th><th>Description</th></tr>
        <tr><td><code>GET /sse</code></td><td>SSE connection (MCP clients connect here)</td></tr>
        <tr><td><code>POST /messages?sessionId=…</code></td><td>JSON-RPC messages</td></tr>
        <tr><td><code>GET /health</code></td><td>Health check (JSON)</td></tr>
      </table>

      <h2>Authentication</h2>
      <table>
        <tr><th>Endpoint</th><th>Description</th></tr>
        <tr><td><a href="/auth"><code>GET /auth</code></a></td><td>Start Microsoft OAuth flow</td></tr>
        <tr><td><code>GET /auth/callback</code></td><td>OAuth callback (automatic)</td></tr>
        <tr><td><a href="/token-status"><code>GET /token-status</code></a></td><td>Check token status</td></tr>
      </table>

      <h2>Client Configuration</h2>
      <p>Point your MCP client's SSE URL to:</p>
      <pre><code>${BASE_URL}/sse</code></pre>
    </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.error('='.repeat(60));
  console.error(`${config.SERVER_NAME} v${config.SERVER_VERSION} — HTTP/SSE mode`);
  console.error(`Listening on port ${PORT}`);
  console.error(`Base URL: ${BASE_URL}`);
  console.error(`SSE endpoint: ${BASE_URL}/sse`);
  console.error(`OAuth callback: ${BASE_URL}/auth/callback`);
  console.error(`Health check: ${BASE_URL}/health`);
  console.error('='.repeat(60));
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.error(`\n${signal} received — shutting down gracefully...`);

  // Close all SSE connections
  for (const [id, transport] of Object.entries(transports)) {
    try {
      await transport.close();
    } catch { /* ignore */ }
    delete transports[id];
  }

  // Close the Postgres pool
  await tokenStorage.close();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
