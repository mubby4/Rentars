# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Terraform root module
#
# Models the infrastructure shared across all environments.  Environment-
# specific values are supplied via .tfvars files (staging.tfvars /
# production.tfvars) and never contain secret values.
#
# Secrets are read from the provider's native secret store at plan/apply time
# via data sources; they are never written to .tfstate in plaintext.
#
# Provider: AWS (adaptable to GCP/Azure by swapping the provider block and
# the compute/redis/cdn module implementations).
#
# State backend: S3 + DynamoDB (see backend block below).
# Update the bucket and table names to match your AWS account before first use.
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state — keeps state off local machines and enables team collaboration.
  # Replace bucket/dynamodb_table with your own names before first `terraform init`.
  backend "s3" {
    bucket         = "rentars-terraform-state"
    key            = "rentars/${var.environment}/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "rentars-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "rentars"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "github.com/your-org/Rentars"
    }
  }
}

# ── Networking ────────────────────────────────────────────────────────────────

module "networking" {
  source = "./modules/networking"

  environment         = var.environment
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  public_subnet_cidrs = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
}

# ── Redis (ElastiCache) ───────────────────────────────────────────────────────

module "redis" {
  source = "./modules/redis"

  environment        = var.environment
  subnet_ids         = module.networking.private_subnet_ids
  security_group_ids = [module.networking.redis_sg_id]
  node_type          = var.redis_node_type
  engine_version     = var.redis_engine_version
}

# ── Compute (ECS Fargate) ─────────────────────────────────────────────────────

module "compute" {
  source = "./modules/compute"

  environment         = var.environment
  aws_region          = var.aws_region
  vpc_id              = module.networking.vpc_id
  private_subnet_ids  = module.networking.private_subnet_ids
  public_subnet_ids   = module.networking.public_subnet_ids
  alb_security_group  = module.networking.alb_sg_id
  ecs_security_group  = module.networking.ecs_sg_id

  # Backend service
  backend_image       = var.backend_image
  backend_cpu         = var.backend_cpu
  backend_memory      = var.backend_memory
  backend_desired_count = var.backend_desired_count

  # Frontend service
  frontend_image      = var.frontend_image
  frontend_cpu        = var.frontend_cpu
  frontend_memory     = var.frontend_memory
  frontend_desired_count = var.frontend_desired_count

  # Redis endpoint from the redis module
  redis_endpoint      = module.redis.primary_endpoint

  # Secrets are referenced by ARN from AWS Secrets Manager.
  # The ECS task execution role must have secretsmanager:GetSecretValue
  # permission for each ARN listed here.
  secret_arns = {
    supabase_service_role_key  = var.secret_arn_supabase_service_role_key
    jwt_secret                 = var.secret_arn_jwt_secret
    trustless_work_api_key     = var.secret_arn_trustless_work_api_key
    smtp_pass                  = var.secret_arn_smtp_pass
    hcaptcha_secret_key        = var.secret_arn_hcaptcha_secret_key
    metrics_token              = var.secret_arn_metrics_token
    stellar_admin_secret       = var.secret_arn_stellar_admin_secret
  }
}

# ── CDN + WAF ─────────────────────────────────────────────────────────────────

module "cdn" {
  source = "./modules/cdn"

  environment         = var.environment
  alb_dns_name        = module.compute.alb_dns_name
  domain_name         = var.domain_name
  acm_certificate_arn = var.acm_certificate_arn

  # WAF: block SQL injection, XSS, rate-limit by IP
  waf_rate_limit_per_5m = var.waf_rate_limit_per_5m
}

# ── Monitoring ────────────────────────────────────────────────────────────────

module "monitoring" {
  source = "./modules/monitoring"

  environment     = var.environment
  alb_arn_suffix  = module.compute.alb_arn_suffix
  ecs_cluster_name = module.compute.ecs_cluster_name
  alert_email     = var.alert_email
  redis_cluster_id = module.redis.cluster_id
}
