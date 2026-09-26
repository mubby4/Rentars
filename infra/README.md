# Rentars — Infrastructure as Code

This directory contains the declarative infrastructure configuration for all
Rentars environments.  It is the authoritative source for environment topology,
secret references, network layout, and service configuration.

---

## Directory layout

```
infra/
├── README.md                  ← this file
├── environments/
│   ├── staging/
│   │   ├── .env.staging        ← non-secret staging env overrides (committed)
│   │   └── secrets.reference.md ← documents every secret key; values in provider
│   └── production/
│       ├── .env.production     ← non-secret production env overrides (committed)
│       └── secrets.reference.md
├── docker-compose.staging.yml  ← full staging stack (api + redis + nginx)
├── docker-compose.prod.yml     ← production stack (symlinked from apps/backend)
└── terraform/
    ├── main.tf                 ← provider config, backend state
    ├── variables.tf            ← input variable declarations
    ├── outputs.tf              ← output values (URLs, IPs, ARNs)
    ├── staging.tfvars          ← staging-specific variable values (non-secret)
    ├── production.tfvars       ← production-specific variable values (non-secret)
    └── modules/
        ├── networking/         ← VPC, subnets, security groups
        ├── compute/            ← Container service (ECS Fargate / Fly.io / GKE)
        ├── redis/              ← Managed Redis (ElastiCache / Upstash / Memorystore)
        ├── cdn/                ← CDN + WAF rules (CloudFront / Cloudflare)
        └── monitoring/         ← Alerting, log aggregation, uptime checks
```

---

## Environments

| Environment | Purpose | URL pattern | Supabase project |
|---|---|---|---|
| `local` | Developer workstation | `localhost:3000/3001` | Local Supabase CLI |
| `staging` | Pre-production validation | `staging.rentars.app` | Separate Supabase project |
| `production` | Live user traffic | `rentars.app` | Production Supabase project |

---

## Secret management

**No plaintext secret values are committed to this repository.**

All secrets (API keys, JWT secrets, database passwords, TLS certificates) are
stored in a secrets provider and referenced by name.  See each environment's
`secrets.reference.md` for the full list of required keys and the provider path
where each value lives.

Recommended providers (choose one per deployment target):
- **AWS Secrets Manager** — inject via ECS task definition `secrets:` block
- **GitHub Actions Secrets** — inject as `env:` in workflow steps
- **Fly.io Secrets** — inject via `fly secrets set KEY=VALUE`
- **Docker Secrets** (Swarm) — inject via `secrets:` in Compose v3.1+

---

## CI plan validation

Every PR that modifies `infra/terraform/**` triggers the `infra-plan` CI job
(see `.github/workflows/infra-plan.yml`).  The job runs `terraform plan` in
dry-run mode and posts a diff summary as a PR comment.

- Destructive changes (resource deletions, replacement) are highlighted in red.
- The job fails if any `destroy` or `replace` action targets a stateful resource
  (database, Redis, storage bucket).
- Plans are uploaded as CI artifacts for 30 days.

**Never apply Terraform changes directly from a local machine against staging or
production.**  All applies run via the `infra-apply` job which requires manual
approval from the `infra-approvers` team.

---

## Updating base-image digests

Base-image digest pins live in `apps/backend/Dockerfile` and `apps/web/Dockerfile`.
To update them:

```bash
# Backend
docker pull oven/bun:1.2-alpine
docker inspect oven/bun:1.2-alpine --format '{{index .RepoDigests 0}}'

# Frontend
docker pull node:20.19-alpine
docker inspect node:20.19-alpine --format '{{index .RepoDigests 0}}'
```

Update the digest comments and `@sha256:...` references in both Dockerfiles,
then open a PR.  The `image-scan` CI step will re-scan the new image before merge.

---

## Manual exceptions (managed services)

The following resources cannot be fully managed via Terraform because they are
controlled through vendor dashboards:

| Resource | Vendor | Manual steps | Tracked in |
|---|---|---|---|
| Supabase project | Supabase | Project creation, extensions, connection pooler | `environments/*/secrets.reference.md` |
| Stellar contract deployment | Stellar / Soroban | `soroban contract deploy` CLI | `apps/contracts/DEPLOY.md` |
| Trustless Work API key | Trustless Work | Dashboard key rotation | Secrets provider |
| DNS records | Cloudflare / Route 53 | Manual zone delegation | Ops Notion page |
| TLS certificates | Let's Encrypt / ACM | Auto-renewed via ACME | n/a |
