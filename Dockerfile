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
# pg_dump/pg_restore for the backup-verify job must match the database server's
# major version (Postgres 18). Debian's default client is 15 and refuses to dump
# an 18 server, so install postgresql-client-18 from the official PostgreSQL apt
# repo. gosu drops root→stn in the entrypoint after fixing volume ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gosu \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 stn
WORKDIR /app
# package.json files ship in the runtime image so BOTH start styles work:
#   node dist/index.js   (image default)
#   npm start            (platform-injected start commands, e.g. Railway)
# server/package.json also carries "type":"module" for the ESM bundle.
COPY --from=build /app/package.json package.json
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /app/server/var/storage /app/server/var/mail && chown -R stn:stn /app/server/var
# NOTE: container starts as root so the entrypoint can chown a root-owned mounted
# volume (e.g. Railway volumes), then drops to `stn` via gosu before running node.
WORKDIR /app/server
ENV WEB_DIST_DIR=/app/web/dist
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
