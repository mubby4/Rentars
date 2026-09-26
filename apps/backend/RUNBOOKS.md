# Rentars Backend — Operational Runbooks

This document covers first-response procedures for the most common production incidents.  
Each runbook follows the same structure: **Symptoms → Verify → Immediate actions → Root-cause investigation → Resolution → Prevention**.

---

## Table of Contents

1. [API Outage / Service Down](#1-api-outage--service-down)
2. [High Error Rate (5xx spike)](#2-high-error-rate-5xx-spike)
3. [Payment / Escrow Failure](#3-payment--escrow-failure)
4. [Blockchain / Stellar RPC Connection Issues](#4-blockchain--stellar-rpc-connection-issues)
5. [Authentication Failures (401/403 spike)](#5-authentication-failures-401403-spike)
6. [Database Connectivity Issues](#6-database-connectivity-issues)
7. [Rate-Limit Flood (429 spike)](#7-rate-limit-flood-429-spike)
8. [High Latency / Slow Requests](#8-high-latency--slow-requests)
9. [Frontend Error Boundary Flood](#9-frontend-error-boundary-flood)
10. [Memory or CPU Exhaustion](#10-memory-or-cpu-exhaustion)

---

## 1. API Outage / Service Down

### Symptoms
- Health check at `GET /health` returns non-200 or times out.
- Load balancer marks all instances unhealthy.
- All API clients receive connection refused or 503.

### Verify
```bash
# From within the same network / VPC
curl -sf http://localhost:3000/health | jq .

# Check process status
ps aux | grep node

# Check recent crash logs
journalctl -u rentars-api -n 100 --no-pager
# or in Docker:
docker logs rentars-api --tail 100
```

### Immediate actions
1. Restart the process: `systemctl restart rentars-api` or `docker restart rentars-api`.
2. If it crashes immediately, look for the startup error in logs — most commonly a missing env var (`env.ts` logs all failures before `process.exit(1)`).
3. If env vars are correct, check whether Supabase / Redis is reachable (see [Database runbook](#6-database-connectivity-issues)).

### Root-cause investigation
- Search structured logs for `"level":"error"` entries in the crash window.
- Look for `"message":"Fatal startup error"` or `"Blockchain configuration validation failed"`.
- Correlate with any recent deploys or config changes.

### Resolution
- Fix the root cause (missing env var, bad config, dependency outage).
- Re-deploy or restart.

### Prevention
- Add a pre-deploy smoke test: `curl /health` must return 200 before traffic is shifted.
- Keep `SUPABASE_URL`, `JWT_SECRET`, and `CORS_ORIGIN` in a secrets manager, not baked into images.

---

## 2. High Error Rate (5xx spike)

### Symptoms
- `http_errors_total{status_class="5xx"}` rising sharply on the `/metrics` dashboard.
- Alerts firing on `error_rate > 1%` threshold.

### Verify
```bash
# Query metrics endpoint (requires METRICS_TOKEN or localhost access)
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep http_errors_total

# Find the top failing routes in logs (last 15 minutes)
journalctl -u rentars-api --since "15 min ago" \
  | grep '"level":"error"' | jq -r '.path' | sort | uniq -c | sort -rn | head 10
```

### Immediate actions
1. Identify the failing route(s) from metrics labels (`method`, `route`).
2. Check if it is a single route or global.  A global spike usually means an infrastructure change (bad deploy, DB outage).
3. If a single route: look for the `requestId` in the error log entry and trace the full request.

### Root-cause investigation
- Structured error logs include `errorCode`, `errorMessage`, `requestId`, `stack` (5xx only).
- Cross-reference `requestId` in the access log to get the full HTTP context.
- Check whether the error correlates with a recent deploy, config change, or Supabase migration.

### Resolution
- Rollback the last deploy if the spike started at deploy time.
- If a DB migration caused it, apply a fix-forward migration.
- Hotfix the code if a specific handler is throwing unexpectedly.

### Prevention
- Canary deployments — shift 5% of traffic first and watch error rate before promoting.
- Add a test for the affected code path.

---

## 3. Payment / Escrow Failure

### Symptoms
- `escrow_failures_total` or `payment_failures_total` counters rising.
- Users reporting "payment failed" or bookings stuck in `pending` state.
- Alerts on `escrow_failures_total > N` in a rolling window.

### Verify
```bash
# Check escrow failure metrics
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep -E "escrow_failures_total|payment_failures_total"

# Find affected bookings in the database
# (run in Supabase SQL editor)
SELECT id, status, escrow_id, created_at
FROM bookings
WHERE status = 'pending' AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### Immediate actions
1. Check `blockchain_logs` table for `operation = 'escrow_create'` or `'escrow_release'` with non-null `error_message`.
2. Check `TRUSTLESS_WORK_API_URL` is reachable: `curl -sf $TRUSTLESS_WORK_API_URL/health`.
3. Check Stellar network status at https://dashboard.stellar.org.

### Root-cause investigation
- Search structured logs for `"errorCode":"ESCROW_FAILED"` or `"ESCROW_CREATION_FAILED"`.
- Each log entry includes `requestId` — use it to find the originating booking request in the access log.
- Check whether the Stellar account has sufficient XLM for transaction fees.
- Check whether the Trustless Work API key is valid and not expired.

### Resolution
- If Trustless Work API is down: communicate to users, retry failed bookings once the service recovers.
- If Stellar network is congested: increase transaction fee multiplier via `STELLAR_BASE_FEE` env var.
- If account is out of XLM: top up the platform Stellar account.
- Manually re-trigger escrow for stuck bookings via the admin panel or a targeted DB update + re-submission.

### Prevention
- Alert on `escrow_failures_total > 5 in 5m`.
- Implement automatic retry with exponential backoff in the escrow service.
- Monitor Stellar account balance via a scheduled job.

---

## 4. Blockchain / Stellar RPC Connection Issues

### Symptoms
- `blockchain_rpc_calls_total{outcome="failure"}` rising.
- `blockchain_rpc_duration_seconds` p99 > 10 s.
- Wallet approval requests timing out.

### Verify
```bash
# Test RPC connectivity directly
curl -sf "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":{}}' | jq .

# Check wallet approval metrics
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep wallet_approvals_total
```

### Immediate actions
1. If the configured RPC endpoint is unhealthy, switch `STELLAR_RPC_URL` to a backup endpoint (e.g. Horizon fallback) and restart.
2. Disable blockchain-dependent features with a feature flag if available.
3. Queue new escrow transactions for retry rather than failing them immediately.

### Root-cause investigation
- Check https://status.stellar.org for network-wide incidents.
- Check logs for `"blockchain_rpc"` entries with `"outcome":"failure"` and the specific RPC method.
- Correlate the `blockchainRpcDurationSeconds` histogram — sustained high latency before failures often indicates network degradation rather than a hard outage.

### Resolution
- Network outage: wait for Stellar network recovery; retry queued transactions.
- RPC provider issue: rotate to an alternative endpoint (Ankr, QuickNode, or self-hosted Stellar Core).
- Code bug: check recent changes to `src/blockchain/` and roll back if necessary.

### Prevention
- Configure at least one fallback RPC URL.
- Alert on `blockchain_rpc_calls_total{outcome="failure"} > 3 in 1m`.
- Run the Stellar node health check in `/health` endpoint (already wired in `routes/index.ts`).

---

## 5. Authentication Failures (401/403 spike)

### Symptoms
- `auth_events_total{event="login",outcome="failure"}` rising.
- `http_errors_total{status_class="4xx"}` spike concentrated on `/api/v1/auth/*`.
- Users reporting they cannot log in.

### Verify
```bash
# Check auth failure metrics
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep auth_events_total

# Check for rate-limit rejections (users may be locked out)
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep http_errors_total | grep auth
```

### Immediate actions
1. Check whether `JWT_SECRET` has changed (a rotation without a rolling deployment causes all existing tokens to become invalid immediately).
2. Check whether Supabase auth is healthy: `GET /health` → `checks.database`.
3. If users are rate-limited, check `src/middleware/rateLimiter.ts` thresholds.

### Root-cause investigation
- Structured logs at `"level":"warn"` on `/api/v1/auth/*` include `requestId`, `userId` (if known), `errorCode`.
- `securityLogger.logAuthEvent` entries in the `security_logs` table capture `login_failure` with metadata.
- A sudden spike often means either a credential-stuffing attack (check for many distinct IPs hitting auth) or a platform-wide token expiry.

### Resolution
- Credential stuffing: increase rate-limit points on `authLimiter`, consider adding CAPTCHA or geo-blocking.
- JWT secret rotation: coordinate with a rolling deploy that accepts both old and new tokens during transition.
- Supabase issue: follow the [Database runbook](#6-database-connectivity-issues).

### Prevention
- Alert on `auth_events_total{outcome="failure"} > 50 in 5m`.
- Enable hCaptcha in production (`HCAPTCHA_ENABLED=true`).
- Store JWT secret in a secrets manager; use versioned secrets for zero-downtime rotation.

---

## 6. Database Connectivity Issues

### Symptoms
- `GET /health` returns `checks.database: "error"`.
- 500 errors across all routes that touch the database.
- Logs contain `"Failed to log blockchain operation"` or Supabase client errors.

### Verify
```bash
# Health check
curl -sf http://localhost:3000/health | jq .checks

# Check Supabase status
curl -sf "$SUPABASE_URL/rest/v1/" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" | head -c 200
```

### Immediate actions
1. Check https://status.supabase.com for platform-wide incidents.
2. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct and not expired.
3. Check connection pool limits — Supabase free-tier projects have a low concurrent connection cap.

### Root-cause investigation
- All DB errors bubble up through the service layer and are structured-logged at `"level":"error"`.
- Look for `pgError` or `PGRST` codes in the log entries.
- Check whether a recent migration introduced a breaking schema change.

### Resolution
- Service outage: wait for Supabase recovery; read-only degraded mode may be possible for some endpoints.
- Connection pool exhaustion: reduce `SUPABASE_POOL_SIZE` or upgrade the Supabase plan.
- Migration rollback: run a reverse migration SQL in the Supabase SQL editor.

### Prevention
- Monitor `GET /health` on a 30-second interval; alert if `checks.database != "ok"` for > 1 minute.
- Use Supabase connection pooling (pgBouncer) for high-traffic deployments.

---

## 7. Rate-Limit Flood (429 spike)

### Symptoms
- `http_errors_total{status_class="4xx"}` spike, specifically 429 responses.
- Legitimate users complaining they are blocked.
- `rate_limit_exceeded` entries in `blockchain_logs`.

### Verify
```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep http_errors_total | grep 429
```

### Immediate actions
1. Determine whether this is an attack (many distinct users hitting the same route) or a configuration problem (limits are too tight).
2. If an attack: check upstream firewall / WAF rules; consider temporarily blocking the source IP range.
3. If misconfiguration: temporarily increase the threshold in `rateLimiter.ts`, deploy hotfix.

### Root-cause investigation
- `rateLimitStore.service.ts` records hashed identities and routes.  Query it to find which route/IP pattern is being hit.
- Structured logs include `scope`, `route`, `method` for every rate-limit rejection.

### Resolution
- Attack: block at the CDN/WAF layer; do not rely solely on application-level limiting.
- Legitimate traffic spike: raise limits in `rateLimiter.ts`; consider separating per-user vs per-IP limiting.

### Prevention
- Set up CDN-level rate limiting as the first line of defence.
- Alert on a sudden spike of 429s that doesn't coincide with a known traffic event.

---

## 8. High Latency / Slow Requests

### Symptoms
- `http_request_duration_seconds` p99 > 2 s.
- Users reporting slow page loads or booking timeouts.
- `REQUEST_TIMEOUT` errors appearing in logs.

### Verify
```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep http_request_duration_seconds_bucket | grep -v "^#"
```

### Immediate actions
1. Check which routes are slow (look at the `route` label on the histogram).
2. Check `process_heap_used_bytes` — if near `process_heap_bytes`, a GC pause may be causing latency.
3. Check whether Supabase query latency has increased.

### Root-cause investigation
- Slow routes often involve N+1 queries or missing indexes.  Check the Supabase query performance dashboard.
- `blockchain_rpc_duration_seconds` — if blockchain calls are slow, that will cascade to booking/escrow routes.
- Check whether the event loop is saturated: `process_uptime_seconds` growing faster than wall time is a warning sign.

### Resolution
- Add a missing database index (follow the migration naming convention in `database/MIGRATIONS_NAMING.md`).
- Introduce result caching in `cache.service.ts` for hot read paths.
- Increase the timeout threshold in `timeoutMiddleware` as a temporary measure while the root cause is fixed.

### Prevention
- Add p99 latency alerts: `http_request_duration_seconds{le="2"}` rate below threshold.
- Run `EXPLAIN ANALYZE` on slow queries in staging before deploying schema changes.

---

## 9. Frontend Error Boundary Flood

### Symptoms
- `client_errors_total` counter rising sharply.
- `POST /api/v1/client-errors` volume spike visible in `http_requests_total`.
- Users seeing the "Something went wrong" error page repeatedly.

### Verify
```bash
# Check client error counter
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep client_errors_total

# Find recent client error reports in blockchain_logs
# (Supabase SQL editor)
SELECT operation, input_json, error_message, created_at
FROM blockchain_logs
WHERE operation = 'client_error'
  AND created_at > NOW() - INTERVAL '30 minutes'
ORDER BY created_at DESC
LIMIT 50;
```

### Root-cause investigation
- Each client error report includes `context` (the error boundary label), `href` (page URL), `correlationId` (the backend request-ID that preceded the error).
- Use the `correlationId` to find the server-side log entry: search structured logs for `"requestId":"<id>"`.
- The `context` label identifies which part of the UI is failing (e.g. `"booking-form"`, `"global-error-boundary"`).

### Resolution
- A specific context label flooding: deploy a hotfix for that component.
- Global-error-boundary flooding: likely a shared dependency or a bad API response shape — check recent deploys and API changes.
- If caused by a backend change, roll back the backend deploy first.

### Prevention
- Alert on `client_errors_total > 20 in 5m`.
- Add error boundary tests for critical flows (booking, checkout, auth).
- Use the `correlationId` in the frontend support flow so users can provide it to support.

---

## 10. Memory or CPU Exhaustion

### Symptoms
- `process_heap_used_bytes` near or equal to `process_heap_bytes`.
- `process_cpu_user_seconds_total` growing faster than expected.
- OOM kills in container logs.
- Increasing response latency preceding a crash.

### Verify
```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics \
  | grep -E "process_heap|process_cpu|process_resident"
```

### Immediate actions
1. Restart the process to clear the immediate pressure.
2. Increase container memory limit as a temporary measure.
3. Check for a memory-leak pattern: heap growing monotonically between GC cycles.

### Root-cause investigation
- A flat heap-used line that suddenly spikes usually means a large in-memory operation (e.g. loading a full table into memory).
- A gradual heap growth over hours is a leak — look for caches without eviction, event-listener accumulation, or circular references.
- High CPU with low memory usually means an expensive computation loop — check search / analytics queries.

### Resolution
- Memory leak: identify with a heap snapshot in staging; patch and deploy.
- Large in-memory operation: paginate the query; use streaming.
- CPU loop: add pagination or background job offloading.

### Prevention
- Set container memory limits 20% above baseline usage so OOM kills trigger alerts before the process becomes unusable.
- Alert when `process_heap_used_bytes / process_heap_bytes > 0.85` for > 5 minutes.
- Schedule periodic heap profiling in staging after each significant feature release.

---

## Alerting Thresholds Reference

| Metric | Alert condition | Severity |
|---|---|---|
| `http_errors_total{status_class="5xx"}` | rate > 1% of total requests over 5 min | Critical |
| `http_errors_total{status_class="4xx"}` | rate > 10% of total requests over 5 min | Warning |
| `http_request_duration_seconds` p99 | > 2 s over 5 min | Warning |
| `http_request_duration_seconds` p99 | > 5 s over 5 min | Critical |
| `escrow_failures_total` | > 5 in 5 min | Critical |
| `payment_failures_total` | > 3 in 5 min | Critical |
| `blockchain_rpc_calls_total{outcome="failure"}` | > 3 in 1 min | Critical |
| `wallet_approvals_total{outcome="error"}` | > 5 in 5 min | Warning |
| `auth_events_total{outcome="failure"}` | > 50 in 5 min | Warning |
| `client_errors_total` | > 20 in 5 min | Warning |
| `process_heap_used_bytes / process_heap_bytes` | > 0.85 for 5 min | Warning |
| `/health` non-200 | any occurrence | Critical |

---

## Log Query Recipes

All structured log entries are JSON objects. Use these patterns against your log aggregator (Loki, CloudWatch Insights, Splunk, etc.).

```
# Find all 5xx errors in the last hour
{ level="error" } | json | status >= 500

# Trace a specific request end-to-end
{ requestId="<id>" }

# Find all errors for a specific user
{ userId="<user-id>", level=~"error|warn" }

# Find all escrow failures
{ message=~"escrow" } | json | errorCode =~ "ESCROW.*"

# Find slow requests (> 1 s)
{ level="info" } | json | durationMs > 1000

# Find all CORS rejections
{ message="CORS rejected origin" }
```

---

## On-Call Contacts

| Role | Contact |
|---|---|
| Platform on-call | See PagerDuty rotation |
| Supabase support | https://supabase.com/support |
| Stellar status | https://status.stellar.org |
| Trustless Work | https://docs.trustlesswork.com |

---

# Disaster Recovery Runbook

This section covers coordinated recovery from outage scenarios that require
decisions across multiple services, not just a single container restart.

---

## DR Table of Contents

- [DR-0  RTO / RPO Targets and Service Priorities](#dr-0--rto--rpo-targets-and-service-priorities)
- [DR-1  Role Assignments](#dr-1--role-assignments)
- [DR-2  Supabase / Database Recovery](#dr-2--supabase--database-recovery)
- [DR-3  Redis Recovery](#dr-3--redis-recovery)
- [DR-4  Stellar Contract and Key Recovery](#dr-4--stellar-contract-and-key-recovery)
- [DR-5  Trustless Work / Escrow Recovery](#dr-5--trustless-work--escrow-recovery)
- [DR-6  Object Storage (Supabase Storage) Recovery](#dr-6--object-storage-supabase-storage-recovery)
- [DR-7  Secrets Rotation (Zero-Downtime)](#dr-7--secrets-rotation-zero-downtime)
- [DR-8  Full-Stack Recovery Sequence](#dr-8--full-stack-recovery-sequence)
- [DR-9  Communication Templates](#dr-9--communication-templates)
- [DR-10 Tabletop Exercise Checklist](#dr-10-tabletop-exercise-checklist)
- [DR-11 Non-Production Restore and Dependency Failover Drill](#dr-11-non-production-restore-and-dependency-failover-drill)
- [DR-12 Drill Retrospective Template](#dr-12-drill-retrospective-template)

---

## DR-0  RTO / RPO Targets and Service Priorities

### Recovery targets

| Service tier | Description | RTO (max downtime) | RPO (max data loss) |
|---|---|---|---|
| **P0 — Core read** | Property search, listing view, public pages | 30 minutes | 0 (read-only; no write loss) |
| **P1 — Booking** | Booking creation, availability check, booking status | 1 hour | 15 minutes |
| **P2 — Payment / Escrow** | Escrow creation, funding, release | 2 hours | 0 (financial records) |
| **P3 — Reconciliation** | Blockchain sync, escrow reconciliation | 4 hours | 1 hour |
| **P4 — Non-critical** | Notifications, analytics, search history, reminders | 24 hours | 24 hours |

### Service dependency map

```
User → CDN/WAF → nginx → web (Next.js)
                       → api (Bun/Express)
                              ├── Supabase (PostgreSQL) ← P0 dependency
                              ├── Redis                 ← P1 dependency (degrades gracefully)
                              ├── Stellar RPC           ← P2 dependency
                              ├── Trustless Work API    ← P2 dependency
                              └── SMTP                  ← P4 dependency
```

### Degraded-mode behavior

| Dependency down | Impact | Degraded behavior |
|---|---|---|
| Redis | Rate limiting falls back to in-memory; sessions still work | **Continue operating** — log the fallback |
| Stellar RPC | New bookings / escrow creation fail | **Block new bookings**; existing data readable |
| Trustless Work API | Escrow operations fail | **Block new bookings**; reconcile on recovery |
| SMTP | Email delivery fails | **Queue / retry**; in-app notifications still work |
| Supabase | All DB operations fail | **Full outage** — invoke DR-2 immediately |

---

## DR-1  Role Assignments

Assign these roles before starting any DR procedure.

| Role | Responsibilities | Default assignee |
|---|---|---|
| **Incident Commander (IC)** | Owns the incident timeline; makes go/no-go decisions; posts updates | On-call lead |
| **Database Owner** | Executes Supabase restore, migration verification, RLS validation | Backend lead |
| **Infrastructure Owner** | Manages container restarts, Terraform applies, DNS failover | DevOps / infra lead |
| **Blockchain Owner** | Manages Stellar account, contract verification, escrow reconciliation | Blockchain lead |
| **Communications Lead** | Posts status updates; handles external communications | Product / support lead |
| **Scribe** | Records every action and timestamp in the incident doc | Rotating |

**If roles cannot be filled:** IC doubles as Infrastructure Owner; Database Owner doubles as Blockchain Owner.

---

## DR-2  Supabase / Database Recovery

### Backup sources

| Source | Retention | How to access |
|---|---|---|
| Supabase daily automatic backup | 7 days (Pro), 30 days (Team/Enterprise) | Supabase Dashboard → Settings → Backups |
| Supabase PITR (Point-In-Time Recovery) | Configurable (requires Pro+) | Supabase Dashboard → Settings → Backups → PITR |
| Manual pg_dump (recommended before migrations) | Keep last 5; rotate manually | See procedure below |

### Pre-migration manual backup

```bash
# Run before any migration against staging or production
pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  "$DATABASE_URL" \
  > "backup-$(date +%Y%m%d-%H%M%S).dump"

# Verify the dump is readable
pg_restore --list backup-*.dump | head -20
```

### Restore from Supabase backup (managed restore)

1. Navigate to: Supabase Dashboard → Project → Settings → Backups
2. Select the backup timestamp closest to (but before) the incident
3. Click **Restore** — this triggers a full restore on the Supabase infrastructure side
4. Supabase will provision a new database and redirect the project URL automatically
5. After restore completes, verify the API health check: `curl -sf $API_URL/health | jq .`
6. Run the migration validator to confirm schema consistency:
   ```bash
   cd apps/backend && bun run validate:migrations
   ```
7. Spot-check critical tables:
   ```sql
   SELECT COUNT(*) FROM bookings WHERE status IN ('Confirmed', 'Pending');
   SELECT COUNT(*) FROM payments WHERE status = 'confirmed';
   SELECT MAX(created_at) FROM audit_logs;
   ```

### Restore from manual pg_dump

```bash
# Create a fresh Supabase project (if original is unrecoverable)
# Then restore:
pg_restore \
  --format=custom \
  --no-acl \
  --no-owner \
  --dbname="$NEW_DATABASE_URL" \
  backup-YYYYMMDD-HHMMSS.dump

# Re-apply any migrations that ran after the backup timestamp
# (check migration files by created_at vs backup timestamp)
psql "$NEW_DATABASE_URL" -f apps/backend/database/setup.sql
```

### Post-restore verification checklist

```
[ ] GET /health returns {"status":"ok","checks":{"database":"ok"}}
[ ] bun run validate:migrations exits 0
[ ] SELECT COUNT(*) FROM users > 0
[ ] SELECT COUNT(*) FROM bookings WHERE status='Confirmed' matches expected
[ ] SELECT COUNT(*) FROM payments WHERE status='confirmed' matches expected
[ ] RLS: anon user cannot read other users' bookings (test via Supabase SQL editor)
[ ] Blockchain sync: run syncAllProperties() + syncAllBookings() manually and verify 0 failures
[ ] Data retention dry-run shows expected eligible counts (not 0 across all classes)
```

---

## DR-3  Redis Recovery

Redis is used for: rate limiting, session caching, exchange rate caching, and idempotency key fast-path.

**The API degrades gracefully when Redis is unavailable** — rate limiting falls back to in-memory and all other Redis-cached data is re-fetched from Supabase on next request.  **Redis data loss does not cause booking or payment data loss.**

### Recovery steps

1. Restart the Redis container / managed Redis instance:
   ```bash
   # Docker Compose
   docker compose -f infra/docker-compose.staging.yml restart redis

   # ECS (production)
   aws ecs update-service \
     --cluster rentars-production \
     --service rentars-redis \
     --force-new-deployment
   ```
2. Verify Redis is accepting connections:
   ```bash
   redis-cli -u "$REDIS_URL" ping
   # Expected: PONG
   ```
3. Restart the API to re-warm the exchange rate cache and reconnect the rate-limiter:
   ```bash
   docker compose -f infra/docker-compose.staging.yml restart api
   # or for ECS:
   aws ecs update-service --cluster rentars-production --service rentars-api --force-new-deployment
   ```
4. Verify health check passes: `curl -sf $API_URL/health | jq .checks.cache`

### Redis persistence configuration

For staging and production Redis, the following persistence settings are recommended to reduce data loss on restart:

```
# redis.conf (or Compose command flags)
save 60 1        # persist if at least 1 key changed in the last 60 s
appendonly yes   # AOF persistence for durability
appendfsync everysec
```

These are already configured in `infra/docker-compose.staging.yml`.  For managed Redis (ElastiCache), enable automatic backups with a 1-day retention window.

---

## DR-4  Stellar Contract and Key Recovery

### Contract address mapping

The contract addresses are **not secrets** and should be stored in:
1. `infra/environments/production/secrets.reference.md` (documented)
2. AWS Secrets Manager under `rentars/production/property_listing_contract_id` and `rentars/production/booking_contract_id`
3. A separate off-system record (team password manager / offline document)

**Losing the contract addresses means losing the ability to interact with on-chain data** — they cannot be recovered from the Stellar network without the addresses.

### Contract state recovery

Stellar Soroban contracts use a **state-expiration model**: persistent storage entries expire if not refreshed within their TTL window.  Current TTL values are `TTL_EXTEND_TO = 100 ledgers` (~8 minutes on testnet — **not suitable for production**).

**Before going to mainnet**, update `TTL_EXTEND_TO` in all contracts to at least `17,280 ledgers` (~1 day) per the recommendation in `apps/contracts/CONTRACT_OVERVIEW.md`.

### If a contract entry has expired

```bash
# Restore an expired contract entry using the Stellar CLI
stellar contract restore \
  --id $PROPERTY_LISTING_CONTRACT_ID \
  --source $STELLAR_ADMIN_SECRET \
  --network mainnet

stellar contract restore \
  --id $BOOKING_CONTRACT_ID \
  --source $STELLAR_ADMIN_SECRET \
  --network mainnet
```

### If the admin keypair is lost or compromised

**This is the highest-severity scenario.** The Stellar admin keypair (`STELLAR_ADMIN_SECRET`) is required to:
- Call admin-only contract entry points (`update_status`, `set_escrow_id`)
- Sign transactions for escrow operations

Recovery steps if the key is compromised:
1. **Immediately freeze** all new booking and escrow operations by setting `BLOCKCHAIN_FEATURES_ENABLED=false` and redeploying the API
2. Contact Trustless Work to place a hold on any open escrows associated with the compromised account
3. Generate a new Stellar keypair: `stellar keys generate --network mainnet`
4. If the contracts were designed with an admin-rotation entry point, call it with the old key before revoking
5. If no rotation entry point exists: **contracts must be redeployed** — follow the contract redeployment procedure below
6. Update `STELLAR_ADMIN_SECRET` in the secrets provider and redeploy the API
7. Audit `blockchain_logs` for any unauthorized operations between compromise and freeze

### Contract redeployment procedure

> **Warning:** Redeploying contracts changes their addresses.  All existing on-chain booking and property records become inaccessible at the old address.  Only redeploy when the old contract is unrecoverable.

```bash
cd apps/contracts

# Build all contracts
cargo build --target wasm32-unknown-unknown --release

# Deploy property-listing contract
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/property_listing.wasm \
  --source $STELLAR_ADMIN_SECRET \
  --network mainnet
# → Note the new contract ID: PROPERTY_LISTING_CONTRACT_ID_NEW

# Deploy booking contract (requires property-listing contract ID)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/booking.wasm \
  --source $STELLAR_ADMIN_SECRET \
  --network mainnet
# → Note the new contract ID: BOOKING_CONTRACT_ID_NEW

# Initialize booking contract with new property-listing ID
stellar contract invoke \
  --id $BOOKING_CONTRACT_ID_NEW \
  --source $STELLAR_ADMIN_SECRET \
  --network mainnet \
  -- initialize \
  --admin $STELLAR_ADMIN_ADDRESS \
  --property_listing_contract_id $PROPERTY_LISTING_CONTRACT_ID_NEW

# Update secrets provider with new contract IDs
aws secretsmanager put-secret-value \
  --secret-id rentars/production/property_listing_contract_id \
  --secret-string "$PROPERTY_LISTING_CONTRACT_ID_NEW"

aws secretsmanager put-secret-value \
  --secret-id rentars/production/booking_contract_id \
  --secret-string "$BOOKING_CONTRACT_ID_NEW"

# Redeploy API with new contract IDs
# (triggers new ECS task deployment with updated env vars)
```

Post-redeployment: run `syncAllProperties()` and `syncAllBookings()` to rebuild the off-chain DB state from the new on-chain data.

---

## DR-5  Trustless Work / Escrow Recovery

### Symptoms requiring this runbook

- `escrow_failures_total` metric spiking
- Bookings stuck in `Pending` status with no escrow_id
- Trustless Work API returning non-200

### Verify Trustless Work status

```bash
curl -sf "$TRUSTLESS_WORK_API_URL/health"
# Check https://status.trustlesswork.com for platform incidents
```

### Recovery for bookings stuck in Pending (escrow not created)

```sql
-- Find bookings pending escrow creation (older than 30 minutes)
SELECT id, tenant_id, property_id, total_price, created_at
FROM bookings
WHERE status = 'Pending'
  AND escrow_id IS NULL
  AND created_at < NOW() - INTERVAL '30 minutes'
ORDER BY created_at ASC;
```

For each stuck booking:
1. Verify the booking is still valid (tenant hasn't cancelled, property still available)
2. Manually re-trigger escrow creation via the admin panel or the reconciliation service
3. If Trustless Work API is fully down: hold the booking in `Pending` and notify the tenant; do not cancel
4. Once the API recovers, the scheduled escrow reconciliation job (runs every 5 minutes) will pick up pending bookings automatically

### Recovery for open escrows on platform restart

The escrow reconciliation job (`reconcileAllPendingEscrows`) runs every 5 minutes.  On restart, it will automatically:
- Detect escrows in `funded` state and update booking status to `Confirmed`
- Detect expired escrows and mark them as `failed`
- Log all outcomes to `blockchain_logs`

Monitor its output after restart:
```bash
docker logs rentars-api --tail 50 | grep '\[reconcile\]'
```

---

## DR-6  Object Storage (Supabase Storage) Recovery

Property images and upload evidence are stored in Supabase Storage (S3-backed).

### Backup strategy

Supabase Storage is backed by S3.  For production:
1. Enable S3 versioning on the underlying bucket (Supabase handles this for managed projects)
2. Configure a lifecycle rule to archive versions older than 90 days to Glacier
3. Maintain a secondary copy in a separate AWS region using S3 Cross-Region Replication (CRR)

### Recovery steps

If uploaded images are inaccessible:
1. Check Supabase Storage dashboard for bucket health
2. Check https://status.supabase.com for storage-specific incidents
3. If the Supabase project itself is unrecoverable, restore from the S3 bucket directly and re-point the `SUPABASE_URL` to a new project after re-uploading objects

### Evidence files

Dispute evidence files are legally sensitive.  Treat them as P2 data:
- Never deleted by the automated retention jobs (legal holds apply)
- Backed up separately from general property images
- Document the S3 bucket ARN and access policy in `infra/environments/production/secrets.reference.md`

---

## DR-7  Secrets Rotation (Zero-Downtime)

### JWT_SECRET rotation

The access token lifetime is 15 minutes.  A hard rotation invalidates all active sessions immediately.  Use this rolling procedure to avoid a user-visible outage:

**Phase 1 — Dual-accept (deploy first)**
1. Add a new env var `JWT_SECRET_PREVIOUS` with the current secret value
2. Update the auth middleware to verify tokens signed with *either* `JWT_SECRET` or `JWT_SECRET_PREVIOUS`
3. Deploy this version

**Phase 2 — Rotate**
1. Generate a new secret: `openssl rand -hex 64`
2. Update `JWT_SECRET` in the secrets provider to the new value
3. Redeploy (the middleware now accepts old tokens for 15 minutes while they expire)

**Phase 3 — Clean up (after 20 minutes)**
1. Remove `JWT_SECRET_PREVIOUS` from the secrets provider
2. Deploy the final version that only checks `JWT_SECRET`

**Total user impact:** zero (users with valid sessions stay logged in throughout).

### TRUSTLESS_WORK_API_KEY rotation

1. Generate a new API key in the Trustless Work dashboard
2. Store the new key under `rentars/production/trustless_work_api_key_new` in Secrets Manager
3. Update the API to read from the new key (requires a config change or new env var name)
4. Redeploy all API instances simultaneously (a rolling deploy risks mixed key usage — use `--force-new-deployment` for ECS)
5. Verify escrow creation succeeds: check `blockchain_logs` for `escrow_create` operations
6. Delete the old key from Trustless Work dashboard and remove the old secret from Secrets Manager

### STELLAR_ADMIN_SECRET rotation

This is the highest-risk rotation.  Follow the two-person rule: two engineers must be present.

1. Generate a new Stellar keypair: `stellar keys generate --network mainnet`
2. Fund the new account with XLM for transaction fees
3. If contracts support admin rotation: call the rotation entry point with the old key before revoking
4. Update `STELLAR_ADMIN_SECRET` in Secrets Manager
5. Redeploy the API
6. Verify: run a read-only blockchain operation (e.g. `getListingCount`) to confirm connectivity
7. Monitor `blockchain_rpc_calls_total{outcome="failure"}` for 10 minutes
8. Revoke / archive the old keypair documentation

### SUPABASE_SERVICE_ROLE_KEY rotation

1. Generate a new service role key in Supabase Dashboard → Settings → API → Service Role → Rotate
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Secrets Manager
3. Redeploy API (this causes a brief connection interruption — plan for a maintenance window or rolling deploy)
4. Verify: `GET /health` returns `{"checks":{"database":"ok"}}`

---

## DR-8  Full-Stack Recovery Sequence

Use this ordered checklist when multiple services fail simultaneously (e.g. full infrastructure loss or major cloud-provider incident).

```
PRE-RECOVERY
[ ] Assign IC, Database Owner, Infrastructure Owner, Blockchain Owner, Communications Lead, Scribe
[ ] Open a shared incident document (e.g. Google Doc, Notion page) — Scribe records every action
[ ] Post initial "investigating" status update (see DR-9)
[ ] Determine blast radius: which services are confirmed down?

P0 — RESTORE READ CAPABILITY (target: 30 min)
[ ] 1. Verify Supabase project health (supabase.com/dashboard or status.supabase.com)
[ ] 2. If DB is up: restart API containers and verify GET /health passes
[ ] 3. If DB is down: initiate Supabase restore (DR-2); update status to "investigating database"
[ ] 4. Restart frontend containers; verify home page loads
[ ] 5. Confirm: property search and listing detail pages work for a logged-out user

P1 — RESTORE BOOKING CAPABILITY (target: 1 hr)
[ ] 6. Verify Redis is healthy (redis-cli ping); restart if not (DR-3)
[ ] 7. Verify authentication: POST /api/v1/auth/login with a test account
[ ] 8. Verify availability check: GET /api/v1/properties/:id/availability
[ ] 9. Confirm: a test booking can be initiated (status reaches 'Pending')

P2 — RESTORE PAYMENT / ESCROW CAPABILITY (target: 2 hr)
[ ] 10. Verify Stellar RPC: curl -sf $STELLAR_RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":{}}'
[ ] 11. Verify Trustless Work API: curl -sf $TRUSTLESS_WORK_API_URL/health
[ ] 12. If either is down: follow DR-4 or DR-5; enable BLOCKCHAIN_FEATURES_ENABLED=false temporarily
[ ] 13. If both are up: verify escrow creation succeeds for a test booking
[ ] 14. Check blockchain_logs for any failed escrow operations from the outage window
[ ] 15. Run reconciliation manually: trigger reconcileAllPendingEscrows() via admin endpoint

P3 — RESTORE RECONCILIATION (target: 4 hr)
[ ] 16. Verify blockchain sync is running: docker logs rentars-api | grep '[sync]'
[ ] 17. Run syncAllProperties() + syncAllBookings() manually and check for 0 failures
[ ] 18. Audit sync_log table for failed syncs during the outage window and re-queue

P4 — RESTORE NON-CRITICAL SERVICES (target: 24 hr)
[ ] 19. Verify notification delivery: trigger a test notification and confirm in-app receipt
[ ] 20. Verify email delivery: send a test transactional email via /api/v1/auth/forgot-password
[ ] 21. Verify search analytics are recording: run a search and check search_analytics table
[ ] 22. Confirm booking reminders scheduler is running: grep '[retention]' in logs

POST-RECOVERY
[ ] 23. Post "resolved" status update (see DR-9)
[ ] 24. Schedule retrospective within 48 hours (see DR-12)
[ ] 25. File follow-up issues for every gap discovered during recovery
[ ] 26. Update this runbook with corrections discovered during the incident
```

---

## DR-9  Communication Templates

### Internal — Incident declared

```
🔴 INCIDENT DECLARED — [SEVERITY: P0/P1/P2]
Time: [HH:MM UTC]
IC: [Name]
Affected services: [list]
Current status: Investigating

Next update in: 15 minutes
Incident doc: [link]
```

### External — Status page update (initial)

```
We are investigating an issue affecting [service description].
Our team is actively working to restore service.
We will post an update within 30 minutes.

Started: [HH:MM UTC]
```

### External — Status page update (progress)

```
Update [N] — [HH:MM UTC]
We have identified the root cause: [brief description].
[Service X] has been restored. We are continuing to work on [service Y].
Estimated resolution: [time or "unknown"].
```

### External — Status page update (resolved)

```
✅ RESOLVED — [HH:MM UTC]
[Service name] has been fully restored.
All systems are operating normally.

Duration: [X hours Y minutes]
Root cause: [1–2 sentences]
We will publish a full post-mortem within 72 hours.
```

### Tenant / host direct communication (booking affected)

```
Subject: Update on your booking [booking ID]

Hi [name],

We experienced a technical issue that may have affected your booking.
Your booking [ID] is [current status] and your funds are [safe/being reconciled].

We expect to have full confirmation within [X hours].
No action is required from you at this time.

If you have questions, reply to this email or contact support at support@rentars.app.

— The Rentars Team
```

---

## DR-10  Tabletop Exercise Checklist

Run this exercise quarterly (or after a major architecture change) with all role holders present.

**Format:** 90-minute session; facilitator presents scenario; team walks through the response step-by-step without touching production.

### Scenario library

| # | Scenario | Services affected |
|---|---|---|
| A | Supabase project deleted (simulate with staging) | Database, all API routes |
| B | STELLAR_ADMIN_SECRET leaked to a public repo | Blockchain, escrow operations |
| C | Trustless Work API down for 4 hours | Escrow creation and release |
| D | Redis cluster OOM crash | Rate limiting, caching |
| E | Malicious migration deployed to production | Database, all API routes |
| F | Container registry unavailable (cannot pull new images) | Deployments only |

### Exercise checklist (per scenario)

```
PREPARATION (15 min before)
[ ] All role holders confirmed present
[ ] Incident doc template open
[ ] Staging environment accessible (not production — never run drills on prod)
[ ] Monitoring dashboards open in read-only mode

DURING THE EXERCISE
[ ] IC opens incident and assigns roles (max 2 min)
[ ] Communications Lead posts mock "investigating" update
[ ] Scribe begins recording every action and timestamp
[ ] Each role holder walks through their section of the recovery runbook
[ ] For database scenarios: actually run the restore against staging (DR-11)
[ ] For blockchain scenarios: verify contract addresses are accessible off-system
[ ] Identify gaps: any step where the team is unsure or the runbook is unclear

DEBRIEF (20 min)
[ ] What went well?
[ ] What was unclear or missing from the runbook?
[ ] Were all role holders reachable?
[ ] Were all secrets / recovery credentials accessible without the primary system?
[ ] File one GitHub issue per gap discovered; assign owner and due date
[ ] Update this runbook before the next exercise
```

---

## DR-11  Non-Production Restore and Dependency Failover Drill

**Purpose:** Validate that backups are usable and the recovery sequence works end-to-end before a real incident forces you to find out.

**Frequency:** Conduct once per quarter on the staging environment.

### Part A — Database restore drill

```bash
# 1. Take a manual backup of the current staging DB
pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  "$STAGING_DATABASE_URL" \
  > "drill-backup-$(date +%Y%m%d).dump"

# 2. Verify the dump
pg_restore --list "drill-backup-$(date +%Y%m%d).dump" | wc -l
# Expect: > 100 table/sequence entries

# 3. Restore to a temporary DB (use a Supabase branch or a separate project)
pg_restore \
  --format=custom \
  --no-acl \
  --no-owner \
  --dbname="$STAGING_RESTORE_TEST_URL" \
  "drill-backup-$(date +%Y%m%d).dump"

# 4. Run the API against the restored DB
SUPABASE_URL=$STAGING_RESTORE_TEST_URL \
SUPABASE_SERVICE_ROLE_KEY=$STAGING_SERVICE_ROLE_KEY \
  bun run src/index.ts &

# 5. Verify core read path
curl -sf http://localhost:3000/health | jq .
# Expected: {"status":"ok","checks":{"database":"ok"}}

# 6. Verify booking read
curl -sf "http://localhost:3000/api/v1/properties?limit=5" | jq '.data | length'
# Expected: > 0

# 7. Tear down
kill %1
```

**Pass criteria:** API health check passes against the restored database within 30 minutes of starting the drill.

### Part B — Redis failover drill

```bash
# 1. Stop Redis
docker compose -f infra/docker-compose.staging.yml stop redis

# 2. Verify the API still serves requests (degraded mode)
curl -sf http://staging.rentars.app/health | jq .
# Expected: status ok, cache check may show "degraded" or "unavailable"
# Expected: Property search still returns results (DB-backed, not Redis)

# 3. Make a booking request — verify it fails gracefully with a 503 (not a crash)
# (booking creation requires rate limiting which uses Redis)

# 4. Restore Redis
docker compose -f infra/docker-compose.staging.yml start redis

# 5. Verify recovery
sleep 10
curl -sf http://staging.rentars.app/health | jq .checks.cache
# Expected: "ok"
```

**Pass criteria:** API returns valid (possibly degraded) responses during Redis outage; full recovery within 60 seconds of Redis restart.

### Part C — Stellar RPC failover drill

```bash
# 1. Point STELLAR_RPC_URL at a non-existent endpoint
docker compose -f infra/docker-compose.staging.yml \
  -e STELLAR_RPC_URL=https://invalid.example.com \
  restart api

# 2. Attempt a booking creation — should fail with a clear error (not a 500 crash)
# Check logs for structured error message

# 3. Verify property search and booking reads still work (no blockchain dependency)

# 4. Restore the correct RPC URL and restart
docker compose -f infra/docker-compose.staging.yml restart api

# 5. Verify blockchain sync resumes
sleep 30
docker logs rentars-staging-api-1 --tail 20 | grep '\[sync\]'
```

**Pass criteria:** API handles Stellar RPC unavailability without crashing; core read operations unaffected; sync resumes automatically on recovery.

### Drill result record

| Date | Drill type | Passed | Time to recovery | Lead | Issues filed |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

---

## DR-12  Drill Retrospective Template

Complete this document within 48 hours of any drill or real incident.

```markdown
# Incident / Drill Retrospective

**Date:** YYYY-MM-DD
**Type:** [ ] Drill  [ ] Real incident
**Severity:** P0 / P1 / P2 / P3 / P4
**Duration:** X hours Y minutes (from declaration to resolution)
**IC:** [Name]

---

## Timeline

| Time (UTC) | Event | Actor |
|---|---|---|
| HH:MM | Incident declared | IC |
| HH:MM | [action taken] | [role] |
| HH:MM | [milestone reached] | [role] |
| HH:MM | Resolved | IC |

---

## What went well

- [item]
- [item]

---

## What didn't go well

- [item]
- [item]

---

## Root cause

[1–3 paragraphs describing the underlying cause, not just the symptom]

---

## Contributing factors

- [factor]
- [factor]

---

## Action items

| Issue | Owner | Due date | Status |
|---|---|---|---|
| [description] | [name] | YYYY-MM-DD | Open |

---

## Runbook gaps identified

> List every point during the recovery where the runbook was unclear, missing a step,
> or pointed to the wrong procedure.  Update RUNBOOKS.md before closing this doc.

- [ ] [gap description] → [proposed fix] → [PR link once fixed]

---

## Metrics

| Metric | Target | Actual |
|---|---|---|
| Time to first status update | < 10 min | |
| Time to P0 recovery | < 30 min | |
| Time to P1 recovery | < 60 min | |
| Time to P2 recovery | < 120 min | |
| Follow-up issues filed | ≥ 1 per gap | |
| Retrospective held within 48 h | Yes | |
```
