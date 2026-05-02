# Calendry — single Bun image
# Two entrypoints:
#   web:    bun run apps/web/.next/standalone/server.js  (after next build)
#   worker: bun run apps/worker/index.ts
#
# Usage:
#   docker build -f ops/Dockerfile -t calendry .
#   docker run -e ENTRYPOINT=web    calendry   # runs Next.js
#   docker run -e ENTRYPOINT=worker calendry   # runs worker

FROM oven/bun:1.3.11-alpine AS base
WORKDIR /app

# ── Install dependencies ────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json bunfig.toml bun.lockb* ./
COPY apps/web/package.json       ./apps/web/package.json
COPY apps/worker/package.json    ./apps/worker/package.json
COPY packages/core/package.json  ./packages/core/package.json
COPY packages/db/package.json    ./packages/db/package.json
COPY packages/google/package.json ./packages/google/package.json
COPY packages/email/package.json  ./packages/email/package.json
RUN bun install --frozen-lockfile

# ── Build Next.js ───────────────────────────────────────────────────────────────
FROM deps AS build-web
COPY . .
RUN cd apps/web && bun run build

# ── Final image ─────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

# Copy workspace dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules

# Copy all source (worker needs TS source; web needs .next build output)
COPY --from=build-web /app/apps /app/apps
COPY --from=build-web /app/packages /app/packages
COPY package.json bunfig.toml ./

# Entrypoint dispatcher
COPY ops/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENV NODE_ENV=production
ENV ENTRYPOINT=web

ENTRYPOINT ["/entrypoint.sh"]
