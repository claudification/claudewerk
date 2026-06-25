# Build stage - compile all binaries
# Pinned to an exact Bun version for reproducible broker builds. The floating
# `oven/bun:1` tag can silently shift the embedded runtime under the broker on
# any rebuild. Bump in lockstep with MIN_BUN_VERSION (src/shared/bun-version.ts).
FROM oven/bun:1.3.14 AS builder
WORKDIR /build

# Build args used by gen-version.ts (which has no git inside the container).
# These flow in from scripts/docker-build-broker.sh via --build-arg.
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_COMMIT_SHORT=${GIT_COMMIT_SHORT}
ENV BUILD_TIME=${BUILD_TIME}

# Install deps first (cache layer)
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile && cd web && bun install --frozen-lockfile

# Copy source. When built via scripts/docker-build-broker.sh this is `git archive
# HEAD` piped on stdin, so no host working-tree state can leak in. Direct
# `docker build .` invocations are deliberately discouraged (see docker-compose.yml).
COPY . .

# Build web + server binaries fully in-container so the image builds from any
# clean context (git archive, a fresh clone, or a Launchfile-driven compose
# build) without host-side prebuild steps. Production still bind-mounts a
# locally-built web/dist over /srv/web; the baked copy is the offline fallback.
# build:broker's dirty-tree check no-ops here because .git is not in the context.
RUN bun run gen-version && bun run build:web && bun run build:broker && bun run build:cli

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binaries
COPY --from=builder /build/bin/broker /usr/local/bin/broker
COPY --from=builder /build/bin/broker-cli /usr/local/bin/broker-cli

# Copy web assets built in the builder stage (volume-mounted over in production)
COPY --from=builder /build/web/dist /srv/web

# Data directories
RUN mkdir -p /data/cache /data/transcripts

# Build provenance: commit SHA the broker binary was built from.
# Supplied by scripts/docker-build-broker.sh via --build-arg.
# Inspect with: docker inspect broker --format '{{.Config.Labels.commit}}'
# Or from inside: docker exec broker printenv GIT_COMMIT
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_COMMIT_SHORT=${GIT_COMMIT_SHORT}
ENV BUILD_TIME=${BUILD_TIME}
LABEL commit=${GIT_COMMIT}
LABEL commit_short=${GIT_COMMIT_SHORT}
LABEL build_time=${BUILD_TIME}
LABEL org.opencontainers.image.revision=${GIT_COMMIT}
LABEL org.opencontainers.image.created=${BUILD_TIME}

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:9999/health || exit 1

ENTRYPOINT ["broker"]
CMD ["--web-dir", "/srv/web", "--cache-dir", "/data/cache", "--allow-root", "/data/transcripts"]
