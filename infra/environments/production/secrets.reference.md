# Rentars Production — Secrets Reference

This document lists every secret required to run the production environment.
**No values appear here.** All values live in the secrets provider.

Secrets provider for production: **AWS Secrets Manager** (deployed environment)
and **GitHub Actions Secrets** (CI/CD pipeline).

---

## Access policy

Production secrets require:
- AWS IAM role `rentars-production-deploy` (MFA required for console access)
- GitHub team `infra-approvers` for CI secret management
- All access is logged to CloudTrail / GitHub audit log

---

## Required secrets

### Supabase

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `SUPABASE_URL` | `rentars/production/supabase_url` | Production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `rentars/production/supabase_service_role_key` | Service-role JWT. Rotate via Supabase dashboard → Settings → API. |

### Authentication

| Key (env var) | Secrets provider path | Description | Rotation |
|---|---|---|---|
| `JWT_SECRET` | `rentars/production/jwt_secret` | HMAC-SHA256 signing key. Min 64 chars in production. | Rolling rotation only — coordinate with on-call. Zero-downtime procedure in DR runbook §Secrets Rotation. |

### Redis

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `REDIS_URL` | `rentars/production/redis_url` | Full Redis connection URL including auth password (e.g. `redis://:password@host:6379`). |

### Stellar / Soroban

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `STELLAR_ADMIN_SECRET` | `rentars/production/stellar_admin_secret` | Ed25519 secret key. **Highest-sensitivity secret in the system.** Access requires two-person rule. |
| `PROPERTY_LISTING_CONTRACT_ID` | `rentars/production/property_listing_contract_id` | Deployed contract address (non-secret but version-controlled here). |
| `BOOKING_CONTRACT_ID` | `rentars/production/booking_contract_id` | Deployed contract address. |

### Trustless Work

| Key (env var) | Secrets provider path | Description | Rotation |
|---|---|---|---|
| `TRUSTLESS_WORK_API_KEY` | `rentars/production/trustless_work_api_key` | Production bearer token. | Rotate via vendor dashboard. Coordinate with on-call to restart API fleet simultaneously. |

### Email

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `SMTP_PASS` | `rentars/production/smtp_pass` | Production SMTP password. |

### Bot protection

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `HCAPTCHA_SECRET_KEY` | `rentars/production/hcaptcha_secret_key` | Production hCaptcha secret key. |

### Observability

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `METRICS_TOKEN` | `rentars/production/metrics_token` | Bearer token for `/metrics` scrape endpoint. |

---

## Zero-downtime JWT secret rotation procedure

1. Generate new secret: `openssl rand -hex 64`
2. Store in secrets provider under `rentars/production/jwt_secret_new`
3. Deploy a version of the API that accepts **both** old and new secrets (rolling window)
4. Wait for all old tokens to expire (max 15 minutes for access tokens)
5. Promote `jwt_secret_new` → `jwt_secret`; remove the old secret
6. Deploy final version that accepts only the new secret
7. Verify: `curl /health` returns 200; monitor auth failure metrics for 10 minutes

---

## Last rotation log

| Secret | Last rotated | Rotated by | Next rotation due |
|---|---|---|---|
| `JWT_SECRET` | — | — | 90 days or on compromise |
| `TRUSTLESS_WORK_API_KEY` | — | — | Per vendor advisory |
| `METRICS_TOKEN` | — | — | 180 days |
| `STELLAR_ADMIN_SECRET` | — | — | Per security review (two-person rule) |
| `SUPABASE_SERVICE_ROLE_KEY` | — | — | Per Supabase advisory |
