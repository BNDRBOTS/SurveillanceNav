# ── Surveillance Transparency Navigator — production image ─────────────
# Multi-stage: build web + bundle server, run as non-root on distroless-slim.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json eslint.config.mjs ./
COPY shared shared
COPY server server
COPY web web
COPY scripts scripts
RUN node scripts/gen-icons.mjs \
 && npm run typecheck \
 && npm run build -w server \
 && npm run build -w web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# postgresql-client provides pg_dump/pg_restore for the backup-verify job
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 stn
WORKDIR /app
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
USER stn
WORKDIR /app/server
ENV WEB_DIST_DIR=/app/web/dist
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
