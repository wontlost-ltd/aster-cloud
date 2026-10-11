# Aster LSP WebSocket Server - Optimized minimal image
# Only includes ws and @aster-cloud/aster-lang-ts dependencies

# 与 package.json engines（>=24）及 aster-lang-ts 的 engines 对齐；CI 的 check:lsp-runtime 也跑在 Node 24。
FROM node:24-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy minimal package.json with only LSP dependencies
COPY lsp-package.json ./package.json

# Install pnpm and minimal dependencies
# pnpm 版本由 lsp-package.json 的 packageManager 固定（与根 package.json 一致），
# 否则 corepack 会取当时最新的 pnpm，镜像行为随上游发版漂移。
RUN corepack enable pnpm && pnpm install --prod --ignore-scripts

# Production image - minimal footprint
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 asteruser

# Copy only necessary files from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY lsp-server.mjs ./

# Create .asteri directory for LSP workspace index
RUN mkdir -p /app/.asteri && chown asteruser:nodejs /app/.asteri

# Use non-root user
USER asteruser

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Run the LSP server directly with Node.js (no tsx needed)
CMD ["node", "lsp-server.mjs"]
