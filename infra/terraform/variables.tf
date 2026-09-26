# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Terraform input variables
#
# Non-secret values come from staging.tfvars / production.tfvars (committed).
# Secret ARN references come from the secrets provider and are passed via
# TF_VAR_secret_arn_* environment variables in CI — never stored in .tfvars.
# ─────────────────────────────────────────────────────────────────────────────

# ── Global ────────────────────────────────────────────────────────────────────

variable "environment" {
  description = "Deployment environment: staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'"
  }
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

# ── Networking ────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
}

variable "availability_zones" {
  description = "List of availability zones to use"
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ)"
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (one per AZ)"
  type        = list(string)
}

# ── DNS / TLS ─────────────────────────────────────────────────────────────────

variable "domain_name" {
  description = "Primary domain name (e.g. rentars.app or staging.rentars.app)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for the CloudFront distribution (must be in us-east-1)"
  type        = string
}

# ── Redis ─────────────────────────────────────────────────────────────────────

variable "redis_node_type" {
  description = "ElastiCache Redis node type (e.g. cache.t4g.small)"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.1"
}

# ── Compute ───────────────────────────────────────────────────────────────────

variable "backend_image" {
  description = "Backend container image URI (registry/image:tag)"
  type        = string
}

variable "backend_cpu" {
  description = "Backend ECS task CPU units (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "Backend ECS task memory in MiB"
  type        = number
  default     = 1024
}

variable "backend_desired_count" {
  description = "Desired number of backend ECS tasks"
  type        = number
  default     = 2
}

variable "frontend_image" {
  description = "Frontend container image URI (registry/image:tag)"
  type        = string
}

variable "frontend_cpu" {
  description = "Frontend ECS task CPU units"
  type        = number
  default     = 256
}

variable "frontend_memory" {
  description = "Frontend ECS task memory in MiB"
  type        = number
  default     = 512
}

variable "frontend_desired_count" {
  description = "Desired number of frontend ECS tasks"
  type        = number
  default     = 2
}

# ── WAF ───────────────────────────────────────────────────────────────────────

variable "waf_rate_limit_per_5m" {
  description = "WAF: max requests per IP per 5-minute window"
  type        = number
  default     = 1000
}

# ── Monitoring ────────────────────────────────────────────────────────────────

variable "alert_email" {
  description = "Email address for CloudWatch alarm notifications"
  type        = string
}

# ── Secret ARN references ─────────────────────────────────────────────────────
# These are ARNs pointing to secrets in AWS Secrets Manager.
# Values are never committed to .tfvars — they are injected via
# TF_VAR_secret_arn_* environment variables in CI.

variable "secret_arn_supabase_service_role_key" {
  description = "Secrets Manager ARN for SUPABASE_SERVICE_ROLE_KEY"
  type        = string
  sensitive   = true
}

variable "secret_arn_jwt_secret" {
  description = "Secrets Manager ARN for JWT_SECRET"
  type        = string
  sensitive   = true
}

variable "secret_arn_trustless_work_api_key" {
  description = "Secrets Manager ARN for TRUSTLESS_WORK_API_KEY"
  type        = string
  sensitive   = true
}

variable "secret_arn_smtp_pass" {
  description = "Secrets Manager ARN for SMTP_PASS"
  type        = string
  sensitive   = true
}

variable "secret_arn_hcaptcha_secret_key" {
  description = "Secrets Manager ARN for HCAPTCHA_SECRET_KEY"
  type        = string
  sensitive   = true
}

variable "secret_arn_metrics_token" {
  description = "Secrets Manager ARN for METRICS_TOKEN"
  type        = string
  sensitive   = true
}

variable "secret_arn_stellar_admin_secret" {
  description = "Secrets Manager ARN for STELLAR_ADMIN_SECRET"
  type        = string
  sensitive   = true
}
