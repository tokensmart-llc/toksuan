# Two-stage Docker build for the Next.js dashboard.
#   - builder: install deps, run `next build`, produce .next/standalone
#   - runner: copy only the standalone bundle + static assets
# Result is a small image with no node_modules at runtime.

FROM oven/bun:1.1-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next's standalone output writes a self-contained server.js at the root of
# /app/.next/standalone. Static assets still live under .next/static.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --retries=4 \
  CMD wget -q -O /dev/null http://localhost:3000/health || exit 1

CMD ["bun", "server.js"]
