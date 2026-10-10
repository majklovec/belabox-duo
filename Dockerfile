# ---- Build stage ----
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json bun.lock ./

# Install dependencies (including dev deps needed for TypeScript)
RUN bun install --frozen-lockfile

# Copy the rest of the project
COPY . .

# ---- Runtime stage ----
FROM oven/bun:1

# Install runtime dependencies (git for pipeline repositories, ca-certificates for TLS)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what is needed to run the server. The server runs unbundled
# (`bun server.ts`): modules are discovered by a runtime scan of modules/
# and dynamically imported, the module backends import obs-client.ts, and
# the web UI is bundled at startup via scripts/gen-modules.ts + Bun.build.
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/obs-client.ts ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/modules ./modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/i18n ./i18n
COPY --from=builder /app/scripts ./scripts

# Expose the default control-server port
EXPOSE 8090

# Default entrypoint — override with `command` in docker-compose
ENTRYPOINT ["bun", "server.ts"]
CMD ["--host", "0.0.0.0", "--port", "8090"]