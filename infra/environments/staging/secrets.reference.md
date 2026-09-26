# Rentars Staging — Secrets Reference

This document lists every secret required to run the staging environment.
**No values appear here.** All values live in the secrets provider.

Secrets provider for staging: **GitHub Actions Secrets** (for CI) and
**AWS Secrets Manager** (for deployed environment).

---

## How to access / update a secret

### GitHub Actions (CI deployments)

```bash
# View configured secret names (not values):
gh secret list --repo your-org/Rentars --env staging

# Set or rotate a secret:
gh secret set RENTARS_STAGING_JWT_SECRET --env staging
```

### AWS Secrets Manager (deployed staging environment)

```bash
# Retrieve a secret value (requires AWS CLI + appropriate IAM role):
aws secretsmanager get-secret-value \
  --secret-id rentars/staging/jwt_secret \
  --query SecretString --output text

# Update a secret:
aws secretsmanager put-secret-value \
  --secret-id rentars/staging/jwt_secret \
  --secret-string "$(openssl rand -hex 32)"
```

---

## Required secrets

### Supabase

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `rentars/staging/supabase_service_role_key` | Service-role JWT for the staging Supabase project. Rotate via Supabase dashboard → Settings → API. |

### Authentication

| Key (env var) | Secrets provider path | Description | Rotation |
|---|---|---|---|
| `JWT_SECRET` | `rentars/staging/jwt_secret` | HMAC-SHA256 key for signing access/refresh tokens. Min 32 chars. | Generate: `openssl rand -hex 32`. Rolling rotation requires a deploy that accepts both old and new tokens. |

### Redis

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `REDIS_PASSWORD` | `rentars/staging/redis_password` | Password for the in-stack Redis instance. |

### Stellar / Soroban

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `STELLAR_ADMIN_SECRET` | `rentars/staging/stellar_admin_secret` | Ed25519 secret key for the platform Stellar account (signs admin transactions). **Never commit or log.** |

### Trustless Work

| Key (env var) | Secrets provider path | Description | Rotation |
|---|---|---|---|
| `TRUSTLESS_WORK_API_KEY` | `rentars/staging/trustless_work_api_key` | Bearer token for the Trustless Work escrow sandbox API. | Rotate via Trustless Work dashboard. Restart API container after rotation. |

### Email (SMTP)

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `SMTP_PASS` | `rentars/staging/smtp_pass` | Password for the staging SMTP account. |

### Bot protection

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `HCAPTCHA_SECRET_KEY` | `rentars/staging/hcaptcha_secret_key` | hCaptcha secret key for bot protection. Staging uses the hCaptcha sandbox key. |

### Observability

| Key (env var) | Secrets provider path | Description |
|---|---|---|
| `METRICS_TOKEN` | `rentars/staging/metrics_token` | Bearer token required to scrape `GET /metrics` from outside localhost. Generate: `openssl rand -hex 32`. |

---

## Secret rotation checklist

When rotating any secret in staging:

1. Generate the new value and store it in the secrets provider.
2. Update the GitHub Actions secret if used in CI deployments.
3. Redeploy or restart the affected service container.
4. Verify the service health check passes: `curl -sf https://staging.rentars.app/health | jq .`
5. For `JWT_SECRET` rotation: issue a notice to staging testers — existing sessions will be invalidated.
6. Record the rotation date in this document under the affected secret row.

---

## Last rotation log

| Secret | Last rotated | Rotated by | Next rotation due |
|---|---|---|---|
| `JWT_SECRET` | — | — | At deployment or 90 days |
| `TRUSTLESS_WORK_API_KEY` | — | — | Per vendor advisory |
| `METRICS_TOKEN` | — | — | 180 days |
| `REDIS_PASSWORD` | — | — | 180 days |
| `STELLAR_ADMIN_SECRET` | — | — | Per security review |
