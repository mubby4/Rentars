# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Production Terraform variable values
#
# Non-secret configuration only.  Secret ARNs are injected via
# TF_VAR_secret_arn_* environment variables in CI (never stored here).
# ─────────────────────────────────────────────────────────────────────────────

environment = "production"
aws_region  = "us-east-1"

# ── Networking ────────────────────────────────────────────────────────────────
vpc_cidr             = "10.20.0.0/16"
availability_zones   = ["us-east-1a", "us-east-1b", "us-east-1c"]
public_subnet_cidrs  = ["10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]
private_subnet_cidrs = ["10.20.11.0/24", "10.20.12.0/24", "10.20.13.0/24"]

# ── DNS / TLS ─────────────────────────────────────────────────────────────────
domain_name         = "rentars.app"
acm_certificate_arn = "arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/PROD_CERT_ID"

# ── Redis ─────────────────────────────────────────────────────────────────────
redis_node_type      = "cache.t4g.small"
redis_engine_version = "7.1"

# ── Compute ───────────────────────────────────────────────────────────────────
backend_image          = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-backend:latest"
backend_cpu            = 1024
backend_memory         = 2048
backend_desired_count  = 3

frontend_image         = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-web:latest"
frontend_cpu           = 512
frontend_memory        = 1024
frontend_desired_count = 2

# ── WAF ───────────────────────────────────────────────────────────────────────
waf_rate_limit_per_5m = 2000

# ── Monitoring ────────────────────────────────────────────────────────────────
alert_email = "oncall@rentars.app"
