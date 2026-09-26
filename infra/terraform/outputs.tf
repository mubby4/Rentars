# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Terraform outputs
#
# Outputs are non-sensitive infrastructure references used by:
#   - CI/CD pipelines (to resolve the ALB DNS name for smoke tests)
#   - Monitoring configuration (cluster names, ARNs)
#   - Manual operations (finding the correct Redis endpoint)
#
# Sensitive values (connection strings with passwords, etc.) are marked
# sensitive = true so Terraform redacts them from console output.
# ─────────────────────────────────────────────────────────────────────────────

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer (use for CNAME records)"
  value       = module.compute.alb_dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = module.cdn.cloudfront_domain_name
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.compute.ecs_cluster_name
}

output "ecs_backend_service_name" {
  description = "Name of the backend ECS service (for forced deployments)"
  value       = module.compute.backend_service_name
}

output "ecs_frontend_service_name" {
  description = "Name of the frontend ECS service"
  value       = module.compute.frontend_service_name
}

output "redis_primary_endpoint" {
  description = "Primary endpoint of the ElastiCache Redis cluster (host only, no auth)"
  value       = module.redis.primary_endpoint
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.networking.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (for adding new services to the VPC)"
  value       = module.networking.private_subnet_ids
}
