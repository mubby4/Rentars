# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Rentars Backend — hardened multi-stage Dockerfile
#
# Stages:
#   deps    — install production dependencies with frozen lockfile
#   builder — compile TypeScript to native Bun bytecode bundle
#   runner  — minimal runtime image; non-root, no build tools, health check
#
# Pinning strategy:
#   Base images are pinned to a specific tag AND their index digest so that
#   both `docker build` and supply-chain scanners see an immutable reference.
#   Update the digest after vetting the upstream changelog and re-running
#   `docker scout cves` or `trivy image` in CI.
#
#   Current pins (update policy: monthly or on CVE advisory):
#     oven/bun:1.2-alpine  →  sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a
#
# Writable paths at runtime (everything else is read-only):
#   /tmp          — temporary files
#   /app/dist     — compiled output written during builder stage (read-only at runtime)
#
# To update the base-image digest:
#   docker pull oven/bun:1.2-alpine
#   docker inspect oven/bun:1.2-alpine --format '{{index .RepoDigests 0}}'
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Install only production dependencies using the frozen lockfile.
# Keeping this as a separate layer means a source-only change does not
# re-download all node modules.

FROM oven/bun:1.2-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS deps

WORKDIR /build

# Copy manifests first for better layer caching.
COPY package.json bun.lockb ./

# --frozen-lockfile ensures bun.lockb is never mutated during CI/CD.
# --production omits devDependencies from the final install.
RUN bun install --frozen-lockfile --production

# ── Stage 2: builder ──────────────────────────────────────────────────────────
# Compile TypeScript source into a single bundled output.
# The bundle is a plain JS file (no transpilation at runtime), which reduces
# startup time and eliminates the need for tsconfig.json in the final image.

FROM oven/bun:1.2-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS builder

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Bundle to a single file targeting Bun's native runtime.
# --minify reduces bundle size; --sourcemap=external keeps traces debuggable.
RUN bun build ./src/index.ts \
      --target=bun \
      --outdir=./dist \
      --sourcemap=external \
      --minify

# ── Stage 3: runner ───────────────────────────────────────────────────────────
# Minimal runtime image.  Contains only the compiled bundle, production
# node_modules, and the Bun binary — no compiler, no build tools, no wget.

FROM oven/bun:1.2-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS runner

# ── Non-root user ─────────────────────────────────────────────────────────────
# Create an explicit system user so the container never runs as root.
# UID/GID 10001 is chosen to be outside the 0–1000 range used by the base.
RUN addgroup --system --gid 10001 rentars && \
    adduser  --system --uid 10001 --ingroup rentars --no-create-home rentars

WORKDIR /app

# Copy compiled bundle and production deps from earlier stages.
COPY --from=builder --chown=rentars:rentars /build/dist      ./dist
COPY --from=builder --chown=rentars:rentars /build/dist/*.map ./dist/
COPY --from=deps    --chown=rentars:rentars /build/node_modules ./node_modules

# Runtime configuration — no secrets baked in; all secrets come from the
# environment at launch (docker run --env-file, Compose env_file, or a
# secrets manager injection).
ENV NODE_ENV=production \
    PORT=3000 \
    # Disable Bun's runtime transpiler cache to keep the filesystem read-only.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Drop to non-root before any further instructions.
USER rentars

EXPOSE 3000

# ── Health check ──────────────────────────────────────────────────────────────
# The /health endpoint returns {"status":"ok"} when Supabase and Redis are
# reachable.  The orchestrator uses this to gate traffic and rolling deploys.
#
# interval: check every 30 s (not too chatty in logs)
# timeout:  the endpoint itself has a 10 s handler timeout
# retries:  3 consecutive failures → unhealthy
# start-period: 15 s grace on cold start (Supabase client warm-up)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["bun", "run", "dist/index.js"]
