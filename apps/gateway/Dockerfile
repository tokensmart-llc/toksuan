# Single-stage Bun image for the TokSuan gateway.
# Small on purpose — Bun ships its own runtime, so there's no npm install
# dance or a separate builder stage needed.

FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

# Deps first so repeated app edits don't bust the layer cache.
COPY package.json ./
COPY bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

# App source + CLI scripts (set-budget / set-routing / etc.).
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# Pricing source-of-truth. The gateway reads this at boot and falls back to
# a deliberately-tiny `EMBEDDED_FALLBACK` table only when the file is
# missing — fine for tests but it doesn't carry the full provider catalog,
# so a Docker image built without `data/` silently prices every routed
# request at $0 and the dashboard receipt then shows "$0 saved" even when
# routing actually moved a request to a cheaper model. See
# `src/pricing.ts` (`findPricingFile`) for the lookup paths.
COPY data ./data

# DB migrations are mounted as a volume by docker-compose.prod.yml at
# /app/migrations — see that file. The gateway runs
# `runPendingMigrations()` at boot from this directory so DBs stay in
# sync as we add columns/tables across versions. Postgres'
# /docker-entrypoint-initdb.d only runs SQL on FIRST volume init; this
# in-app runner handles every boot AFTER that.

ENV NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --retries=4 \
  CMD wget -q -O /dev/null http://localhost:8787/health || exit 1

CMD ["bun", "run", "src/index.ts"]
