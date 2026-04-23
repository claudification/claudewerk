# Build stage - compile all binaries
FROM oven/bun:1 AS builder
WORKDIR /build

# Install deps first (cache layer)
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile && cd web && bun install --frozen-lockfile

# Copy source
COPY . .

# Build server binaries only (web is built locally and volume-mounted)
RUN bun run gen-version && bun run build:broker && bun run build:cli

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binaries
COPY --from=builder /build/bin/broker /usr/local/bin/broker
COPY --from=builder /build/bin/broker-cli /usr/local/bin/broker-cli

# Copy pre-built web assets (built locally with Vite 8, volume-mounted in production)
COPY web/dist /srv/web

# Data directories
RUN mkdir -p /data/cache /data/transcripts

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:9999/health || exit 1

ENTRYPOINT ["broker"]
CMD ["--web-dir", "/srv/web", "--cache-dir", "/data/cache", "--allow-root", "/data/transcripts"]
