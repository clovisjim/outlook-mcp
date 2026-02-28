# ==========================================================================
# Outlook MCP Server — Dockerfile for Railway Deployment
# ==========================================================================
# Multi-stage build for a lean production image.
# Railway auto-detects this Dockerfile and builds from it.
# ==========================================================================

# ---------- Stage 1: Install dependencies ----------
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package manifests first for better layer caching
COPY package.json yarn.lock* package-lock.json* ./

# Install production dependencies only
RUN if [ -f yarn.lock ]; then \
      yarn install --production --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# ---------- Stage 2: Production image ----------
FROM node:20-alpine AS runner

WORKDIR /app

# Create a non-root user for security
RUN addgroup --system --gid 1001 mcpuser && \
    adduser --system --uid 1001 mcpuser

# Copy dependencies from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Remove dev/test files that are not needed in production
RUN rm -rf test/ \
           .github/ \
           .env.example \
           ARCHITECTURE-NOTES.md \
           *.test.js \
           test-*.js \
           test-*.sh \
           debug-*.js \
           backup-*.sh \
           move-*.js \
           find-*.js \
           create-notifications-rule.js

# Switch to non-root user
USER mcpuser

# Railway injects PORT at runtime; default to 3000 for local testing
ENV PORT=3000
EXPOSE 3000

# Health check for Railway (optional but recommended)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Start the HTTP/SSE server (not the stdio index.js)
CMD ["node", "http-server.js"]
