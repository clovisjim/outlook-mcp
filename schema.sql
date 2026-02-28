-- ==========================================================================
-- Outlook MCP Server — Postgres Token Storage Schema
-- ==========================================================================
-- Run this against your Railway Postgres database to create the tokens table.
-- The table is also auto-created on first server startup by pg-token-storage.js,
-- so running this manually is optional but recommended for production setups.
--
-- Usage (Railway CLI):
--   railway run psql $DATABASE_URL -f schema.sql
--
-- Usage (direct psql):
--   psql "$DATABASE_URL" -f schema.sql
-- ==========================================================================

CREATE TABLE IF NOT EXISTS tokens (
  id             SERIAL       PRIMARY KEY,
  user_id        VARCHAR(255) NOT NULL DEFAULT 'default' UNIQUE,
  encrypted_data TEXT         NOT NULL,
  iv             VARCHAR(32)  NOT NULL,
  auth_tag       VARCHAR(32)  NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index on user_id for fast lookups (the UNIQUE constraint already creates one,
-- but this makes the intent explicit).
CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens (user_id);

-- Optional: add a comment for documentation
COMMENT ON TABLE tokens IS 'Encrypted OAuth token storage for the Outlook MCP server';
COMMENT ON COLUMN tokens.encrypted_data IS 'AES-256-GCM encrypted JSON token payload';
COMMENT ON COLUMN tokens.iv IS 'Hex-encoded 96-bit initialisation vector';
COMMENT ON COLUMN tokens.auth_tag IS 'Hex-encoded GCM authentication tag';
