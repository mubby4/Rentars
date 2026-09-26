# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Rentars Web (Next.js 16) — hardened multi-stage Dockerfile
#
# Stages:
#   deps    — install dependencies with frozen lockfile (npm ci only)
#   builder — next build (standalone output mode)
#   runner  — minimal runtime; non-root, no compiler tools, health check
#
# Pinning strategy:
#   Base images are pinned to a specific tag AND their index digest.
#   Update the digest after vetting the upstream changelog and re-running
#   `docker scout cves` or `trivy image` in CI.
#
#   Current pins (update policy: monthly or on CVE advisory):
#     node:20.19-alpine  →  sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448
#
# Prerequisite — next.config output must be set to "standalone":
#   // next.config.ts
#   const config: NextConfig = { output: 'standalone' };
#
# Writable paths at runtime:
#   /tmp   — Next.js and node may write temp files here
#
# To update the base-image digest:
#   docker pull node:20.19-alpine
#   docker inspect node:20.19-alpine --format '{{index .RepoDigests 0}}'
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Install ALL dependencies (including devDeps needed by the Next.js build)
# using the frozen lockfile so the manifest cannot be mutated in CI.

FROM node:20.19-alpine@sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448 AS deps

WORKDIR /build

# Copy lockfile and manifest only — changes to source don't bust this layer.
COPY package.json package-lock.json ./

# npm ci: strict, reproducible, lockfile-frozen install.
# Never fall back to npm install — if package-lock.json is absent the build
# must fail loudly rather than silently generating a different dependency tree.
RUN npm ci

# ── Stage 2: builder ──────────────────────────────────────────────────────────

FROM node:20.19-alpine@sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448 AS builder

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules

# Copy source — .dockerignore excludes .env*, node_modules, .next, secrets.
COPY . .

# Opt out of Next.js anonymous telemetry at build time.
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js in standalone mode.
# NEXT_PUBLIC_* vars needed at build time must be injected here via
# --build-arg and ARG declarations below (they are baked into the JS bundle).
# Secrets (API keys, JWT secrets) must NOT be passed as build args — they
# belong in runtime environment only.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_STELLAR_NETWORK
ARG NEXT_PUBLIC_HORIZON_URL
ARG NEXT_PUBLIC_SOROBAN_RPC_URL
ARG NEXT_PUBLIC_PASSKEY_RP_ID
ARG NEXT_PUBLIC_PASSKEY_RP_NAME
ARG NEXT_PUBLIC_PASSKEY_ORIGIN

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_STELLAR_NETWORK=$NEXT_PUBLIC_STELLAR_NETWORK \
    NEXT_PUBLIC_HORIZON_URL=$NEXT_PUBLIC_HORIZON_URL \
    NEXT_PUBLIC_SOROBAN_RPC_URL=$NEXT_PUBLIC_SOROBAN_RPC_URL \
    NEXT_PUBLIC_PASSKEY_RP_ID=$NEXT_PUBLIC_PASSKEY_RP_ID \
    NEXT_PUBLIC_PASSKEY_RP_NAME=$NEXT_PUBLIC_PASSKEY_RP_NAME \
    NEXT_PUBLIC_PASSKEY_ORIGIN=$NEXT_PUBLIC_PASSKEY_ORIGIN

RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
# Minimal runtime image.  Contains only the standalone server output — no
# source code, no node_modules tree (standalone bundles its own minimal deps),
# no compiler, no npm, no build artifacts beyond what Next.js needs.

FROM node:20.19-alpine@sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448 AS runner

WORKDIR /app

# ── Non-root user ─────────────────────────────────────────────────────────────
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Runtime environment — non-secret configuration only.
# All secrets (e.g. internal API tokens) must be injected at container launch.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# ── Standalone output ─────────────────────────────────────────────────────────
# Next.js standalone mode bundles a minimal server.js and the exact node_modules
# it needs.  We copy three artifacts:
#   public/          — static assets served directly
#   .next/standalone — the self-contained server (server.js + bundled modules)
#   .next/static     — pre-built JS/CSS chunks served by the standalone server
COPY --from=builder --chown=nextjs:nodejs /build/public          ./public
COPY --from=builder --chown=nextjs:nodejs /build/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/.next/static    ./.next/static

USER nextjs

EXPOSE 3000

# ── Health check ──────────────────────────────────────────────────────────────
# Next.js does not expose a dedicated health endpoint by default.
# We probe the root path; a 200 or 3xx response from the SSR server means
# the process is running and capable of serving requests.
#
# interval: 30 s  — low noise in production logs
# timeout:  10 s  — SSR cold-start can be slow on first request
# retries:  3     — three consecutive failures → unhealthy
# start-period: 20 s — allow the Node.js process to bind and warm up
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD wget -qO- http://localhost:3000/ > /dev/null || exit 1

CMD ["node", "server.js"]
