# syntax=docker/dockerfile:1

# Stage 1: Build Vue 3 Frontend with Vite 8 (Rolldown/Oxc)
FROM node:24-bookworm-slim AS frontend-builder
# pnpm comes from corepack, pinned by the root package.json "packageManager" field
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@singpulse/frontend..."

COPY packages/shared ./packages/shared
COPY packages/frontend ./packages/frontend
RUN pnpm --filter @singpulse/frontend build

# Stage 2: Lean Production Runtime (Node 24 Native TS + yt-dlp + ffmpeg)
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Install ffmpeg, python3 (for yt-dlp), and standalone yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y --auto-remove curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# System-wide yt-dlp defaults (JS runtime for YouTube challenge solving)
COPY docker/yt-dlp.conf /etc/yt-dlp.conf

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm/store --filter "@singpulse/backend..."

COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend
COPY --from=frontend-builder /build/packages/frontend/dist ./packages/frontend/dist
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/singpulse-entrypoint

ENV PORT=3000
ENV CACHE_DIR=/app/cache
ENV FRONTEND_DIST=/app/packages/frontend/dist

RUN mkdir -p "$CACHE_DIR" && chown node:node "$CACHE_DIR"

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["singpulse-entrypoint"]
CMD ["node", "packages/backend/src/server.ts"]
